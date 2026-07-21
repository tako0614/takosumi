import { constantTimeEqualsBytes } from "./constant_time.ts";

const MANAGED_PROVIDER_RUN_TOKEN_PREFIX = "takmpt_";
const MANAGED_PROVIDER_RUN_TOKEN_FORMAT = "v1";
const MANAGED_PROVIDER_RUN_TOKEN_TYPE = "takosumi-provider-run";
const MANAGED_PROVIDER_RUN_TOKEN_VERSION = 1;
const MANAGED_PROVIDER_RUN_TOKEN_MIN_TTL_SECONDS = 60;
const MANAGED_PROVIDER_RUN_TOKEN_MAX_TTL_SECONDS = 3600;
const MANAGED_PROVIDER_RUN_TOKEN_DEFAULT_TTL_SECONDS = 900;
const MANAGED_PROVIDER_RUN_TOKEN_CLOCK_SKEW_SECONDS = 60;

export interface CreateManagedProviderRunTokenInput {
  readonly secret: string;
  /** Exact explicit managed-provider profile declared by the receiving route. */
  readonly audience: string;
  readonly subject?: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly phase: string;
  readonly scopes: readonly string[];
  readonly ttlSeconds?: number;
  readonly now?: () => number;
  readonly jti?: string;
}

export interface ManagedProviderRunTokenVerification {
  readonly ok: true;
  readonly payload: ManagedProviderRunTokenPayload;
}

export interface ManagedProviderRunTokenPayload {
  readonly v: 1;
  readonly typ: typeof MANAGED_PROVIDER_RUN_TOKEN_TYPE;
  readonly aud: string;
  readonly sub: string;
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly phase: string;
  readonly scopes: readonly string[];
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type ManagedProviderRunTokenVerificationResult =
  | ManagedProviderRunTokenVerification
  | { readonly ok: false; readonly reason: string };

export interface VerifyManagedProviderRunTokenInput {
  readonly secret: string;
  /** Exact managed-provider profile; prevents replay to another extension. */
  readonly expectedAudience: string;
  readonly expectedWorkspaceId?: string;
  readonly expectedCapsuleId?: string;
  readonly expectedConnectionId?: string;
  readonly expectedProvider?: string;
  readonly expectedPhase?: string;
  readonly expectedSubject?: string;
  readonly requiredScopes?: readonly string[];
  readonly now?: () => number;
}

export function managedProviderRunTokenSecret(
  env: Record<string, unknown>,
): string | undefined {
  return stringEnv(env.TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET);
}

export function isManagedProviderRunToken(token: string): boolean {
  return token.startsWith(
    `${MANAGED_PROVIDER_RUN_TOKEN_PREFIX}${MANAGED_PROVIDER_RUN_TOKEN_FORMAT}.`,
  );
}

export async function createManagedProviderRunToken(
  input: CreateManagedProviderRunTokenInput,
): Promise<{
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}> {
  assertNonEmpty(input.secret, "secret");
  const audience = normalizedClaim(input.audience, "audience");
  const workspaceId = normalizedClaim(input.workspaceId, "workspaceId");
  const connectionId = normalizedClaim(input.connectionId, "connectionId");
  const provider = normalizedClaim(input.provider, "provider");
  const phase = normalizedClaim(input.phase, "phase");
  const subject = normalizedClaim(
    input.subject ?? `provider-connection:${connectionId}`,
    "subject",
  );
  const capsuleId = optionalNormalizedClaim(input.capsuleId, "capsuleId");
  const scopes = normalizedScopes(input.scopes);
  const ttlSeconds = validTtlSeconds(input.ttlSeconds);
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const expSeconds = nowSeconds + ttlSeconds;
  const jti = normalizedClaim(input.jti ?? crypto.randomUUID(), "jti");
  const payload: ManagedProviderRunTokenPayload = {
    v: MANAGED_PROVIDER_RUN_TOKEN_VERSION,
    typ: MANAGED_PROVIDER_RUN_TOKEN_TYPE,
    aud: audience,
    sub: subject,
    workspaceId,
    ...(capsuleId ? { capsuleId } : {}),
    connectionId,
    provider,
    phase,
    scopes,
    iat: nowSeconds,
    exp: expSeconds,
    jti,
  };
  const encodedPayload = base64UrlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signed = `${MANAGED_PROVIDER_RUN_TOKEN_FORMAT}.${encodedPayload}`;
  const signature = await hmacSha256Bytes(
    input.secret,
    new TextEncoder().encode(signed),
  );
  return {
    token: `${MANAGED_PROVIDER_RUN_TOKEN_PREFIX}${signed}.${base64UrlEncodeBytes(signature)}`,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

export async function verifyManagedProviderRunToken(
  token: string,
  input: VerifyManagedProviderRunTokenInput,
): Promise<ManagedProviderRunTokenVerificationResult> {
  if (!isManagedProviderRunToken(token)) {
    return { ok: false, reason: "not_managed_provider_token" };
  }
  const compact = token.slice(MANAGED_PROVIDER_RUN_TOKEN_PREFIX.length);
  const segments = compact.split(".");
  if (
    segments.length !== 3 ||
    segments[0] !== MANAGED_PROVIDER_RUN_TOKEN_FORMAT ||
    !segments[1] ||
    !segments[2]
  ) {
    return { ok: false, reason: "malformed_managed_provider_token" };
  }
  let presentedSignature: Uint8Array;
  try {
    presentedSignature = base64UrlDecodeBytes(segments[2]);
  } catch {
    return { ok: false, reason: "malformed_managed_provider_token" };
  }
  const signed = `${segments[0]}.${segments[1]}`;
  const expectedSignature = await hmacSha256Bytes(
    input.secret,
    new TextEncoder().encode(signed),
  );
  if (!constantTimeEqualsBytes(presentedSignature, expectedSignature)) {
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
  if (
    payload.iat >
    nowSeconds + MANAGED_PROVIDER_RUN_TOKEN_CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (payload.exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (payload.exp - payload.iat > MANAGED_PROVIDER_RUN_TOKEN_MAX_TTL_SECONDS) {
    return { ok: false, reason: "invalid_lifetime" };
  }
  if (payload.aud !== normalizeAudience(input.expectedAudience)) {
    return { ok: false, reason: "audience_mismatch" };
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
  if (
    input.expectedConnectionId !== undefined &&
    payload.connectionId !== input.expectedConnectionId
  ) {
    return { ok: false, reason: "connection_mismatch" };
  }
  if (
    input.expectedProvider !== undefined &&
    payload.provider !== input.expectedProvider
  ) {
    return { ok: false, reason: "provider_mismatch" };
  }
  if (
    input.expectedPhase !== undefined &&
    payload.phase !== input.expectedPhase
  ) {
    return { ok: false, reason: "phase_mismatch" };
  }
  if (
    input.expectedSubject !== undefined &&
    payload.sub !== input.expectedSubject
  ) {
    return { ok: false, reason: "subject_mismatch" };
  }
  if (input.requiredScopes?.some((scope) => !payload.scopes.includes(scope))) {
    return { ok: false, reason: "scope_mismatch" };
  }
  return { ok: true, payload };
}

function parsePayload(
  value: unknown,
): ManagedProviderRunTokenPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.v !== MANAGED_PROVIDER_RUN_TOKEN_VERSION ||
    raw.typ !== MANAGED_PROVIDER_RUN_TOKEN_TYPE ||
    !isNonEmptyString(raw.aud) ||
    !isNonEmptyString(raw.sub) ||
    !isNonEmptyString(raw.workspaceId) ||
    !isNonEmptyString(raw.connectionId) ||
    !isNonEmptyString(raw.provider) ||
    !isNonEmptyString(raw.phase) ||
    !isNonEmptyString(raw.jti) ||
    !Number.isSafeInteger(raw.iat) ||
    !Number.isSafeInteger(raw.exp) ||
    (raw.iat as number) < 0 ||
    (raw.exp as number) <= (raw.iat as number) ||
    !Array.isArray(raw.scopes) ||
    raw.scopes.length === 0 ||
    raw.scopes.some((scope) => !isNonEmptyString(scope)) ||
    (raw.capsuleId !== undefined && !isNonEmptyString(raw.capsuleId))
  ) {
    return undefined;
  }
  return {
    v: 1,
    typ: MANAGED_PROVIDER_RUN_TOKEN_TYPE,
    aud: raw.aud,
    sub: raw.sub,
    workspaceId: raw.workspaceId,
    ...(isNonEmptyString(raw.capsuleId) ? { capsuleId: raw.capsuleId } : {}),
    connectionId: raw.connectionId,
    provider: raw.provider,
    phase: raw.phase,
    scopes: Object.freeze([...new Set(raw.scopes as string[])]),
    iat: raw.iat as number,
    exp: raw.exp as number,
    jti: raw.jti,
  };
}

function validTtlSeconds(value: number | undefined): number {
  const ttl = value ?? MANAGED_PROVIDER_RUN_TOKEN_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(ttl) ||
    ttl < MANAGED_PROVIDER_RUN_TOKEN_MIN_TTL_SECONDS ||
    ttl > MANAGED_PROVIDER_RUN_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new TypeError(
      `ttlSeconds must be an integer between ${MANAGED_PROVIDER_RUN_TOKEN_MIN_TTL_SECONDS} and ${MANAGED_PROVIDER_RUN_TOKEN_MAX_TTL_SECONDS}`,
    );
  }
  return ttl;
}

function normalizedScopes(scopes: readonly string[]): readonly string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()))];
  if (normalized.length === 0 || normalized.some((scope) => !scope)) {
    throw new TypeError("scopes must contain at least one non-empty value");
  }
  return Object.freeze(normalized);
}

function normalizedClaim(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be a non-empty string`);
  return name === "audience" ? normalizeAudience(normalized) : normalized;
}

function optionalNormalizedClaim(
  value: string | undefined,
  name: string,
): string | undefined {
  return value === undefined ? undefined : normalizedClaim(value, name);
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

function normalizeAudience(value: string): string {
  return value.trim();
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
