export function bytesFromBody(
  body: Uint8Array | string,
): Uint8Array<ArrayBuffer> {
  const source = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body;
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

export async function sha256Digest(
  body: Uint8Array | string,
): Promise<`sha256:${string}`> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(bytesFromBody(body)),
  );
  return `sha256:${toHex(new Uint8Array(hash))}`;
}

export async function stableJsonDigest(value: unknown): Promise<string> {
  return await sha256Digest(new TextEncoder().encode(stableStringify(value)));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",")
  }}`;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function conflict(message: string, details?: Record<string, unknown>): {
  readonly ok: false;
  readonly error: Error & {
    readonly code: "conflict";
    readonly details?: Record<string, unknown>;
  };
} {
  const error = new Error(message) as Error & {
    code: "conflict";
    details?: Record<string, unknown>;
  };
  error.name = "DomainError";
  error.code = "conflict";
  error.details = details;
  return { ok: false, error };
}
