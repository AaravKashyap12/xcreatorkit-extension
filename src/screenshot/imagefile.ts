/**
 * Reads an image's format and pixel size from its header bytes, so a file that would need too much memory is
 * refused before the browser is asked to decode it.
 */
export type ImageHeader = { type: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number };

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 50_000_000;

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** Returns null when the bytes are not a PNG, JPEG or WebP whose size can be read. */
export function readImageHeader(b: Uint8Array): ImageHeader | null {
  if (b.length >= 24 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a && ascii(b, 12, 4) === 'IHDR') {
    return { type: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the marker segments to the first start-of-frame. SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = u16be(b, i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', width: u16be(b, i + 7), height: u16be(b, i + 5) };
      }
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return { type: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: 'image/webp', width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
    }
  }
  return null;
}

/** The reason a file cannot be opened, or null when it is safe to decode. */
export function refuseImage(size: number, header: ImageHeader | null): string | null {
  if (size > MAX_FILE_BYTES) return 'Choose an image smaller than 32 MB.';
  if (!header) return 'Choose a PNG, JPEG or WebP image.';
  const { width, height } = header;
  if (width < 1 || height < 1) return 'This image has no pixels to edit.';
  if (width > MAX_SIDE || height > MAX_SIDE) return `Choose an image no wider or taller than ${MAX_SIDE.toLocaleString('en-US')} px. This one is ${width.toLocaleString('en-US')} × ${height.toLocaleString('en-US')} px.`;
  if (width * height > MAX_PIXELS) return `Choose an image under 50 megapixels. This one is ${Math.round(width * height / 1e6)} megapixels.`;
  return null;
}

/** Checks the header, then decodes. Throws an Error whose message is ready to show. */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  if (file.size > MAX_FILE_BYTES) throw Error(refuseImage(file.size, null)!);
  // JPEG metadata can push the frame header past the first few kilobytes, so read the whole (bounded) file.
  const header = readImageHeader(new Uint8Array(await file.arrayBuffer()));
  const reason = refuseImage(file.size, header);
  if (reason) throw Error(reason);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw Error('This image could not be decoded. Try exporting it again as PNG.'); }
  if (bitmap.width !== header!.width || bitmap.height !== header!.height) {
    // An orientation tag can swap the sides; anything else means the header lied.
    if (bitmap.width !== header!.height || bitmap.height !== header!.width) {
      bitmap.close();
      throw Error('This image could not be decoded. Try exporting it again as PNG.');
    }
  }
  return bitmap;
}
