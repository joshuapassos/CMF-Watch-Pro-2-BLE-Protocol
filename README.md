# CMF Watch Pro 2 — BLE Protocol (reverse-engineered)

> **Unofficial.** This document describes the Bluetooth Low Energy (BLE) protocol of the
> **CMF Watch Pro 2** (CMF by Nothing), reconstructed by reverse engineering for an alternative
> companion app. It is not affiliated with or endorsed by Nothing/CMF. Field meanings marked
> *[uncertain]* were inferred from packet captures and may be wrong. Use at your own risk.

All multi-byte integers in the **frame header and opcodes are big-endian**. Integers **inside
command payloads** are little-endian unless stated otherwise (this mirrors the device firmware).

---

## 1. GATT layout

The phone is the GATT client; the watch is the peripheral, advertising as `CMF Watch Pro 2`.

| Purpose | Service | Characteristic | Properties |
|---|---|---|---|
| Command **write** | `0000fff0-0000-1000-8000-00805f9b34fb` | `0000fff2-…` | Write |
| Command **notify** | `0000fff0-…` | `0000fff1-…` | Notify |
| Shell **write** (AT) | — | `77d4ff01-2fe2-2334-0d35-9ccd078f529c` | Write |
| Shell **notify** (AT) | — | `77d4ff02-…` | Notify |
| Bulk **data write** | — | `02f00000-0000-0000-0000-00000000ffe1` | Write |
| Bulk **data notify** | — | `02f00000-…ffe2` | Notify |

Enable notifications by writing `01 00` to each CCCD (`00002902-…`). The **command channel**
(`fff1`/`fff2`) carries the framed protocol below. The **shell channel** (`77d4…`) carries plain
AT-style text (e.g. `AT GETSECRET`). The **data channel** (`02f0…`) carries large binary blobs
(watchface, firmware, AGPS), coordinated by control opcodes on the command channel.

---

## 2. Frame format (`0xF5`)

Every command-channel message is wrapped in one or more 11-byte-header frames:

```
+------+-----------+--------+-------------+-------------+--------+-------------------+
| 0xF5 | chunkLen  | cmd1   | chunkCount  | chunkIndex  | cmd2   | chunk bytes …     |
| 1 B  | 2 B (BE)  | 2 B BE | 2 B BE      | 2 B BE      | 2 B BE | chunkLen bytes    |
+------+-----------+--------+-------------+-------------+--------+-------------------+
        \__________________________ 11-byte header ____________________________/
```

- `cmd1`/`cmd2` together form the **opcode** (see §6).
- `chunkCount` = total chunks for this command; `chunkIndex` is **1-based**.
- `chunkLen` = number of bytes of `chunk` in this frame.
- A single BLE write may be fragmented by the link MTU; the receiver buffers raw bytes and
  re-extracts complete frames. Large payloads are split into multiple chunks (same `cmd1/cmd2`,
  increasing `chunkIndex`) and reassembled in order.

### Chunk body

For each chunk, the body is `payloadPiece ‖ CRC32_LE(payloadPiece)` (4-byte CRC, little-endian,
zlib/IEEE). If the command is **encrypted** (see §4), the whole `payloadPiece ‖ CRC` is then
AES-128-CBC/PKCS7 encrypted and that ciphertext becomes the frame `chunk`.

**Plaintext quirk:** for plaintext opcodes the watch *counts* the 4-byte CRC in `chunkLen` but does
**not** transmit it. So when decoding a plaintext frame, the actual data length is `chunkLen − 4`.
(Encrypted frames carry the CRC inside the ciphertext as normal.)

Chunk sizing (so encrypted chunks land on AES block boundaries), with `maxWrite = mtu − 3`:
- encrypted: `floor((maxWrite − 11) / 16) * 16 − 4 − 1`
- plaintext: `maxWrite − 11 − 4 − 2`

---

## 3. Cryptographic primitives

- **AES-128-CBC** with **PKCS7** padding and a **fixed IV** (from firmware
  `CmfCharacteristic.AES_IV`):
  `50 51 52 53 54 55 56 57 60 61 62 63 64 65 66 5A`.
- **CRC32** (zlib/IEEE), emitted as 4 little-endian bytes.
- **SHA-256** over the concatenation of parts.

Key derivation:

```
authkey      = SHA256( rnd1 ‖ rnd2 ‖ secret )[0..16]      // persisted across sessions
sessionKey   = SHA256( nonce ‖ authkey )[0..16]           // per connection
```

- `secret` = 16-byte device secret (obtainable from the watch via the shell command
  `AT GETSECRET` → `GETSECRET:<32-hex>,OK`).
- `rnd1` = 16 random bytes chosen by the phone; `rnd2` = 16 random bytes from the watch.
- `nonce` = bytes from the watch's nonce reply.

After the key is set, **all command-channel frames are AES-encrypted** except the plaintext
opcodes listed in §5.

---

## 4. Authentication / pairing handshake

Two entry paths share the same nonce/confirm tail.

### 4.1 First-time pairing (have the device secret)

```
phone → (shell)  AT GETSECRET
watch → (shell)  GETSECRET:<32hex>,OK
        phone: rnd1 = random16 ;  signed1 = SHA256(rnd1 ‖ secret)
phone → AUTH_PAIR_REQUEST  (plaintext)   payload = rnd1(16) ‖ signed1(32)        // 48 B
watch → AUTH_PAIR_REPLY    (plaintext)   payload = rnd2(16) ‖ signed2(32)        // 48 B
        phone verifies signed2 == SHA256(rnd2 ‖ secret)
        phone: authkey = SHA256(rnd1 ‖ rnd2 ‖ secret)[0..16]   → set crypto key = authkey
phone → AUTH_PHONE_NAME     (encrypted)  payload = 0xA5 ‖ model(UTF-8)           // e.g. "CMF Watch Pro 2"
watch → AUTH_WATCH_MAC      (encrypted)
phone → AUTH_NONCE_REQUEST  (encrypted)  payload = 0xA5
watch → AUTH_NONCE_REPLY    (encrypted)  payload = nonce
        phone: sessionKey = SHA256(nonce ‖ authkey)[0..16]     → set crypto key = sessionKey
phone → AUTHENTICATED_CONFIRM_REQUEST (encrypted) payload = 0xA5
watch → AUTHENTICATED_CONFIRM_REPLY   (encrypted)  → state = Initialized
```

On `AUTH_FAILED (0xFFFF,0xA061)` or signature mismatch, authentication fails.

### 4.2 Reconnect (authkey already known)

```
        set crypto key = authkey (persisted)
phone → AUTH_PHONE_NAME      (encrypted)  payload = 0xA5 ‖ model
watch → AUTH_WATCH_MAC       (encrypted)
phone → AUTH_NONCE_REQUEST   (encrypted)  payload = 0xA5
watch → AUTH_NONCE_REPLY     (encrypted)  payload = nonce
        sessionKey = SHA256(nonce ‖ authkey)[0..16]   → set crypto key = sessionKey
phone → AUTHENTICATED_CONFIRM_REQUEST (encrypted)  payload = 0xA5
watch → AUTHENTICATED_CONFIRM_REPLY   (encrypted)  → Initialized
```

### 4.3 Post-auth init (phase 2)

Immediately after `Initialized`, the client typically queries:
`FIRMWARE_VERSION_GET`, `SERIAL_NUMBER_GET`, `BATTERY (0xA5)`, and sends `TIME` (see §7).

---

## 5. Plaintext vs encrypted

Frames are AES-encrypted once a key is set, **except** these opcodes, which are always plaintext:

- `AUTH_PAIR_REQUEST` (`FFFF 8047`), `AUTH_PAIR_REPLY` (`FFFF 0048`)
- `DATA_CHUNK_WRITE_WATCHFACE` (`FFFF 9064`), `DATA_CHUNK_WRITE_FIRMWARE` (`FFFF 9042`),
  `DATA_CHUNK_WRITE_AGPS` (`FFFF 905F`)

---

## 6. Opcode reference `(cmd1, cmd2)`

`GET`/`SET`/`REQUEST` = phone→watch; `RET`/`REPLY`/`ACK`/`RESPONSE`/`DATA` = watch→phone.

### Session / device
| Name | cmd1,cmd2 |
|---|---|
| TIME | `FFFF 8004` |
| FIRMWARE_VERSION_GET / _RET | `FFFF 8006` / `FFFF 0006` |
| SERIAL_NUMBER_GET / _RET | `00DE 0002` / `00DE 0001` |
| BATTERY | `005C 0001` |
| TRIGGER_SYNC | `005C 0002` |
| FACTORY_RESET | `009A 0001` |
| GPS_COORDS / GPS_PUSH_RET | `FFFF 906A` / `FFFF A06A` |
| UNBIND_SET / _RET | `FFFF 907A` / `FFFF A07A` |

### Auth
| Name | cmd1,cmd2 |
|---|---|
| AUTH_PHONE_NAME | `FFFF 8049` |
| AUTH_WATCH_MAC | `FFFF 0049` |
| AUTH_PAIR_REQUEST / _REPLY | `FFFF 8047` / `FFFF 0048` |
| AUTH_NONCE_REQUEST / _REPLY | `FFFF 804B` / `FFFF 004C` |
| AUTHENTICATED_CONFIRM_REQUEST / _REPLY | `FFFF 804D` / `FFFF 0004` |
| AUTH_FAILED | `FFFF A061` |

### Notifications / call / find
| Name | cmd1,cmd2 |
|---|---|
| APP_NOTIFICATION | `0065 0001` |
| CALL_REMINDER_REQUEST / _RESPONSE | `FFFF 9066` / `FFFF A066` |
| FIND_PHONE | `005B 0001` |
| FIND_WATCH | `005D 0001` |
| FIND_WATCH_TOGGLE | `FFFF 9069` |
| SMS_MESSAGE_PUSH / _RET | `FFFF 906E` / `FFFF A06E` |
| QUICK_REPLY_SET / _RET | `FFFF 9073` / `FFFF A073` |

### Music
| Name | cmd1,cmd2 |
|---|---|
| MUSIC_INFO_SET / _ACK | `FFFF 905C` / `FFFF A05C` |
| MUSIC_BUTTON | `FFFF A05D` |

### Alarms / contacts / reminders
| Name | cmd1,cmd2 |
|---|---|
| ALARMS_SET / _GET | `0063 0001` / `0063 0002` |
| CONTACTS_SET / _GET | `00D5 0001` / `00D5 0002` |
| STANDING_REMINDER_SET / _GET | `0060 0001` / `0060 0002` |
| WATER_REMINDER_SET / _GET | `0061 0001` / `0061 0002` |
| TASK_REMINDER_SET / _RET | `FFFF 9072` / `FFFF A072` |

### Config
| Name | cmd1,cmd2 |
|---|---|
| GOALS_SET / _ACK | `005E 0001` / `005E 0003` |
| UNIT_LENGTH / _ACK | `FFFF 9067` / `FFFF A067` |
| UNIT_TEMPERATURE / _ACK | `FFFF 9068` / `FFFF A068` |
| TIME_FORMAT / _ACK | `005F 0001` / `005F 0003` |
| WAKE_ON_WRIST_RAISE / _GET / _ACK | `0062 0001` / `0062 0002` / `0062 0003` |
| LANGUAGE_SET / _RET | `FFFF 9058` / `FFFF A06B` |
| HEART_MONITORING_ENABLED_SET / _GET | `009B 0001` / `009B 0002` |
| HEART_MONITORING_ALERTS | `FFFF 9059` |
| DO_NOT_DISTURB / _GET | `0099 0001` / `0099 0002` |
| SPORTS_SET / _GET | `00DC 0001` / `00DC 0002` |
| SPORT_LINKAGE_SET / _RET | `FFFF 9076` / `FFFF A076` |
| FEMALE_CYCLE_SET / _RET | `FFFF 9071` / `FFFF A071` |
| SLEEP_CONFIG_SET / _RET | `FFFF 9074` / `FFFF A074` |
| WORLD_CLOCK_DST_SET / _RET | `FFFF 9083` / `FFFF A083` |
| VITALITY_GET / _RET | `FFFF 9079` / `FFFF A079` |
| VITALITY_SW_SET / _RET | `FFFF 9070` / `FFFF A070` |

### Weather
| Name | cmd1,cmd2 |
|---|---|
| WEATHER_SET_1 | `FFFF 906B` |
| WEATHER_SET_2 | `0066 0001` |

### Watch faces / dials
| Name | cmd1,cmd2 |
|---|---|
| DIAL_COMMAND_SET / _RET | `FFFF 9055` / `FFFF A055` |
| DIAL_CONFIG_SET / _RET | `FFFF 9075` / `FFFF A075` |
| CHANGE_DIAL | `009F 0001` |
| QUICK_CARD_SET / _GET / _RET | `FFFF 906D` / `FFFF 906C` / `FFFF A06D` |

### Health / sync
| Name | cmd1,cmd2 |
|---|---|
| ACTIVITY_FETCH_1 / _2 | `FFFF 8005` / `FFFF 9057` |
| ACTIVITY_FETCH_ACK_1 / _2 | `FFFF 0005` / `FFFF A057` |
| ACTIVITY_DATA | `0056 0001` |
| SLEEP_DATA / _GET | `0058 0001` / `0058 0002` |
| SPO2 | `0055 0001` |
| STRESS | `009D 0001` |
| HEART_RATE_MANUAL_AUTO | `0053 0001` |
| HEART_RATE_RESTING | `00DA 0001` |
| HEART_RATE_WORKOUT | `00E0 0001` |
| WORKOUT_SUMMARY / _V3 | `0057 0001` / `0160 0001` |
| WORKOUT_GPS | `FFFF A05A` |

### Bulk data transfer (data channel)
Watchface / firmware / AGPS use an init → chunk-request/chunk-write loop → finish-ack:

| Domain | INIT1 req/reply | INIT2 req/reply | CHUNK req/write | FINISH ack1/ack2 |
|---|---|---|---|---|
| Watchface | `8052`/`0052` | `9063`/`A063` | `A064`/`9064` | `A065`/`9065` |
| Firmware | `9052`/`A052` | `9040`/`A040` | `A042`/`9042` | `A041`/`9041` |
| AGPS/EPO | `905E`/`A05E` | — | `A05F`/`905F` | `A060`/`9060` |

(all `cmd1 = FFFF`.) The watch drives the loop by emitting `DATA_CHUNK_REQUEST_*(offset, length)`
(offset/length = u32 **big-endian**); the phone replies with `DATA_CHUNK_WRITE_*` carrying
`payload[offset..offset+length]` on the data characteristic.

---

## 7. Time & timezone

`TIME (FFFF 8004)` payload = `epochSeconds(i32, BE) ‖ utcOffsetMillis(i32, BE)`. Sent right after
auth so the watch shows local time.

> ⚠️ **Health timestamps from the watch are UTC.** The companion app must add the local UTC offset
> before deriving the local calendar day / time-of-day. (Bucketing health by raw UTC day rolls the
> day over at the wrong local time.)

`TIME_FORMAT (005F 0001)` payload = 1 byte: `00` = 24h, `01` = 12h.

---

## 8. Health sync

1. Phone sends `ACTIVITY_FETCH_1`; watch replies `ACTIVITY_FETCH_ACK_1` (first byte `01` ⇒ ready).
2. Phone sends `ACTIVITY_FETCH_2`; the watch then pushes a burst of data frames:
   `ACTIVITY_DATA`, `HEART_RATE_*`, `SPO2`, `STRESS`, `SLEEP_DATA`, `WORKOUT_SUMMARY[_V3]`.
3. Each is parsed into per-minute samples / sessions and aggregated by **local** day.

### 8.1 Activity record — `ACTIVITY_DATA` (32 bytes each, LE)
| Offset | Size | Field |
|---|---|---|
| 0 | 4 | timestamp (epoch s) |
| 4 | 4 | steps |
| 8 | 4 | distance (m) |
| 12 | 4 | calories |
| 16 | 16 | reserved (observed 0) |

> **Calorie unit:** activity calories are reported in **cal** (gram-calories). Divide the daily sum
> by **1000** to get kcal. (Workout-summary calories, by contrast, are already in kcal.)

### 8.2 HR / SpO₂ / Stress samples (8 bytes each)
`timestamp(i32) ‖ value(i32)` — value = bpm / SpO₂ % / stress index respectively.

### 8.3 Sleep — `SLEEP_DATA` (18-byte header + N × 8-byte records)
One `SLEEP_DATA` = **one** sleep session; a night may contain several (micro-wakes split sessions).

Header:
| Offset | Size | Field |
|---|---|---|
| 0 | 4 | session_start (epoch, UTC) |
| 4 | 4 | wakeup (epoch, UTC) |
| 8 | 2 | total_deep_s |
| 10 | 2 | total_core_s |
| 12 | 2 | total_rem_s |
| 14 | 2 | total_awake_s |
| 16 | 2 | *[uncertain]* (session id/score?) |

Each 8-byte record: `timestamp(u32) ‖ duration_s(u16) ‖ stage(u16)`.
Stage codes: `1 = Deep`, `2 = Core/light`, `3 = REM`, `4 = Awake`.

### 8.4 Workout summary — `WORKOUT_SUMMARY` v1 (54 bytes, key fields)
`start(u32)`, `end(u32)`, `duration_s(u32)`, then type/calories/steps/distance/avg-HR and a
GPS/extended block; some Watch-2 extra fields at offsets 29..54 are *[uncertain]*. `WORKOUT_SUMMARY_V3`
(`0160 0001`) is a newer layout for the same data.

---

## 9. Selected command payloads

Strings are UTF-8, **byte-truncated** to the field size (truncation may split a multi-byte char,
matching the firmware's `s.encode()[:max]` behavior); short fields are zero-padded on the right.

- **APP_NOTIFICATION** (`0065 0001`): `iconCode(1) ‖ 0x00 ‖ when(u32 BE) ‖ titleLen(1) ‖ title ‖ body`.
  `iconCode` selects the app icon (e.g. WhatsApp=8, Telegram=12, Instagram=18, Gmail=27; unknown=`0xFF`).
  Title ≤ 20 bytes, body ≤ 128 bytes.
- **CONTACTS_SET** (`00D5 0001`): N × 57 bytes = `name(32) ‖ phone(25)`. Watch UI shows up to 20.
- **GOALS_SET** (`005E 0001`): `steps(u16) ‖ distance_m(u16) ‖ calories(u16)`.
- **MUSIC_INFO_SET** (`FFFF 905C`, 131 B): `state(1: 0=none/1=paused/2=playing) ‖ volume(1) ‖
  volumeMax(1) ‖ track(64) ‖ artist(64)`.
- **WEATHER_SET_2** (`0066 0001`, 199 B): 7×9-byte days + 24×2-byte hours + city(32) +
  7×8-byte sunrise/sunset (LE). Temperatures encoded as `(temp_c + 100) & 0xFF`.
- **FIND_WATCH** (`005D 0001`): payload `0x01` → watch rings/vibrates.
- **TIME** (`FFFF 8004`): see §7.

Other setters (alarms, reminders, DND, HR alerts, female cycle, dials, vitality, task reminder,
quick card, …) follow the same framing; see the opcode table and the reference encoders in
`core-rust/src/commands.rs`.

---

## 10. Implementation notes & quirks

- **No system clock in codecs:** encoders take `now`/`utc_offset` as explicit parameters
  (deterministic, testable). The transport supplies the real time.
- **Plaintext CRC counting** (§2) is easy to get wrong — plaintext frames advertise but omit the CRC.
- **Endianness:** header + opcodes BE; payload integers LE; bulk-transfer offset/length BE.
- **MTU:** chunk sizes are computed so encrypted chunks align to 16-byte AES blocks.
- **authkey is persistable** (store it after first pairing); **sessionKey is per-connection** and
  derived from the watch nonce on every reconnect.

---

*Section references like “spec §5.6” in the source correspond to an internal numbered RE doc set;
the authoritative source for byte layouts is `core-rust/src/{commands,frame,crypto,health,session}.rs`.*
