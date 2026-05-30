import {
  type ObjectStorageDigest,
  ObjectStorageDigestMismatchError,
} from "./types.ts";

export function objectBodyBytes(
  body: Uint8Array | string,
): Uint8Array<ArrayBuffer> {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  return copy;
}

export async function sha256ObjectDigest(
  body: Uint8Array | string,
): Promise<ObjectStorageDigest> {
  const hash = await crypto.subtle.digest("SHA-256", objectBodyBytes(body));
  return `sha256:${toHex(new Uint8Array(hash))}`;
}

export async function verifyObjectDigest(
  body: Uint8Array | string,
  expectedDigest?: ObjectStorageDigest,
): Promise<ObjectStorageDigest> {
  const actualDigest = await sha256ObjectDigest(body);
  if (expectedDigest !== undefined && expectedDigest !== actualDigest) {
    throw new ObjectStorageDigestMismatchError(expectedDigest, actualDigest);
  }
  return actualDigest;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
