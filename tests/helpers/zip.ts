import { inflateRawSync } from 'node:zlib';

/** Reads one entry from a zip archive via its central directory; stored and deflated entries only. */
export function zipEntry(zip: Buffer, name: string): Buffer | null {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip archive');
  let offset = zip.readUInt32LE(end + 16);
  for (let index = zip.readUInt16LE(end + 10); index > 0; index -= 1) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const skip = nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    if (zip.toString('utf8', offset + 46, offset + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    offset += 46 + skip;
  }
  return null;
}
