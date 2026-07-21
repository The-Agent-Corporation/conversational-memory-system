import { describe, expect, it } from "vitest";
import { packFloat32Vector, unpackFloat32Vector } from "../../src/embeddings/vector-codec.js";

describe("vector-codec", () => {
  it("round-trips a Float32 vector with exact precision", () => {
    const vector = [0.5, -0.25, 1.75, 0, -3.125, 2.0];
    const packed = packFloat32Vector(vector);
    const unpacked = unpackFloat32Vector(packed, vector.length);
    expect(unpacked).toEqual(vector);
  });

  it("packs into a buffer of length vector.length * 4", () => {
    const vector = [1, 2, 3, 4, 5];
    const packed = packFloat32Vector(vector);
    expect(packed.byteLength).toBe(vector.length * 4);
  });

  it("encodes as little-endian", () => {
    const value = 1.5;
    const packed = packFloat32Vector([value]);
    expect(packed.readFloatLE(0)).toBe(value);
  });

  it("throws when byte length is shorter than dimensions * 4", () => {
    const packed = packFloat32Vector([1, 2, 3]);
    const truncated = packed.subarray(0, packed.byteLength - 4);
    expect(() => unpackFloat32Vector(truncated, 3)).toThrow(/byte length mismatch/);
  });

  it("throws when byte length is longer than dimensions * 4", () => {
    const packed = packFloat32Vector([1, 2, 3]);
    const padded = Buffer.concat([packed, Buffer.alloc(4)]);
    expect(() => unpackFloat32Vector(padded, 3)).toThrow(/byte length mismatch/);
  });

  it("tolerates a Uint8Array sub-view with a non-zero byteOffset", () => {
    const vector = [4.5, -1.25, 0.75];
    const packed = packFloat32Vector(vector);
    const outer = new Uint8Array(8 + packed.byteLength);
    outer.set(packed, 8);
    const view = new Uint8Array(outer.buffer, 8, packed.byteLength);
    expect(unpackFloat32Vector(view, vector.length)).toEqual(vector);
  });
});
