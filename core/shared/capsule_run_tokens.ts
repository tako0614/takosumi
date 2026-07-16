/**
 * Capsule-scoped run tokens (`takrun_`): the ambient credential a Run's
 * sandbox uses to declare its own Capsule's Interfaces through the public
 * `/v1/interfaces` API (`materializedFrom: capsule_resource`) and to
 * self-report status conditions. Stateless HMAC-SHA256, mirroring
 * `managed_provider_tokens.ts`. The token never carries InterfaceBinding
 * authority — route authorization confines it to its own Capsule.
 */

const CAPSULE_RUN_TOKEN_PREFIX = "takrun_";
const CAPSULE_RUN_TOKEN_FORMAT = "v1";
const CAPSULE_RUN_TOKEN_TYPE = "takosumi-capsule-run";
/**
 * Domain-separation tag folded into the signed bytes. Because a host MAY
 * configure one secret for several token families (capsuleRunTokenSecret falls
 * back to the managed-provider secret), the family tag inside the MAC — not
 * only the payload `typ`/`aud` — is what makes a signature from another family
 * uncomputable here, and vice-versa.
 */
const CAPSULE_RUN_TOKEN_SIGNING_DOMAIN = "takosumi.capsule-run.v1";
const CAPSULE_RUN_TOKEN_VERSION = 1;
const CAPSULE_RUN_TOKEN_MIN_TTL_SECONDS = 60;
const CAPSULE_RUN_TOKEN_MAX_TTL_SECONDS = 7200;
const CAPSULE_RUN_TOKEN_DEFAULT_TTL_SECONDS = 3600;
const CAPSULE_RUN_TOKEN_CLOCK_SKEW_SECONDS = 60;

/** Fixed audience: the shared Interface API surface. */
export const CAPSULE_RUN_TOKEN_AUDIENCE = "takosumi-interfaces";

export interface CreateCapsuleRunTokenInput {
  readonly secret: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  /**
   * Whether the run may mutate its own Interfaces. Only an apply/destroy run
   * grants `true`; a read-only run (plan, drift-check, refresh) grants
   * `false`, so a nominally read-only run cannot create/update/retire specs —
   * it can still read and self-report status. Defaults to `false` (least
   * privilege).
   */
  readonly mutable?: boolean;
  readonly ttlSeconds?: number;
  readonly now?: () => number;
  readonly jti?: string;
}

export interface CapsuleRunTokenPayload {
  readonly v: 1;
  readonly typ: typeof CAPSULE_RUN_TOKEN_TYPE;
  readonly aud: typeof CAPSULE_RUN_TOKEN_AUDIENCE;
  readonly sub: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly mutable: boolean;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type CapsuleRunTokenVerificationResult =
  | { readonly ok: true; readonly payload: CapsuleRunTokenPayload }
  | { readonly ok: false; readonly reason: string };

export interface VerifyCapsuleRunTokenInput {
  readonly secret: string;
  readonly expectedWorkspaceId?: string;
  readonly expectedCapsuleId?: string;
  readonly now?: () => number;
}

export function capsuleRunTokenSecret(
  env: Record<string, unknown>,
): string | undefined {
  // A dedicated secret allows independent rotation; the managed-provider
  // secret is an explicit fallback so a configured host needs no second knob.
  // The signing-domain tag keeps token families from cross-verifying even
  // when a host intentionally reuses one secret.
  return (
    stringEnv(env.TAKOSUMI_RUN_TOKEN_SECRET) ??
    stringEnv(env.TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET)
  );
}

export function isCapsuleRunToken(token: string): boolean {
  return token.startsWith(
    `${CAPSULE_RUN_TOKEN_PREFIX}${CAPSULE_RUN_TOKEN_FORMAT}.`,
  );
}

export async function createCapsuleRunToken(
  input: CreateCapsuleRunTokenInput,
): Promise<{
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}> {
  assertNonEmpty(input.secret, "secret");
  const workspaceId = normalizedClaim(input.workspaceId, "workspaceId");
  const capsuleId = normalizedClaim(input.capsuleId, "capsuleId");
  const runId = normalizedClaim(input.runId, "runId");
  const ttlSeconds = validTtlSeconds(input.ttlSeconds);
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const expSeconds = nowSeconds + ttlSeconds;
  const jti = normalizedClaim(input.jti ?? crypto.randomUUID(), "jti");
  const payload: CapsuleRunTokenPayload = {
    v: CAPSULE_RUN_TOKEN_VERSION,
    typ: CAPSULE_RUN_TOKEN_TYPE,
    aud: CAPSULE_RUN_TOKEN_AUDIENCE,
    sub: `capsule:${capsuleId}`,
    workspaceId,
    capsuleId,
    runId,
    mutable: input.mutable === true,
    iat: nowSeconds,
    exp: expSeconds,
    jti,
  };
  const encodedPayload = base64UrlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signed = `${CAPSULE_RUN_TOKEN_FORMAT}.${encodedPayload}`;
  const signature = await hmacSha256Bytes(
    input.secret,
    new TextEncoder().encode(`${CAPSULE_RUN_TOKEN_SIGNING_DOMAIN}.${signed}`),
  );
  return {
    token: `${CAPSULE_RUN_TOKEN_PREFIX}${signed}.${base64UrlEncodeBytes(signature)}`,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

export async function verifyCapsuleRunToken(
  token: string,
  input: VerifyCapsuleRunTokenInput,
): Promise<CapsuleRunTokenVerificationResult> {
  if (!isCapsuleRunToken(token)) {
    return { ok: false, reason: "not_capsule_run_token" };
  }
  const compact = token.slice(CAPSULE_RUN_TOKEN_PREFIX.length);
  const segments = compact.split(".");
  if (
    segments.length !== 3 ||
    segments[0] !== CAPSULE_RUN_TOKEN_FORMAT ||
    !segments[1] ||
    !segments[2]
  ) {
    return { ok: false, reason: "malformed_capsule_run_token" };
  }
  let presentedSignature: Uint8Array;
  try {
    presentedSignature = base64UrlDecodeBytes(segments[2]);
  } catch {
    return { ok: false, reason: "malformed_capsule_run_token" };
  }
  const signed = `${segments[0]}.${segments[1]}`;
  const expectedSignature = await hmacSha256Bytes(
    input.secret,
    new TextEncoder().encode(`${CAPSULE_RUN_TOKEN_SIGNING_DOMAIN}.${signed}`),
  );
  if (!constantTimeEqual(presentedSignature, expectedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder().decode(base64UrlDecodeBytes(segments[1])),
    ) as unknown;
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
  const payload = parsePayload(raw);
  if (!payload) return { ok: false, reason: "invalid_payload" };

  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  if (payload.iat > nowSeconds + CAPSULE_RUN_TOKEN_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (payload.exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (payload.exp - payload.iat > CAPSULE_RUN_TOKEN_MAX_TTL_SECONDS) {
    return { ok: false, reason: "invalid_lifetime" };
  }
  if (
    input.expectedWorkspaceId !== undefined &&
    payload.workspaceId !== input.expectedWorkspaceId
  ) {
    return { ok: false, reason: "workspace_mismatch" };
  }
  if (
    input.expectedCapsuleId !== undefined &&
    payload.capsuleId !== input.expectedCapsuleId
  ) {
    return { ok: false, reason: "capsule_mismatch" };
  }
  return { ok: true, payload };
}

function parsePayload(value: unknown): CapsuleRunTokenPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.v !== CAPSULE_RUN_TOKEN_VERSION ||
    raw.typ !== CAPSULE_RUN_TOKEN_TYPE ||
    raw.aud !== CAPSULE_RUN_TOKEN_AUDIENCE ||
    !isNonEmptyString(raw.sub) ||
    !isNonEmptyString(raw.workspaceId) ||
    !isNonEmptyString(raw.capsuleId) ||
    !isNonEmptyString(raw.runId) ||
    typeof raw.mutable !== "boolean" ||
    !isNonEmptyString(raw.jti) ||
    !Number.isSafeInteger(raw.iat) ||
    !Number.isSafeInteger(raw.exp) ||
    (raw.iat as number) < 0 ||
    (raw.exp as number) <= (raw.iat as number)
  ) {
    return undefined;
  }
  return {
    v: 1,
    typ: CAPSULE_RUN_TOKEN_TYPE,
    aud: CAPSULE_RUN_TOKEN_AUDIENCE,
    sub: raw.sub,
    workspaceId: raw.workspaceId,
    capsuleId: raw.capsuleId,
    runId: raw.runId,
    mutable: raw.mutable,
    iat: raw.iat as number,
    exp: raw.exp as number,
    jti: raw.jti,
  };
}

function validTtlSeconds(value: number | undefined): number {
  const ttl = value ?? CAPSULE_RUN_TOKEN_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(ttl) ||
    ttl < CAPSULE_RUN_TOKEN_MIN_TTL_SECONDS ||
    ttl > CAPSULE_RUN_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new TypeError(
      `ttlSeconds must be an integer between ${CAPSULE_RUN_TOKEN_MIN_TTL_SECONDS} and ${CAPSULE_RUN_TOKEN_MAX_TTL_SECONDS}`,
    );
  }
  return ttl;
}

function normalizedClaim(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be a non-empty string`);
  return normalized;
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} must be a non-empty string`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringEnv(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

async function hmacSha256Bytes(
  secret: string,
  value: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, bytesToArrayBuffer(value)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let diff = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlDecodeBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value))
    throw new TypeError("invalid base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
