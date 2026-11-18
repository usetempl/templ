/** Reads a response body up to `max` bytes; null beyond it. A declared
 * Content-Length above `max` is refused before any byte is read. */
export async function readCapped(
  response: Response,
  max: number,
): Promise<Uint8Array | null> {
  if (Number(response.headers.get("Content-Length")) > max) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
