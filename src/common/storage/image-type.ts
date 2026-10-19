// The type of an uploaded photo, read from its first bytes. The file name and the type the app
// sends are never trusted. Only JPG and PNG are accepted.
export type ImageType = 'jpg' | 'png';

export function detectImageType(data: Buffer): ImageType | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= png.length && png.every((byte, i) => data[i] === byte)) return 'png';
  return undefined;
}
