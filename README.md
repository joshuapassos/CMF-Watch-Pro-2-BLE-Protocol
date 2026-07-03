# CMF Watch Pro 2 — BLE Protocol (reverse-engineered)

> **Unofficial.** This document describes the Bluetooth Low Energy (BLE) protocol of the
> **CMF Watch Pro 2** (CMF by Nothing), reconstructed by reverse engineering for an alternative
> companion app. It is not affiliated with or endorsed by Nothing/CMF. Use at your own risk.

All multi-byte integers in the **frame header and opcodes are big-endian**. Integers **inside
command payloads** are little-endian unless stated otherwise (this mirrors the device firmware) —
watch out for the exceptions (`GOALS_SET`, `GPS_PUSH`, bulk-transfer offset/length are big-endian).

### Confidence markers

Every non-obvious claim below is tagged with how it was established:

- ✅ **validated on-device** — observed in a decrypted live capture or exercised against a real watch.
- 🔎 **from firmware / APK RE** — extracted by decompiling the firmware (1.0.0.73) or the official
  APK (3.5.7); consistent with the code but **not** runtime-tested.
- ⚠️ **[uncertain]** — inferred, not confirmed; may be wrong.

Test device for all captures: `CMF Watch Pro 2-5485`, fw **1.0.0.73**, serial `CI04102520008192`,
MCU Actions ATS3089C (Cortex-M4), screen **466×360**.

---

## 1. GATT layout

The phone is the GATT client; the watch is the peripheral, advertising as `CMF Watch Pro 2-XXXX`
(4 hex chars).

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
AT-style text (e.g. `AT GETSECRET`; see §14). The **data channel** (`02f0…`) carries large binary
blobs (watchface, firmware, AGPS), coordinated by control opcodes on the command channel.

✅ A whole real session ran on the single command channel — during a 160 s heavy-use capture there
was **no traffic** on the data/firmware or shell channels except during an explicit OTA/watchface
transfer.

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

- `cmd1`/`cmd2` together form the **opcode** (see §6). 🔎 confirmed against the official app's frame
  builder (`C6117b.m30831g`).
- `chunkCount` = total chunks for this command; `chunkIndex` is **1-based**.
- `chunkLen` = number of bytes of `chunk` in this frame.
- A single BLE write may be fragmented by the link MTU; the receiver buffers raw bytes and
  re-extracts complete frames. Large payloads are split into multiple chunks (same `cmd1/cmd2`,
  increasing `chunkIndex`) and reassembled in order.

### Opcode convention (✅ confirmed on the wire)

- `cmd1 = 0xFFFF`: `cmd2` in `0x80xx`/`0x90xx` = phone→watch (request/set); `0x00xx`/`0xa0xx` =
  watch→phone (reply). Pairs match by the low byte (`0x9055`↔`0xa055`, `0x8051`↔`0x0051`).
- feature-specific `cmd1`: `cmd2` suffix = `0x0001` **SET**, `0x0002` **GET**, `0x0003` **ACK**.

### Chunk body

For each chunk, the body is `payloadPiece ‖ CRC32_LE(payloadPiece)` (4-byte CRC, little-endian,
zlib/IEEE). If the command is **encrypted** (see §3), the whole `payloadPiece ‖ CRC` is then
AES-128-CBC/PKCS7 encrypted and that ciphertext becomes the frame `chunk`.

**Plaintext quirk:** for plaintext opcodes the watch *counts* the 4-byte CRC in `chunkLen` but does
**not** transmit it. So when decoding a plaintext frame, the actual data length is `chunkLen − 4`.
(Encrypted frames carry the CRC inside the ciphertext as normal.)

Chunk sizing (so encrypted chunks land on AES block boundaries), with `maxWrite = mtu − 3`:
- encrypted: `floor((maxWrite − 11) / 16) * 16 − 4 − 1`
- plaintext: `maxWrite − 11 − 4 − 2`

✅ All observed encrypted frame `chunkLen` values were multiples of 16 (block alignment holds).

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

✅ Both derivations validated: `authkey` recovered from a rooted phone's `ntwatch.db` matched the
value derived from a captured `rnd1/rnd2/secret`; `sessionKey` reproduced from a captured nonce
decrypts live frames.

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

✅ The reconnect order (no shell traffic) was observed intact on a real capture.

### 4.3 Post-auth init (phase 2)

> ⚠️→✅ **`TIME` is mandatory before data queries.** After `Initialized`, the watch will **not**
> answer `BATTERY`, `SERIAL_NUMBER_GET`, or the `ACTIVITY_FETCH_*` handshake **until** a
> `TIME (FFFF 8004)` has been sent in the session — without it, only an unsolicited
> `FIRMWARE_VERSION_RET` arrives and everything else times out. ✅ confirmed live (Pixel 8a):
> sending the three GETs with no `TIME` → only firmware replies; sending `TIME` first → battery
> **and** serial start replying.

Recommended phase-2 order: `TIME` → `FIRMWARE_VERSION_GET` → `SERIAL_NUMBER_GET` →
`BATTERY (0xA5)` → config pushes → health sync (§8).

### 4.4 GET → SET echo pattern (✅)

There is no separate "read" opcode for most settings. Sending a `*_GET` (`cmd2 = 0x0002`, payload
`0xA5`) makes the watch **reply with the SET opcode** (`cmd2 = 0x0001`) carrying the current value.
SET commands are acknowledged with `cmd2 = 0x0003` and an empty body.

---

## 5. Plaintext vs encrypted

Frames are AES-encrypted once a key is set, **except** these opcodes, which are always plaintext:

- `AUTH_PAIR_REQUEST` (`FFFF 8047`), `AUTH_PAIR_REPLY` (`FFFF 0048`)
- `DATA_CHUNK_WRITE_WATCHFACE` (`FFFF 9064`), `DATA_CHUNK_WRITE_FIRMWARE` (`FFFF 9042`),
  `DATA_CHUNK_WRITE_AGPS` (`FFFF 905F`)

Frame **headers** (`cmd1/cmd2`) always travel in the clear, so the command *sequence* is visible in
any capture even without the key — only encrypted **payloads** need `sessionKey`.

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
| USER_INFO_SET / _RET 🔎✅ | `0095 0001` / `0095 0003` |
| FACTORY_RESET | `009A 0001` |
| DEVICE_REBOOT 🔎 | `FFFF 9080` |
| RESOLUTION_GET 🔎 (→ 466×360) | `FFFF 907F` |
| GPS_PUSH / _RET | `FFFF 906A` / `FFFF A06A` |
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
| INCOMING_CALL ⚠️ | `0064 0001` |
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
| TASK_REMINDER_SET / _RET ⚠️ | `FFFF 9072` / `FFFF A072` |

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
| SPORT_DATA_SYNC 🔎 (live HR/cal/steps) | `FFFF 9078` / `FFFF A078` |
| FEMALE_CYCLE_SET / _RET | `FFFF 9071` / `FFFF A071` |
| SLEEP_CONFIG_SET / _RET (target min) | `FFFF 9074` / `FFFF A074` |
| WORLD_CLOCK_GET | `FFFF 906F` |
| WORLD_CLOCK_DST_SET / _RET | `FFFF 9083` / `FFFF A083` |
| VITALITY_GET / _RET | `FFFF 9079` / `FFFF A079` |
| VITALITY_SW_SET / _RET | `FFFF 9070` / `FFFF A070` |

### Weather
| Name | cmd1,cmd2 |
|---|---|
| **WEATHER_SET_1** (the one that works) | `FFFF 906B` |
| WEATHER_SET_2 (ignored on Pro 2 — see §9) | `0066 0001` |

### Watch faces / dials
| Name | cmd1,cmd2 |
|---|---|
| DIAL_COMMAND_SET / _RET (list/reorder/select) | `FFFF 9055` / `FFFF A055` |
| DIAL_CONFIG_SET / _RET | `FFFF 9075` / `FFFF A075` |
| CHANGE_DIAL (⚠️ inert on 1.0.0.73 — don't use) | `009F 0001` |
| QUICK_CARD_SET/GET / _RET (both on 906D) | `FFFF 906D` / `FFFF A06D` |

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
| SKIN_TEMP_HISTORY 🔎 (empty on this SKU) | `0155 0001` / `0155 0002` |
| WORKOUT_SUMMARY / _V3 | `0057 0001` / `0160 0001` |
| WORKOUT_GPS | `FFFF A05A` |

> **JS-only opcodes** (`FFFF 8051`, `FFFF 0051`, `FFFF 90A2`, `FFFF 90C5`, `FFFF A056`,
> `FFFF 908A/908B` ChatGPT status/support) are handled in the app's Hermes bytecode, not the Java
> layer. Their headers appear in captures but payload semantics are ⚠️ **[uncertain]**.

### Bulk data transfer (data channel)
Watchface / firmware / AGPS use an init → chunk-request/chunk-write loop → finish-ack:

| Domain | INIT1 req/reply | INIT2 req/reply | CHUNK req/write | FINISH ack1/ack2 |
|---|---|---|---|---|
| Watchface (photo) | `8052`/`0052` | `9063`/`A063` | `A064`/`9064` | `A065`/`9065` |
| Watchface (structured/switch) | `8052`/`0052` | `9075`/`A075` | `A064`/`9064` | `A065`/`9065` |
| Firmware | `9052`/`A052` | `9040`/`A040` | `A042`/`9042` | `A041`/`9041` |
| AGPS/EPO | `905E`/`A05E` | — | `A05F`/`905F` | `A060`/`9060` |

(all `cmd1 = FFFF`.) The watch drives the loop by emitting `DATA_CHUNK_REQUEST_*(offset, length)`
(offset/length = u32 **big-endian**); the phone replies with `DATA_CHUNK_WRITE_*` carrying
`payload[offset..offset+length]` on the data characteristic. See §11–§12 for details.

---

## 7. Time & timezone

`TIME (FFFF 8004)` payload = `epochSeconds(i32, BE) ‖ utcOffsetMillis(i32, BE)`. Sent right after
auth so the watch shows local time (and unblocks data queries — see §4.3).

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

The sync is sequential (must follow `TIME`; the watch releases the streams after `ACK_2`), not a
single burst. A heavy session pushes ~170–210 notification frames in ~160 s. ✅

### 8.1 Activity record — `ACTIVITY_DATA` (32 bytes each, LE) ✅
| Offset | Size | Field |
|---|---|---|
| 0 | 4 | timestamp (epoch s) |
| 4 | 4 | steps |
| 8 | 4 | distance (m) |
| 12 | 4 | calories |
| 16 | 16 | reserved (observed 0) |

> **Calorie unit:** activity calories are reported in **cal** (gram-calories). Divide the daily sum
> by **1000** to get kcal. (Workout-summary calories, by contrast, are already in kcal.)

### 8.2 HR / SpO₂ / Stress samples ✅
- Manual/auto HR, workout HR, SpO₂, stress = **8 bytes** each: `timestamp(i32 LE) ‖ value(i32 LE)`
  (value = bpm / SpO₂ % / stress index).
- **Resting HR (`00DA 0001`) is different — 5 bytes**: `timestamp(i32 LE) ‖ hr(u8)`.
  ✅ live example `5e dc 29 6a 4e` → ts, hr = 78 bpm. Stress score ranges: 1–29 / 30–59 / 60–79 / 80–99.

### 8.3 Sleep — `SLEEP_DATA` (18-byte header + N × 8-byte records) ✅
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
| 16 | 2 | ⚠️ **[uncertain]** (session id/score? observed values don't match record sums) |

Each 8-byte record: `timestamp(u32) ‖ duration_s(u16) ‖ stage(u16)`.
Stage codes: `1 = Deep`, `2 = Core/light`, `3 = REM`, `4 = Awake`. ✅ validated against a full night
(two sessions, D/C/R/A totals reconcile).

### 8.4 Workout summary — `WORKOUT_SUMMARY` v1 (54 bytes) / `_V3` (`0160 0001`)
v1: `start(u32)`, `end(u32)`, `duration_s(u32)`, then type/calories/steps/distance/avg-HR and a
GPS/extended block. ✅ v1 layout confirmed against firmware. `WORKOUT_SUMMARY_V3` is a newer layout
for the same data plus a ~40-byte extended block (exerciseLoad, aerobic/anaerobic, recoveryTime,
VO₂max, cadence, PAI, best-run times…). The **field set is known** (from the app's Room DB) but the
**exact byte offsets inside that 40-byte block are ⚠️ [uncertain]** — closing them needs one raw
capture of a GPS workout.

---

## 9. Selected command payloads

Strings are UTF-8, **byte-truncated** to the field size (truncation may split a multi-byte char,
matching the firmware's `s.encode()[:max]` behavior); short fields are zero-padded on the right.

- **APP_NOTIFICATION** (`0065 0001`) ✅: `iconCode(1) ‖ 0x00 ‖ when(u32 BE) ‖ titleLen(1) ‖ title ‖ body`.
  `iconCode` selects the app icon (WhatsApp=8, Telegram=12, Instagram=18, Gmail=27; unknown=`0xFF`).
  Title ≤ 20 bytes, body ≤ 128 bytes. Sent from a client → watch displayed it + ACK `0065 0003`.
- **BATTERY** (`005C 0001`) ✅: reply = `level(1) ‖ charging(1)` (e.g. `3b 00` = 59 %, not charging).
- **SERIAL_NUMBER_RET** (`00DE 0001`) ✅: `len(1) ‖ ASCII` (e.g. `10` + "CI04102520008192").
- **USER_INFO** (`0095 0001`) ✅: `height_cm(1) ‖ weight_kg(1) ‖ age(1) ‖ gender(1: 1=M)`
  (e.g. `ac 49 1f 01` = 172 cm / 73 kg / 31 / male).
- **CONTACTS_SET** (`00D5 0001`) ✅: N × 57 bytes = `name(32) ‖ phone(25)`. Watch UI shows up to 20.
- **ALARMS_SET** (`0063 0001`) ✅ — **corrects Gadgetbridge** (which put the label at the end,
  `0xff`-padded — wrong). **40 bytes per alarm, big-endian**:
  `secondsOfDay(i32) ‖ index(u8) ‖ enabled(u8) ‖ repetition-bitmask(u8) ‖ flag(u8) ‖ label[32] UTF-8`.
  The **label is at offset 8** and shows on the watch. `repetition` = weekday bitmask (0 = one-time);
  `flag` is ⚠️ [uncertain] (one-time marker?). Example (13:30, idx 2): `0000bdd8 02 01 15 00 "Alarm…"`.
- **GOALS_SET** (`005E 0001`) ✅ — the official app and the reference implementation use the
  **10-byte, big-endian** `DailyTargetBean` v1: `steps(u32 BE) ‖ distance_m(u32 BE) ‖
  calories_kcal(u16 BE)`. (This is the Gadgetbridge form; earlier reports that the watch "ignored"
  it were a stale-session decrypt bug, not a payload problem.) 🔎 Firmware RE also shows a longer
  **29-byte extended** variant (adds `sleep_min`/`exercise_min`/`stand_h` + 6 enable flags, all u32
  BE after a `flag(u16 LE)` prefix, with ranges enforced: steps 2000–30000, dist 1000–99000, cal
  100–5000, sleep 360–720, exercise 30–90, stand 6–16) — not the app's default path; prefer the
  10-byte form unless you need the extra targets.
- **STANDING_REMINDER / WATER_REMINDER** (`0060`/`0061 0001`) ✅: **11 bytes**:
  `enabled(1) ‖ threshold_min(u16 LE) ‖ dndStart(u32 LE) ‖ dndEnd(u32 LE)`. Note the "active window
  08:00–22:00" shown in the UI is a **fixed firmware default** and is **not** carried in the payload.
- **SPORTS_SET** (`00DC 0001`) ✅: `count(1) = 36 slots ‖ activityTypeCode[36]` (active codes then `00`
  padding). Selects which sports appear in the watch's workout menu.
- **HEART_MONITORING_ENABLED** (`009B 0001`) ✅: `kind` byte — `01` = 24/7 HR, `02` = SpO₂,
  `04` = stress (measured every 30 min).
- **HEART_MONITORING_ALERTS** (`FFFF 9059`) ✅: disabled = `00`; enabled =
  `01 ‖ hrLow ‖ hrHigh ‖ sportHrHigh ‖ spo2Low ‖ 00 00 00 00` (a `0`/`255` bound = "no limit").
- **FEMALE_CYCLE** (`FFFF 9071`) ✅: `01 ‖ predictionOpen ‖ notifySwitch ‖ cycleStartSwitch ‖
  cycleStartNotifyBefore ‖ ovulationStartSwitch ‖ ovulationStartNotifyBefore ‖ fertileStartSwitch ‖
  fertileStartNotifyBefore ‖ period(1) ‖ cyclePeriod(1) ‖ cycleStartDate(u32) ‖ markStart(u32) ‖
  markEnd(u32)` (captured: period=5, cyclePeriod=0x1c=28).
- **QUICK_REPLY** (`FFFF 9073`) ✅: TLV — `count(1) ‖ total(1) ‖ [id(1) ‖ len(u16 LE) ‖ msg-UTF8]…`
  (7 default replies captured & decrypted).
- **WORLD_CLOCK** (`FFFF 906F`) ✅: sends numeric **city IDs**, not names (`01 ‖ count ‖ cityId(2 BE)…`);
  the watch maps ids from an internal table. DST config `FFFF 9083` =
  `count ‖ [id(u16 LE) ‖ dst(u16 LE) ‖ start(u32 LE) ‖ end(u32 LE)]…`.
- **MUSIC_INFO_SET** (`FFFF 905C`, 131 B) ✅: `state(1: 0=none/1=paused/2=playing) ‖ volume(1) ‖
  volumeMax(1) ‖ track(64) ‖ artist(64)`. The watch also sends `MUSIC_BUTTON (A05D)` back.
- **WEATHER_SET_1** (`FFFF 906B`, 199 B) ✅ — **use this one**: 7×9-byte days + 24×2-byte hours +
  city(32) + 7×8-byte sunrise/sunset (LE). Temperatures encoded as `(temp_c + 100) & 0xFF`.
  ⚠️ The same payload sent on `WEATHER_SET_2` (`0066 0001`) does **not** update the weather widget on
  Pro 2 — always use `906B`. (The city string is also a proven data-hijack vector — see §13.)
- **FIND_WATCH** (`005D 0001`) ✅: payload `0x01` → watch rings/vibrates (+ ACK `005D 0003`).
- **GPS_PUSH** (`FFFF 906A`) ✅ — **big-endian, longitude first**: 16 bytes
  `ts(u32 BE) ‖ lon×1e7(i32 BE) ‖ lat×1e7(i32 BE) ‖ 00 00`. Validated to a real location.
- **WORKOUT_GPS** (`FFFF A05A`) ✅ — **little-endian, longitude first**: 12 bytes
  `ts(i32) ‖ lon×1e7(i32) ‖ lat×1e7(i32)`.
- **TIME** (`FFFF 8004`): see §7.

---

## 10. Implementation notes & quirks

- **No system clock in codecs:** encoders take `now`/`utc_offset` as explicit parameters
  (deterministic, testable). The transport supplies the real time.
- **`TIME` gates everything** (§4.3) — send it first or the watch stays mute on data queries.
- **Plaintext CRC counting** (§2) is easy to get wrong — plaintext frames advertise but omit the CRC.
- **Endianness:** header + opcodes BE; payload integers LE; **exceptions** — `GOALS_SET` and
  `GPS_PUSH` are big-endian, and bulk-transfer offset/length are big-endian.
- **MTU:** chunk sizes are computed so encrypted chunks align to 16-byte AES blocks.
- **authkey is persistable** (store it after first pairing); **sessionKey is per-connection** and
  derived from the watch nonce on every reconnect.

---

## 11. Watch faces / dials — authoring

The watch supports (a) **photo/custom dials** (a background image + a firmware-drawn digital clock)
and (b) **structured dials** (built-in / store faces: a background plus positioned sprite layers,
hands, and text widgets). Both transfer over the data channel via the init → chunk loop in §6.

> **What actually works (✅ validated live):** building a **photo dial from any image** and installing
> it; installing any of the **103 store dials** offline; **reskinning** a structured dial (swap the
> background or any non-background sprite) and **moving** its layers; **reordering / switching** the
> active face; and **building a structured dial from scratch** — the `0x20` scene envelope is
> decoded and the builder is implemented (§11.7), proven **offline** to round-trip all 103 store
> dials byte-for-byte and to emit synthetic containers that pass the firmware's own validator. **🟡
> the only unproven step** is watching a from-scratch synthetic render **on-device** over `9075`
> (structural offline proof already covers what used to cause the `0a` reject). There is **no codec
> or transport barrier and no need for the vendor toolchain.** The old
> "structured render is RES-pack-baked / impossible over BLE" and "cf=0x1f server-side codec" claims
> were **wrong** (an offset+bytes-per-pixel bug) — the firmware renders structured dials **data-driven
> from the file you send**.

### 11.1 Dial management — `DIAL_COMMAND (9055 / a055)` ✅

- **type 0** = query the list. Reply `a055` = `result(u8) ‖ selectIndex(u8) ‖ total(u8) ‖ max(u8) ‖
  N × dialId(u32 LE) ‖ ffffffff`. Example: `01 05 06 07 …` = active #5, 6 dials, max 7.
- **type 1** = reorder / select active: resend the whole list with the target dial at index 0
  (this is how the official app switches faces; there is no dedicated "set active" opcode).
- **Delete a dial** = resend the list **without** its id.
- `CHANGE_DIAL (009F 0001)` is **inert** on fw 1.0.0.73 (returns a constant, doesn't switch) — do not
  use it.

### 11.2 Transfer flow ✅

```
INIT1 8052 (payload A5) → 0052 [0]=01
INIT2  9063 (photo, APPEND)  |  9075 (structured, REPLACE)  → A063 / A075 [0]=01
[ watch → DATA_CHUNK_REQUEST A064 (offset, length; u32 BE, +progress u8)
  phone → DATA_CHUNK_WRITE   9064 (bytes[offset..offset+length], plaintext) ] × N
FINISH A065 → 9065 (payload A5)
```

Finish reply byte: `01` = activated & saved; `0a` = stored but **not** activated / rejected. On
Android each `DATA_CHUNK_WRITE` must go out as **one BLE write per frame** — concatenating and
re-slicing by MTU desyncs the headers and the watch loops asking for offset 0.

- **`9063` (photo) = APPEND.** The dial list grows (6→7); `watchfaceId = 0xFFFFFFFF` (custom
  sentinel) so it is never rejected as a duplicate, and the watch auto-activates it.
- **`9075` (structured) = REPLACE** the `old_id` slot. `old_id` **must** already be in the list
  (otherwise `0a`). To re-install an id already present, **delete it first** (9055 list-minus-id)
  then upload "fresh" — reusing an id in place gives `0a`.

### 11.3 Photo / custom dial — ✅ fully validated end-to-end

**Container** (byte-verified round-trip; all fields little-endian):

```
0x00  magic     6c 8d c4 a5
0x04  count     12 00 00 00   (=18)  [constant, NOT an element count]
0x08  00 × 8
0x10  lenFull   u32 LE        (length of the whole FULL block: tag+len+payload)
0x14  FULL  tag 04 48 47 3a ‖ payloadLen(u32 LE) ‖ LZ4(RGB565-LE)   → 466×466  [raw 434312 B]
      THUMB tag 04 38 c4 21 ‖ payloadLen(u32 LE) ‖ LZ4(RGB565-LE)   → 270×270  [raw 145800 B]
EOF-4 magic     6c 8d c4 a5   [trailer = magic repeated]
```

Codec = **standard LZ4 block over RGB565 little-endian, top-down** (`payloadLen` counts from the
first LZ4 byte). The official app uses LZ4-HC and strips the 21-byte LZ4-block header/footer; a plain
literals-only LZ4 encoder also works — the watch accepts any valid LZ4, byte-identity is not
required. Pixels outside the inscribed circle (center 233,233, radius 233) are set to `0x0000`.

**INIT_2 for `9063` — exact header (✅ this is the one that works):**

```
01 ‖ size(u32 BE) ‖ FF FF FF FF ‖ 01 01 01 ‖ styleId(u16 BE) ‖ posX(u16 BE) ‖ posY(u16 BE) ‖
   color565(u16 BE) ‖ FF × 8
```

`size` = exact `.bin` length; `FFFFFFFF` = custom `watchfaceId`; `styleId` 0–4 selects the built-in
digital-clock layout (it is always drawn — there is no "off"); `posX/posY` position it (known-good
56 / 77); `color565` tints it (e.g. `FFFF` = white). ⚠️ The shorter `A5 ‖ size ‖ watchfaceId` form is
**rejected** with finish `0a` — use the full header above. (Reference impl:
`core-rust/engine.rs::build_wf_init2`, mirroring `C6135t.m31104u` in the official app.)

**Recipe:** resize the image to 466×466 (and a 270×270 thumb), convert to RGB565-LE top-down,
optionally zero the out-of-circle pixels, LZ4-compress each, assemble the container above, and upload
via the `9063` pipeline with `watchfaceId = 0xFFFFFFFF`. (Reference codec: `core-rust/watchface.rs`,
`work/codec_dfa.py`.)

### 11.4 Structured / store dial — container & codecs ✅

**Header** (identical across all 103 store dials; all fields little-endian):

```
0x00  perDialId  u32 LE     [per-dial id/hash; NOT a content checksum — 4 "Default" dials share one]
0x04  version    0x00000001 [constant]
0x08  name       char[]     [NUL-terminated, e.g. "SlopeTime", "Metaball"]
0x18  size_a     u32 LE     [= filesize − 36]   ✅ 100 % confirmed across 103 dials
0x1c  size_b     u32 LE     [data-section length, < size_a]
0x20  3× u32 LE  id/hash words [not a CRC]
0x2c  name       (repeated on larger dials)
~0x60 directory of layer records (61 xx 00 …) then the asset pool
```

There is **no blocking checksum** (CRC32/Adler32/byte-sum all fail to match) — repacking is not
gated. Stub dials (~173 B, e.g. ids 273/274/277) are placeholders for faces baked into ROM: header +
directory, no real assets.

**Assets** — each is `dimsWord(u32 LE) ‖ len(u32 LE) ‖ LZ4(payload)`, where
`cf = dimsWord & 0x1f`, `w = (dimsWord >> 10) & 0x7FF`, `h = (dimsWord >> 21) & 0x7FF`, and `len`
counts from the first LZ4 byte (the `1f 00 01 00` you often see there is the first LZ4 token — **do
not** skip it). Decompressed size = `w·h·bpp`:

| cf | bpp | raster (after LZ4) | use |
|----|-----|--------------------|-----|
| 4 | 2 | RGB565-LE | opaque background (FULL/THUMB) |
| 5 | 3 | RGB565-LE (2 B) + alpha (1 B) per px | anti-aliased sprites (glyphs, hands, icons) |
| 13 (0x0d) | 0.5 | 4-bit alpha mask; firmware tints at runtime | digit-glyph atlas |
| 24 (0x18) | 4 | RGBA8888 | full-colour layers (incl. the always-on `aodImage`) |
| 1 | — | JPEG/JFIF (`ff d8 ff`), extract with any decoder | rare animation frames |

✅ **All 4151/4151 assets across the 103 dials decode exactly** with a standard `lz4.block`
decompressor at `w·h·bpp`. Transparency is the alpha byte (cf=5/24) or `0x0000` (cf=4 outside the
circle) — there is no RLE and no "escape". Encode = re-raster → standard LZ4 → `[dimsWord][len][LZ4]`.

**INIT_2 for `9075` — AES-encrypted body:**

```
kind(1) ‖ old_id(u32 LE) ‖ new_id(u32 LE) ‖ file_len(u32 LE)
```

`kind` = `0x02`/`0x03`; `old_id` = current active dial (from `9055`); `file_len` = real `.bin`
size (= `@0x18 + 36`). Installing a store `.bin` as-is is the guaranteed path (Ring Data id 359 +
102 others confirmed). (Reference: `core-rust/engine.rs::build_dial_replace_init`.)

### 11.5 Structured directory grammar ✅ (decoded & implemented — REVISED 2026-07-02)

> **⚠️ Revision (2026-07-02): the flat `61 01 00` record schema below was systematically
> OFF-BY-ONE.** The scene body is a clean TLV (§11.7); a drawable **leaf body** (tags `0x30`/`0x38`
> static, `0x70` pointer) is:
>
> ```
> 01 xx 00 [X u16][Y u16] …attrs… 61 [count u16][base u32][count×id u16] [05 05 00 01 pivX pivY]
> ```
>
> - attr `0x01` opens the body: **X,Y = top-left** on the 466² canvas (the `s16 x,y` of the SDK's
>   `sty_picture_t`).
> - the **frame table `61 …` closes the body** (`base` = asset ptr; `count` 1 = image, 10/11 =
>   digit atlas — the old "record type `0a/0b`" was actually this count! — 7/13/2 = complication
>   frame sheet).
> - pointer extras: source+scale `[src] 00 3c 00` inside the `0x01` attr; pivot in the
>   `05 05 00 01 [pivX][pivY]` **trailer**. **Rotation center = `(X+pivX, Y+pivY)` per pointer** —
>   not a fixed (233,233): off-center subdials exist (e.g. dial 366's hands rotate around 150,150).
>
> The linear scan for `61 01 00` was stitching the frame-table+pivot of element **N** to the X/Y
> (and tag byte, the old "f3") of element **N+1** — it only *looked* right on analog dials whose
> adjacent hands share near-identical geometry. The "compact variant wall" (spec 24 §24.4.5) was
> this same misreading. Implemented as `scan_scene_drawables` in `core-rust/watchface_struct.rs`
> and `wfweb/src/codec/parse.ts` (scene = primary source for images/pointers; flat scan kept for
> text + non-envelope fallback). Validated by the `wfweb/compare.html` oracle (render vs official
> store PNGs, 99 dials): 64→72 good, 8→5 bad, mean diff 9.3→7.4%.

Historic flat-record reading (superseded, kept for context):

- **Static image** (`61 01 00`): `asset_ptr(u32) ‖ elemId(u16) ‖ 05 05 00 01 ‖ pivotX(u16) ‖
  pivotY(u16) ‖ 3B ‖ 01 ‖ 1b 00 ‖ X(u16) ‖ Y(u16)`. Top-left on the 466² canvas = `(X−pivotX, Y−pivotY)`.
- **Pointer/hand** — same image record, rotated at runtime. **Rotation center = `(X+pivotX, Y+pivotY)`**
  (≈ 233,233 on analog dials). The **data source is a `u8` at record offset `+36`**, scale `u16` at
  `+38` (=60): `0x0a`/`0x70` = hour (`h·30°+m·0.5°`), `0x0e`/`0x71` = minute (`m·6°+s·0.1°`),
  `0x12`/`0x72` = second (`s·6°`). ✅ confirmed by disassembling the getters (RTC fallback 10:10:30).
- **Text / number widget** (`61 0a 00`): `asset_ptr(u32) ‖ [10×u16 font metrics] ‖ 40 01 00 ‖ flag ‖
  3B ‖ 01 ‖ u16 ‖ X(u16) ‖ Y(u16)`. `asset_ptr` points at the glyph "0"; digit *d* = the asset at
  `index("0") + d` (10 consecutive cf=5 sprites, e.g. `0123456789` and `,°` punctuation). ✅ rendered.
- **Complication fill = frame-index** (✅ confirmed for digit/enum/gauge complications, count>1): the
  value indexes a **pre-rendered frame sheet** in the `.bin` — `frame = (count−1)·val/100` (percent) or
  `frame = value` (flip digit / enum). Frame table = sub-record `61 ‖ count(u16) ‖ base(u32) ‖
  count×id(u16)`. E.g. 327 Digit Max's big hour is a 13-frame sheet (numbers 0–12), `frame = hour`.
- **Progress ring / arc = runtime sector clip** (✅ 2026-07-02, **corrects the "rings are frame sheets"
  reading in spec 25 §2**): element tag **`0x81`** carries a **single** full disc (`61` frame-table
  `count == 1`), and the partial wedge is that disc **clipped to a pie sector** (`frac = value/max`,
  clockwise from 12 o'clock) — verified pixel-for-pixel on 322 Glare 2 and confirmed `count==1` across
  **20 dials**. On-disk: `0x81` body = sub `0x01` (geometry `x@+0 y@+2 w@+4 h@+6`, inline `61 1 base`
  = disc) + sub `0x5b` (`max` u16 `@+4`, =100 except 332=60). Implemented in wfweb (`blendSector`).
- **Data source id** — the element's `82` attr-block sits at `delim+3` (after the last `40 01 00`),
  and the **source id is a `u8` at `+0x14`** (also `relX@+0x07 s16`, `relY@+0x09 s16`, `anchor@+0x0C/0E`,
  `mode@+0x15`, `frame-count@+0x1A`). Anchor < 0 = align to the parent's edge. 🔎 The firmware resolves
  the id through a 142-entry getter table at `0x101f371c` (each calls `ux2sys_get(type)`). Common ids
  (§16): `0x07` hour, `0x0b` minute, `0x0f` second, `0x16` month, `0x18` weekday, `0x13` AM/PM,
  `0x19` HR, `0x1b` battery %, `0x24` temperature, `0x36` steps, `0x70/71/72` hand angles,
  `0x25–27` goal %. (This matches the `0x07:0x0b:0x0f` = HH:MM:SS group example below.)
- **Group node** (`0x68`): nests its children inside its own TLV body (`0x60` = value/text,
  `0x30` = static); each `0x60` carries its source id at `data+16`. E.g. a group `0x07:0x0b:0x0f` =
  HH:MM:SS clock. TLV element parser = `0x100db55c` (jump table indexed by `tag−0x70`).

### 11.6 Authoring matrix

| Path | Status | Notes |
|---|---|---|
| Photo dial from any image | ✅ **done** | §11.3; validated on-device |
| Install any of 103 store dials | ✅ **done** | §11.4; `9075`, `old_id`=active |
| Reskin cf=4 background of a store dial | ✅ **works live** | swap FULL payload in place, set the asset `len` to the **new** block size (≤ old), keep the same file footprint, fresh-install |
| Re-author by templating (swap any layer's pixels + move geometry) | ✅ **renders via BLE** | dial 373: bg→cyan + a cf=5 sprite→red + moved X 224→100, all rendered, hands live |
| 100 %-synthetic structured dial from scratch | ✅ **builder done, offline-validated** | `0x20` envelope builder in `watchface_struct.rs` (`build_container`/`serialize`/`validate_container`); round-trips all 103 dials byte-exact + synthetic passes firmware validator (§11.7). 🟡 on-device render over `9075` not yet filmed |
| System fonts (`.font`) | ✅ **decode/render (all)** | LVGL bin (not proprietary); 32 number fonts (`num*/nm*`, uncompressed) + 24 text fonts (`font*`, LVGL RLE `comp=1`) all decode — 12208 glyphs, 0 overruns, full ASCII. RLE = LVGL v8.3 `lv_font_fmt_txt.c` (3-state SINGLE/REPEATE/COUNTER + per-row XOR prefilter), ported 1:1, no disasm |

⚠️ Reskin/re-author pitfalls that cause a black screen or `0a`: leaving the **old asset `len`** (the
watch reads past the block → overrun → black); **growing the file** (rejected at install); reusing an
id **in place** instead of a fresh install.

### 11.7 The `0x20` scene envelope — decoded & builder implemented ✅

A re-authored **real** dial renders because it preserves the file's scene envelope. A purely synthetic
body of flat `61 …` records is **rejected** — the firmware parser (`WFManager_Parser`, `0xdb35c`)
requires the body (from offset `0x24`) to start with a `0x20` scene container. The full file is:

```
[0x00,0x24)  header:  perDialId@0 · version=1@4 · name[16]@8 · size_a@0x18 · size_b@0x1c · idWord0@0x20
[0x24, fa)   scene:   20 <u16 L0> ( 21 <u16 L1> ( 86 <len>=name , 30/70/80/81… drawables ) [ 22 … AOD ] )
[fa, EOF)    assets:  [dimsWord u32][len u32][payload = 1f 00 01 00 + LZ4] …
   size_a = filesize−36 · size_b = filesize−36−first_asset · 0x27+L0 == first_asset
```

The scene is a **clean nested TLV** — `[tag u8][len u16 LE][body]`, container tags `0x20/0x21/0x22/0x68`
recursing, leaf drawables `0x30` (static) / `0x70` (element/pointer) / `0x80` / `0x81` / `0x86` (name).
(The flat `61 01 00` / `61 0a 00` records are patterns that live **inside** the drawable bodies; the
old parser found them heuristically — and stitched adjacent bodies together, see the §11.5 revision.
The drawable body layout is now fully decoded there.) Every child's `offset+len` must fit inside its
parent's window;
first body byte ≠ `0x20` → parser error −16; a child overrunning its window → −2; either makes the
`9065` handler (`0xeb50c`) write finish `0a`.

**Builder is implemented and offline-validated** (`core-rust/watchface_struct.rs`:
`SceneNode` / `serialize` / `parse_scene` / `validate_container` / `build_container` /
`build_container_raw`; CLI `cmfwatch-wfgen reframe`):

- `scene_roundtrip_identity` — all **103 store dials**: `parse_scene`→`serialize` reproduces the scene
  **byte-for-byte** (recomputed nested `len`s match) and `validate_container` passes on every one.
- `build_reframe_identity` / CLI `reframe` — reassembling the **whole `.bin` from scratch** reproduces
  the file byte-for-byte **except 1 name-padding byte** (`@0x17`; not a checksum).
- `build_container_synthetic` — composes a **new** dial (background + drawable nested in `20→21`) that
  passes the firmware's exact invariant (`build_container` emits correct nested windows).
- `validate_rejects_bad_containers` — rejects a flat `0x61` body (→ `NotEnvelope`, the historic `0a`
  bug) and a child that overruns its window (→ `ChildOverflow`).

**🟡 Still unproven (needs the watch, non-blocking):** uploading a from-scratch synthetic over `9075`
and watching it render — the offline structural proof already covers what caused the `0a` reject.

### 11.8 Render-fidelity refinements (2026-07-02, dial 275 "SlopeTime")

Cross-referenced the wfweb render against the official store thumbnails (pixel oracle over all 103
dials) and closed four gaps:

- **Drawable/pointer X/Y are `i16` (signed).** ✅ Anchors can be **negative** for elements that
  extend off-canvas — e.g. 275's **red second hand** sits at `Y = 0xFFFC = −4` (a 30×281 sprite,
  source `0x12`, rotated from center off the top edge). Reading X/Y as `u16` (65532) made the
  guard drop it. Parse both as signed and allow a small negative range.
- **Digital clock digits can be top-level `0x60` img_numbers** (not only inside a `0x68` group), and
  the **real data source is the `u8` at record offset `−5`** — the forward `82`-attr scan is
  systematically **off-by-one** here and grabs the *next* sibling's attr (in 275 the minute digit
  picked up the weekday `0x18`). 275's "10:10" = hour `0x07`@X≈306 + min `0x0b`@X≈369 with the `:`
  as an adjacent static between them, each an 11-glyph atlas (`61 0a 00`). ⚠️ When correcting X/Y
  from `−18/−16`, the **write offsets must move too**, or a re-export corrupts those bytes (breaks
  same-footprint → `0a`).
- **Multi-variant complication slots: the active metric is NOT in the `.bin`.** ⚠️ A configurable
  complication is authored as **N `0x68` group nodes stacked at the same `(x,y)`**, each bound to a
  different source (275's two circles: `0x1e/0x6a/0x48/0x24/0x19` per slot — *option/style ids*, not
  the shown metric); the two circles are byte-identical apart from their rect + an instance byte
  (`0x79`/`0x7a`). Which metric shows (STEPS vs KCAL vs …) is **device RAM/config state**, so a
  static preview cannot reproduce it from the file — best-effort only.
- **Edge-anchored inactive complications** (e.g. bpm text at `(446,0)`, seen on 275/302/325/365/375)
  are slots the firmware doesn't draw in the default view — their value can't even fit before the
  canvas edge. Treat as hidden in the preview.

Also: the **official store thumbnails are rendered at 10:10** (classic marketing time), not 10:12 —
matching the oracle time to 10:10 drops mean pixel-diff noticeably. wfweb's parser now round-trips
all 103 dials **byte-exact** (the X/Y write-offset fix above cleared the last mismatches).

### 11.9 AOD-container skip + standalone img_number source (2026-07-03, dial "Gradient")

- **Separate the `0x22` AOD container into its own view.** ✅ The scene walker already skips `0x22`,
  but the flat text/number scan walked the whole `[0x30, firstAsset)` — so it emitted the
  **always-on (AOD) variant** of each element as a normal layer. On "Gradient" the AOD **gray** date
  atlas (offset in `0x22`) drew on top of the **red** normal one. Fix: tag every `0x22` record with
  `layer.aod=true` (with its own dedup set) and let `renderAt(…, aod)` show them **only** in AOD mode
  (normal mode hides `aod` layers; AOD mode hides normal ones; the background is swapped by `setAod`
  and always draws). Net oracle win in normal mode across the corpus (**284: 31%→21%**, +18 others) —
  the AOD variants were overdrawing many dials — and the editor's AOD toggle now shows the real
  dimmed always-on layout (gray complications) instead of the normal ones. (AOD-specific *hands* in
  `0x22` still parse as unpositioned `other` in some dials — a known refinement.)
- **Standalone `0x60` img_number (cnt=10) — source at `−5`, off-by-one forward.** ✅ Same off-by-one
  as §11.8 but for non-clock numbers: "Gradient"'s date sat at **(203,80)** top-center with source
  `0x17`, but the forward `82`-scan grabbed the neighbouring **pointer's** angle getter (`0x0a`) and
  the pointer's position → the number rendered at the pointer's spot with a bogus source. Fix: for a
  `61 0a 00` img_number in a `0x60` wrapper, trust `−5`/`−18`/`−16` when the forward source is
  *impossible for a number* (source-0 or a pointer-angle getter `0x0a/0e/12/70/71/72`) **and** the
  `−18/−16` position is valid & non-zero (the non-zero guard skips group-child digits with `relX=0`).
- **`0x17` = date (day of month), `0x24` = temperature — distinct.** Dial 340 uses **both** (`0x17`
  "Jun 09" and a separate `0x24` temp), so `0x17` is date, not temp. A dial whose watch shows a
  temperature in a `0x17` slot is a user-configured complication (device state), not the file default.

---

## 12. Bulk transfer & OTA details

The transfer table is in §6. Additional confirmed points:

- **AGPS/EPO** ✅: the first written chunk begins with the ASCII header `000000010000…`. The full
  init → `[A05F ↔ 905F]×N` → finish loop was observed on the wire (~892 chunks).
- **Firmware OTA** (`9040`–`9042`, finish `9041`) 🔎: structure mapped; INIT2 payload = version bytes
  (e.g. `0b 00 00 39` = 11.0.0.57). **Not field-tested** (the app disables FW update here). Firmware
  images appear to be **unsigned — integrity is CRC32 only** (no asymmetric signature observed in RE).
- ⚠️ Because OTA and `FACTORY_RESET (009A 0001)` share the authenticated session, a single valid BLE
  auth is enough to wipe or (in principle) brick the watch. Handle with care.

---

## 13. Sensors

✅ Hardware exposed via BLE:

- **Optical PPG** — heart rate (manual/auto/workout/resting), SpO₂, and HRV-derived stress.
- **3-axis accelerometer** — steps, distance, calories, sleep staging, wrist-raise, cadence.
- **GNSS/GPS** (AGPS-assisted) — workout track (`WORKOUT_GPS`) and location push (`GPS_PUSH`).

There is **no barometer/altimeter, compass, gyroscope, or skin/body-temperature sensor**. An internal
NTC thermistor (board/battery temperature) exists but is readable **only** via the AT channel
(`AT GETNTCTEMP`, §14) — the `0155` skin-temp history stream is empty on this SKU.

**Data-widget hijacks** (there is no real complication/data-binding API — see §11.5): the watch's
existing text fields can be repurposed to show glanceable external data. Proven ✅: the weather
**city string** (`WEATHER_SET_1`, e.g. `"BRA 2x1 ARG"` appeared on the widget) and the music
**track/artist** fields; the **contacts** list (20 × name[32]+number[25]) works as a scrollable data
panel. All are pushes, not persistent complications.

---

## 14. AT factory / shell channel (`77d4ff01` / `77d4ff02`)

A separate plain-text AT command channel, independent of the framed protocol. ✅ tested live:

- **Read:** `AT GETSECRET` (16-byte pairing secret), `GETVERSION`, `GETSN`, `GETNAME`, `GETPID`,
  `GETBATLV` (raw mV, e.g. `3853mv`), `GETGSENSOR` (raw accel in g, `X=… Y=… Z=…`),
  `GETNTCTEMP` (°C, internal NTC).
- **Write / actuate:** `AT SETMOTOR=1` (vibrate the motor), `SETHR/SETHRV/SETSPO2=…` (sensor test
  injection), `SETLCDSWITCH/SETGPSSWITCH/SETKEYSWITCH`.

Replies end in `,OK`. `SET*` commands generally execute but may not echo `,OK` over BLE — confirm
case by case.

---

## 15. Firmware-gated / unavailable features (🔎 firmware RE)

Some features are present in the firmware but disabled by SKU/region and are **not reachable from the
phone/BLE** — they need a firmware mod, which is out of scope here:

- **ChatGPT voice** — gate = `ux2sys` feature id `0x9e`, seeded from NVRAM/EFUSE/region at boot; on
  this SKU support flag `908b = 00`. Not influenceable by phone, account, or BLE (confirmed by
  experiment + RE). The app is only a relay; audio goes phone → Nothing cloud.
- **Blood pressure** — a complete subsystem exists in firmware, switched off by SKU/region.
- **Alipay / NFC payment** — full UI present, China-SKU only.
- **Absent in hardware/firmware:** ECG, SOS/emergency, generic NFC.

---

## 16. Complication getter table (🔎 firmware-internal reference)

Not needed to build a BLE client — included for completeness. The firmware's dial renderer binds each
complication slot to a numeric **getter id** (142-entry dispatch table). Selected ids:
`0x07` hour, `0x0a` combined clock angle, `0x0b` minute, `0x0f` second, `0x18` day-of-week,
`0x19` heart rate, `0x1b` battery %, `0x24` temperature, `0x36` steps,
`0x70/0x71/0x72` hour/minute/second hand angle, `0x25–0x27` goal %. Ring/arc complications index a
pre-rendered **frame sheet** (e.g. 50 % = frame 50 of 100), not a per-pixel arc — the frames are baked
into the `.bin` you send (§11.5), so no external RES pack is needed.

---

### Quick-cards (home tiles) — `QUICK_CARD (906D)` ✅

The watch's home tiles. The phone only chooses **which** tiles show and in **what order** — tiles are
rendered by the firmware (no content channel). First payload byte = sub-command: `00` = GET, `01` =
SET; **both use `0x906D`** (`0x906C` is listed but not used — querying it times out). Reply = `A06D`.

> 🛑 Sending a made-up `assemblyId` **wipes the watch's screens** (it accepts the list, can't match
> the ids, shows nothing). Only send ids you **read back** via GET; recover via the official app or a
> factory reset.

**GET reply** ✅: `status(1) ‖ 00 ‖ N(1) ‖ N × group`, group = `tag=01 ‖ K(1) ‖ K×(assemblyId, sportId)`.
Real frame: `01 00 04  01 02 5d00 6100  01 03 1900 2e00 2300  01 03 5c00 0400 5a02  01 03 4800 5100 5300`
= 4 screens / 11 cards (`5a02` = Sport card, sportId 2).

**Slots:** each screen has **4 slots**. A card's type sets its size — `circular`/`square` = 1 slot,
`rectangle` = 2 slots. Validation is pure slot arithmetic (Σ ≤ 4 per screen); no mutually-exclusive
cards. `sportId` is `0` except on Sport cards (87–91). Ids `64` and `95` don't exist.

**`assemblyId` catalog** (each logical type = a contiguous range of 6 style variants `_0`..`_5`;
`0` = empty slot):

| dec | card | dec | card |
|----|----|----|----|
| 0 | empty slot | 49–53,97–98 | Weather |
| 1–6 | Steps | 54–58 | Timer |
| 7–12 | Calories | 59–62 | Breathing |
| 13–18 | Stand | 63,65–67 | Stopwatch |
| 19–24 | Moderate activity | 68–71 | Battery |
| 25–30 | Heart rate | 72–76 | Recents |
| 31–36 | SpO₂ | 77–81 | Contacts |
| 37–42 | Stress | 82–86 | Dial / phone |
| 43–48 | Sleep | 87–91 | Sport (`sportId` ≠ 0) |
| 92 | Music | 93/94/96 | Activity record / PAI / Cycle |

---

*Byte layouts above were reconstructed from the firmware (1.0.0.73), the official APK (3.5.7), and
decrypted live captures against a real device. The reference implementation for this project lives in
`core-rust/src/{commands,frame,crypto,health,session}.rs` (Rust) and the `cmftool/` Python tools
(`pair.py`, `session.py`, `wf_codec.py`, `upload_custom.py`, …).*
