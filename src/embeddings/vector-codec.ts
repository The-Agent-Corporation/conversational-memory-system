/**
 * Float32 BLOB codec for summary vectors (D-03).
 *
 * Vectors are packed into a little-endian Float32 Buffer for storage as a SQLite BLOB
 * (SqliteStore) and unpacked back into a plain number[] on read. InMemoryStore never
 * needs this codec — it holds vectors as number[] directly per D-02.
 */

export function packFloat32Vector(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(vector[index], index * 4);
  }
  return buffer;
}

export function unpackFloat32Vector(bytes: Uint8Array, dimensions: number): number[] {
  const expectedByteLength = dimensions * 4;
  if (bytes.byteLength !== expectedByteLength) {
    throw new Error(
      `unpackFloat32Vector: byte length mismatch — got ${bytes.byteLength} bytes, expected ${expectedByteLength} bytes for ${dimensions} dimensions`
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, expectedByteLength);
  const result = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    result[index] = view.getFloat32(index * 4, true);
  }
  return result;
}
