/** Bounded format identification, not a decoder or a guarantee of safe image contents. */
export const QQ_IMAGE_HEADER_BYTES = 64;
export interface QqImageFormat { extension: string; mime: string }

/** Only bytes received through mediaRead select an image suffix/MIME, never peer metadata. */
export function identifyQqImage(header: Buffer, size: number): QqImageFormat {
  const ascii = (start: number, end: number) => header.toString("latin1", start, end);
  if (header.length >= 33 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && header.readUInt32BE(8) === 13 && ascii(12, 16) === "IHDR"
    && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0 && size > 33) {
    return { extension: ".png", mime: "image/png" };
  }
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
    && header[3] >= 0xc0 && header[3] !== 0xd8 && header[3] !== 0xd9 && size > 4) {
    return { extension: ".jpg", mime: "image/jpeg" };
  }
  if (header.length >= 13 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))
    && header.readUInt16LE(6) > 0 && header.readUInt16LE(8) > 0 && size > 13) {
    return { extension: ".gif", mime: "image/gif" };
  }
  if (header.length >= 25 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"
    && header.readUInt32LE(4) + 8 === size && ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16))
    && header.readUInt32LE(16) > 0 && header.readUInt32LE(16) <= size - 20) {
    return { extension: ".webp", mime: "image/webp" };
  }
  if (header.length >= 26 && ascii(0, 2) === "BM" && header.readUInt32LE(2) === size) {
    const dibSize = header.readUInt32LE(14);
    const pixelOffset = header.readUInt32LE(10);
    if ([12, 40, 52, 56, 108, 124].includes(dibSize) && pixelOffset >= 14 + dibSize && pixelOffset < size) {
      return { extension: ".bmp", mime: "image/bmp" };
    }
  }
  // SVG, HTML, executables and unknown formats stay out of the image consumer.
  throw new Error("QQ_MEDIA_UNSUPPORTED_IMAGE");
}
