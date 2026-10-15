/**
 * Dormant Hosted-metered local qualification protocol. These are raw CPU
 * observations, never a complete Run measurement or a financial settlement.
 * Cloudflare admission intentionally has no accepted variant in this phase.
 */
export const HOSTED_METERED_PROFILE = "hosted-metered-v1" as const;
export const HOSTED_METERED_MAX_BODY_BYTES = 64 * 1024 * 1024;
export const HOSTED_METERED_MAX_FRAME_BYTES = 90 * 1024 * 1024;
export const HOSTED_METERED_MAX_REQUESTS = 4096;
export const HOSTED_METERED_NONCE_HEADER = "x-takosumi-metered-nonce";
export const HOSTED_METERED_CONTEXT_HEADER = "x-takosumi-metered-context";
export const HOSTED_METERED_SIGNATURE_HEADER = "x-takosumi-metered-signature";

export interface HostedMeteredLocalAdmission {
  readonly kind: "takosumi.hosted-metered-local-admission@v1";
  readonly profile: typeof HOSTED_METERED_PROFILE;
  readonly authority: "local-native-proof";
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly imageDigest: string;
  readonly admissionNonce: string;
  readonly requestBodySha256: string;
}

export interface HostedMeteredContext {
  readonly workspaceId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly imageDigest: string;
  readonly admissionNonce: string;
  readonly requestBodySha256: string;
  readonly bootId: string;
}

const ADMISSION_KEYS = [
  "kind", "profile", "authority", "workspaceId", "runId", "attemptId",
  "imageDigest", "admissionNonce", "requestBodySha256",
] as const;
const CONTEXT_KEYS = [
  "workspaceId", "runId", "attemptId", "imageDigest", "admissionNonce",
  "requestBodySha256", "bootId",
] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export function hostedMeteredExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function parseHostedMeteredLocalAdmission(
  value: unknown,
): HostedMeteredLocalAdmission {
  if (!hostedMeteredExactKeys(value, ADMISSION_KEYS) ||
    value.kind !== "takosumi.hosted-metered-local-admission@v1" ||
    value.profile !== HOSTED_METERED_PROFILE ||
    value.authority !== "local-native-proof" ||
    !validIdentity(value) || !validNonce(value.admissionNonce) ||
    typeof value.requestBodySha256 !== "string" || !DIGEST.test(value.requestBodySha256)) {
    throw new Error("hosted metered admission unavailable");
  }
  return value as unknown as HostedMeteredLocalAdmission;
}

export function hostedMeteredContext(
  admission: HostedMeteredLocalAdmission,
  bootId: string,
): HostedMeteredContext {
  if (!validNonce(bootId)) throw new Error("hosted metered boot unavailable");
  return {
    workspaceId: admission.workspaceId,
    runId: admission.runId,
    attemptId: admission.attemptId,
    imageDigest: admission.imageDigest,
    admissionNonce: admission.admissionNonce,
    requestBodySha256: admission.requestBodySha256,
    bootId,
  };
}

export function parseHostedMeteredContext(value: unknown): HostedMeteredContext {
  if (!hostedMeteredExactKeys(value, CONTEXT_KEYS) || !validIdentity(value) ||
    !validNonce(value.admissionNonce) || !validNonce(value.bootId) ||
    typeof value.requestBodySha256 !== "string" || !DIGEST.test(value.requestBodySha256)) {
    throw new Error("hosted metered context unavailable");
  }
  return value as unknown as HostedMeteredContext;
}

function validIdentity(value: Record<string, unknown>): boolean {
  return [value.workspaceId, value.runId, value.attemptId].every(
    (id) => typeof id === "string" && ID.test(id),
  ) && typeof value.imageDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(value.imageDigest);
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE.test(value);
}

export async function hostedMeteredSha256(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex");
}

function contextTuple(context: HostedMeteredContext): readonly string[] {
  return CONTEXT_KEYS.map((key) => context[key]);
}

export function sameHostedMeteredContext(
  actual: HostedMeteredContext,
  expected: HostedMeteredContext,
): boolean {
  return CONTEXT_KEYS.every((key) => actual[key] === expected[key]);
}

export async function importHostedMeteredKey(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.byteLength !== 32) throw new Error("hosted metered key unavailable");
  return await crypto.subtle.importKey(
    "raw", Uint8Array.from(bytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

async function requestAuthenticationBytes(
  context: HostedMeteredContext,
  nonce: string,
  method: string,
  url: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  if (!validNonce(nonce) || method !== method.toUpperCase()) throw new Error("invalid metered request");
  const parsed = new URL(url);
  return new TextEncoder().encode(JSON.stringify([
    "takosumi.hosted-metered-request@v1", method, parsed.pathname + parsed.search,
    await hostedMeteredSha256(body), ...contextTuple(context), nonce,
  ]));
}

export async function createHostedMeteredRequestHeaders(
  key: CryptoKey,
  context: HostedMeteredContext,
  nonce: string,
  method: string,
  url: string,
  body: Uint8Array,
): Promise<Record<string, string>> {
  const signature = await crypto.subtle.sign(
    "HMAC", key, Uint8Array.from(await requestAuthenticationBytes(context, nonce, method, url, body)),
  );
  return {
    [HOSTED_METERED_NONCE_HEADER]: nonce,
    [HOSTED_METERED_CONTEXT_HEADER]: Buffer.from(JSON.stringify(context)).toString("base64url"),
    [HOSTED_METERED_SIGNATURE_HEADER]: Buffer.from(signature).toString("hex"),
  };
}

/** No replay reservation or other effect occurs in this verifier. */
export async function authenticateHostedMeteredRequest(
  key: CryptoKey,
  expectedContext: HostedMeteredContext,
  request: Request,
  body: Uint8Array,
): Promise<string | null> {
  try {
    const nonce = request.headers.get(HOSTED_METERED_NONCE_HEADER);
    const encoded = request.headers.get(HOSTED_METERED_CONTEXT_HEADER);
    const signature = request.headers.get(HOSTED_METERED_SIGNATURE_HEADER);
    if (!validNonce(nonce) || !encoded || encoded.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/u.test(encoded) || !signature || !DIGEST.test(signature)) return null;
    const raw = Buffer.from(encoded, "base64url");
    if (raw.toString("base64url") !== encoded) return null;
    const context = parseHostedMeteredContext(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
    if (!sameHostedMeteredContext(context, expectedContext)) return null;
    const valid = await crypto.subtle.verify(
      "HMAC", key, Buffer.from(signature, "hex"),
      Uint8Array.from(await requestAuthenticationBytes(context, nonce, request.method, request.url, body)),
    );
    return valid ? nonce : null;
  } catch {
    return null;
  }
}

export async function signHostedMeteredReceipt(key: CryptoKey, receipt: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["takosumi.hosted-metered-cpu-receipt@v1", receipt]));
  return Buffer.from(await crypto.subtle.sign("HMAC", key, bytes)).toString("hex");
}

export interface HostedMeteredRequestFrame {
  readonly kind: "request";
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

export interface HostedMeteredResponseFrame {
  readonly kind: "response";
  readonly id: string;
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** Bounded newline framing; a malformed, partial, or oversized stream fails closed. */
export async function* readHostedMeteredFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      if (pending.length > HOSTED_METERED_MAX_FRAME_BYTES) throw new Error("metered IPC frame exceeds bound");
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line) throw new Error("metered IPC empty frame");
        yield JSON.parse(line) as unknown;
      }
    }
    pending += decoder.decode();
    if (pending.length !== 0) throw new Error("metered IPC incomplete frame");
  } finally {
    reader.releaseLock();
  }
}

export function parseHostedMeteredRequestFrame(value: unknown): HostedMeteredRequestFrame {
  if (!hostedMeteredExactKeys(value, ["kind", "id", "method", "path", "headers", "body"]) ||
    value.kind !== "request" || !validNonce(value.id) || typeof value.method !== "string" ||
    !/^[A-Z]{3,10}$/u.test(value.method) || typeof value.path !== "string" ||
    !value.path.startsWith("/runs/") || value.path.length > 4096 ||
    !validHeaders(value.headers) || !validBase64(value.body)) throw new Error("metered IPC request invalid");
  return value as unknown as HostedMeteredRequestFrame;
}

export function parseHostedMeteredResponseFrame(value: unknown): HostedMeteredResponseFrame {
  if (!hostedMeteredExactKeys(value, ["kind", "id", "status", "headers", "body"]) ||
    value.kind !== "response" || !validNonce(value.id) || !Number.isInteger(value.status) ||
    Number(value.status) < 200 || Number(value.status) > 599 ||
    !validHeaders(value.headers) || !validBase64(value.body)) throw new Error("metered IPC response invalid");
  return value as unknown as HostedMeteredResponseFrame;
}

function validHeaders(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 64 && value.every((entry) =>
    Array.isArray(entry) && entry.length === 2 &&
    entry.every((item) => typeof item === "string" && item.length <= 8192 && !/[\r\n\0]/u.test(item)));
}

function validBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length > Math.ceil(HOSTED_METERED_MAX_BODY_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
