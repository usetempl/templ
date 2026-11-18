import { HttpError } from "./common";
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_IMAGE_DIMENSION = 512;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION;
function invalid(): never {
  throw new HttpError(415, "Choose an image and crop it before uploading.");
}
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function chunk(type: string, bytes: Uint8Array) {
  const name = new TextEncoder().encode(type);
  const out = new Uint8Array(bytes.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length);
  out.set(name, 4);
  out.set(bytes, 8);
  view.setUint32(bytes.length + 8, crc32(out.subarray(4, bytes.length + 8)));
  return out;
}
async function transform(bytes: Uint8Array, compress: boolean, limit: number) {
  const source = new Blob([bytes.slice().buffer]).stream();
  const stream = compress
    ? source.pipeThrough(new CompressionStream("deflate"))
    : source.pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        if (compress)
          throw new HttpError(
            413,
            "This image is too large. Try a simpler crop.",
          );
        invalid();
      }
      parts.push(value);
    }
    return concat(parts);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid();
  }
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** Decode a bounded static canvas PNG and emit fresh RGBA pixels without metadata or animation. */
export async function normalizePng(
  bytes: Uint8Array,
  maxBytes: number,
  maxPixels = MAX_IMAGE_PIXELS,
  maxDimension = Math.sqrt(maxPixels),
) {
  if (
    bytes.length > maxBytes ||
    bytes.length < 45 ||
    !signature.every((b, i) => bytes[i] === b)
  )
    invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8,
    width = 0,
    height = 0,
    channels = 0,
    color = 0,
    ended = false;
  const compressed: Uint8Array[] = [];
  let dataEnded = false;
  for (let chunks = 0; offset < bytes.length && chunks < 64; chunks++) {
    if (offset + 12 > bytes.length) invalid();
    const length = view.getUint32(offset);
    if (length > maxBytes || offset + 12 + length > bytes.length) invalid();
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase())
      invalid();
    if (compressed.length && type !== "IDAT") dataEnded = true;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      view.getUint32(offset + 8 + length)
    )
      invalid();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) invalid();
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      color = data[9];
      if (
        !width ||
        !height ||
        width > maxDimension ||
        height > maxDimension ||
        width * height > maxPixels ||
        data[8] !== 8 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        invalid();
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color];
      if (!channels) invalid();
    } else if (type === "IDAT") {
      if (!channels || ended || dataEnded) invalid();
      compressed.push(data);
    } else if (type === "IEND") {
      if (length !== 0 || !compressed.length || offset + 12 !== bytes.length)
        invalid();
      ended = true;
      offset += 12;
      break;
    } else if (
      type === "tRNS" ||
      type === "acTL" ||
      type === "fcTL" ||
      type === "fdAT" ||
      (type.charCodeAt(0) & 32) === 0
    )
      invalid();
    offset += length + 12;
  }
  if (!ended || offset !== bytes.length) invalid();
  const stride = width * channels,
    expected = (stride + 1) * height;
  const raw = await transform(concat(compressed), false, expected);
  if (raw.length !== expected) invalid();
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) invalid();
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x,
        a = x >= channels ? pixels[i - channels] : 0,
        b = y ? pixels[i - stride] : 0,
        c = y && x >= channels ? pixels[i - stride - channels] : 0;
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : paeth(a, b, c);
      pixels[i] = (raw[y * (stride + 1) + x + 1] + prediction) & 255;
    }
  }
  const rgba = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * channels,
        target = y * (width * 4 + 1) + 1 + x * 4,
        grey = color === 0 || color === 4;
      rgba[target] = pixels[source];
      rgba[target + 1] = pixels[source + (grey ? 0 : 1)];
      rgba[target + 2] = pixels[source + (grey ? 0 : 2)];
      rgba[target + 3] =
        color === 4
          ? pixels[source + 1]
          : color === 6
            ? pixels[source + 3]
            : 255;
    }
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const encoded = await transform(rgba, true, maxBytes);
  const result = concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", encoded),
    chunk("IEND", new Uint8Array()),
  ]);
  if (result.length > maxBytes)
    throw new HttpError(413, "This image is too large. Try a simpler crop.");
  return result;
}
