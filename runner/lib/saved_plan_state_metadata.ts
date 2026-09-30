import { createInflateRaw } from "node:zlib";
import { digestBytes } from "./util.ts";
import {
  parseOpenTofuStateMetadata,
  type OpenTofuStateMetadata,
} from "../../core/shared/open-tofu-state-metadata.ts";

// This is a runner-private binary inspection, not a second plan interpreter.
// Only the saved state ZIP member is read. Native OpenTofu still validates all
// semantic plan details and performs its own last-moment state fence.
export const SAVED_PLAN_PREFLIGHT_MAX_BYTES = 64 * 1024 * 1024;
export const SAVED_PLAN_TFSTATE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4096;
const TFSTATE_NAME = new TextEncoder().encode("tfstate");
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function rejected(): never {
  throw new Error("OpenTofu saved Plan metadata preflight rejected");
}

function u16(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 2 > bytes.byteLength) rejected();
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > bytes.byteLength) rejected();
  return (bytes[at]! | (bytes[at + 1]! << 8) |
    (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

function sameName(bytes: Uint8Array, at: number, length: number): boolean {
  return length === TFSTATE_NAME.byteLength &&
    TFSTATE_NAME.every((byte, index) => bytes[at + index] === byte);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC32_TABLE[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function inflateBounded(
  input: Uint8Array,
  expectedSize: number,
): Promise<Uint8Array> {
  const inflater = createInflateRaw();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    inflater.end(input);
    for await (const chunk of inflater) {
      const bytes = new Uint8Array(chunk);
      length += bytes.byteLength;
      if (length > SAVED_PLAN_TFSTATE_MAX_BYTES || length > expectedSize) {
        inflater.destroy();
        rejected();
      }
      chunks.push(bytes);
    }
  } catch {
    rejected();
  }
  if (length !== expectedSize) rejected();
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Inspect one exact, digest-verified saved Plan ZIP without invoking tofu. */
export async function savedPlanStateMetadata(
  archive: Uint8Array,
  expectedDigest: string,
): Promise<OpenTofuStateMetadata> {
  if (archive.byteLength > SAVED_PLAN_PREFLIGHT_MAX_BYTES ||
      !/^sha256:[0-9a-f]{64}$/u.test(expectedDigest) ||
      await digestBytes(archive) !== expectedDigest) rejected();

  // EOCD can be followed only by a bounded ZIP comment. Reject ZIP64 and
  // multi-disk archives rather than interpreting multiple authorities.
  let eocd = -1;
  for (let at = archive.byteLength - 22;
       at >= Math.max(0, archive.byteLength - 22 - 65535); at--) {
    if (u32(archive, at) === 0x06054b50 &&
        at + 22 + u16(archive, at + 20) === archive.byteLength) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0 || u16(archive, eocd + 4) !== 0 ||
      u16(archive, eocd + 6) !== 0) rejected();
  const count = u16(archive, eocd + 10);
  const directorySize = u32(archive, eocd + 12);
  const directoryOffset = u32(archive, eocd + 16);
  if (count === 0 || count > MAX_ZIP_ENTRIES || count === 0xffff ||
      u16(archive, eocd + 8) !== count ||
      directorySize === 0xffffffff || directoryOffset === 0xffffffff ||
      directoryOffset + directorySize !== eocd) rejected();

  let at = directoryOffset;
  let found: Uint8Array | undefined;
  for (let entry = 0; entry < count; entry++) {
    if (at + 46 > eocd || u32(archive, at) !== 0x02014b50) rejected();
    const flags = u16(archive, at + 8);
    const method = u16(archive, at + 10);
    const checksum = u32(archive, at + 16);
    const compressedSize = u32(archive, at + 20);
    const uncompressedSize = u32(archive, at + 24);
    const nameLength = u16(archive, at + 28);
    const extraLength = u16(archive, at + 30);
    const commentLength = u16(archive, at + 32);
    const localOffset = u32(archive, at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || localOffset === 0xffffffff ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      rejected();
    if (sameName(archive, at + 46, nameLength)) {
      if (found || (flags & ~0x808) !== 0 ||
          (method !== 0 && method !== 8) ||
          uncompressedSize > SAVED_PLAN_TFSTATE_MAX_BYTES ||
          localOffset + 30 > directoryOffset ||
          u32(archive, localOffset) !== 0x04034b50 ||
          u16(archive, localOffset + 6) !== flags ||
          u16(archive, localOffset + 8) !== method) rejected();
      const localNameLength = u16(archive, localOffset + 26);
      const localExtraLength = u16(archive, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (!sameName(archive, localOffset + 30, localNameLength) ||
          dataOffset + compressedSize > directoryOffset) rejected();
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      found = method === 0
        ? compressed
        : await inflateBounded(compressed, uncompressedSize);
      if (found.byteLength !== uncompressedSize || crc32(found) !== checksum)
        rejected();
    }
    at = next;
  }
  if (at !== eocd || !found) rejected();
  try {
    return parseOpenTofuStateMetadata(found);
  } catch {
    rejected();
  }
}
