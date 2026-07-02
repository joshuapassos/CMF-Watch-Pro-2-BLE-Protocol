// I/O de arquivo (browser): ler File → bytes, baixar bytes → arquivo.

export async function readFileBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes.slice()], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Nome de saída no padrão `<id>_<nome>.bin`. */
export function outName(id: number, name: string): string {
  const safe = (name || "dial").replace(/[^\w.-]+/g, "_").slice(0, 40);
  return `${id}_${safe}.bin`;
}
