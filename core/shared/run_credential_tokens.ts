import { constantTimeEqualsBytes } from "./constant_time.ts";
import type { CapsuleRunCredentialPhase } from "../domains/deploy-control/run_credential_context.ts";

const RUN_CREDENTIAL_TOKEN_PREFIX = "takrct_";
const RUN_CREDENTIAL_TOKEN_FORMAT = "v1";
const RUN_CREDENTIAL_TOKEN_TYPE = "takosumi-run-credential";
const RUN_CREDENTIAL_TOKEN_VERSION = 1;
const RUN_CREDENTIAL_TOKEN_MIN_TTL_SECONDS = 60;
const RUN_CREDENTIAL_TOKEN_MAX_TTL_SECONDS = 3600;
const RUN_CREDENTIAL_TOKEN_DEFAULT_TTL_SECONDS = 900;
const RUN_CREDENTIAL_TOKEN_CLOCK_SKEW_SECONDS = 60;
const RUN_CREDENTIAL_TOKEN_MAX_LENGTH = 32_768;
const RUN_CREDENTIAL_TOKEN_SECRET_MIN_BYTES = 32;
const RUN_CREDENTIAL_TOKEN_SECRET_MAX_BYTES = 4_096;
const RUN_CREDENTIAL_CLAIM_MAX_LENGTH = 2_048;
const RUN_CREDENTIAL_JTI_MAX_LENGTH = 256;
const RUN_CREDENTIAL_SCOPE_MAX_COUNT = 64;
const RUN_CREDENTIAL_SCOPE_MAX_LENGTH = 256;
const RUN_CREDENTIAL_PAYLOAD_KEYS = new Set([
  "v",
  "typ",
  "aud",
  "sub",
  "workspaceId",
  "capsuleId",
  "runId",
  "installingPrincipalId",
  "connectionId",
  "provider",
  "phase",
  "scopes",
  "iat",
  "exp",
  "jti",
]);

export interface CreateRunCredentialTokenInput {
  readonly secret: string;
  readonly audience: string;
  readonly subject: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly installingPrincipalId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly phase: CapsuleRunCredentialPhase;
  readonly scopes: readonly string[];
  readonly ttlSeconds?: number;
  readonly now?: () => number;
  readonly jti?: string;
}

export interface RunCredentialTokenPayload {
  readonly v: 1;
  readonly typ: typeof RUN_CREDENTIAL_TOKEN_TYPE;
  readonly aud: string;
  readonly sub: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly installingPrincipalId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly phase: CapsuleRunCredentialPhase;
  readonly scopes: readonly string[];
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type RunCredentialTokenVerificationResult =
  | { readonly ok: true; readonly payload: RunCredentialTokenPayload }
  | { readonly ok: false; readonly reason: string };

export interface VerifyRunCredentialTokenInput {
  readonly secret: string;
  readonly expectedAudience: string;
  readonly expectedWorkspaceId?: string;
  readonly expectedCapsuleId?: string;
  readonly expectedRunId?: string;
  readonly expectedInstallingPrincipalId?: string;
  readonly expectedConnectionId?: string;
  readonly expectedProvider?: string;
  readonly expectedPhase?: CapsuleRunCredentialPhase;
  readonly expectedSubject?: string;
  readonly requiredScopes?: readonly string[];
  readonly now?: () => number;
}

/** The generic signer secret is the only accepted token authority. */
export function runCredentialTokenSecret(
  env: Record<string, unknown>,
): string | undefined {
  const value = env.TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET;
  return value === undefined
    ? undefined
    : requiredRunCredentialTokenSecret(value);
}

/** Only the bounded generic wire format is recognizable. */
export function isRunCredentialToken(token: string): boolean {
  return (
    boundedTokenEnvelope(token) &&
    token.startsWith(
      `${RUN_CREDENTIAL_TOKEN_PREFIX}${RUN_CREDENTIAL_TOKEN_FORMAT}.`,
    )
  );
}

export async function createRunCredentialToken(
  input: CreateRunCredentialTokenInput,
): Promise<{
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}> {
  requiredRunCredentialTokenSecret(input.secret);
  const payload = createPayload(input);
  const encodedPayload = base64UrlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signed = `${RUN_CREDENTIAL_TOKEN_FORMAT}.${encodedPayload}`;
  const signature = await hmacSha256Bytes(
    input.secret,
    new TextEncoder().encode(signed),
  );
  const token = `${RUN_CREDENTIAL_TOKEN_PREFIX}${signed}.${base64UrlEncodeBytes(signature)}`;
  if (!boundedTokenEnvelope(token)) {
    throw new TypeError("Run credential token exceeds the bounded wire format");
  }
  return {
    token,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    ttlSeconds: payload.exp - payload.iat,
  };
}

export async function verifyRunCredentialToken(
  token: string,
  input: VerifyRunCredentialTokenInput,
): Promise<RunCredentialTokenVerificationResult> {
  requiredRunCredentialTokenSecret(input.secret);
  const tokenFormat = recognizedTokenFormat(token);
  if (!tokenFormat) return { ok: false, reason: "not_run_credential_token" };
  if (!boundedTokenEnvelope(token)) {
    return { ok: false, reason: "malformed_run_credential_token" };
  }
  const compact = token.slice(tokenFormat.prefix.length);
  const segments = compact.split(".");
  if (
    segments.length !== 3 ||
    segments[0] !== RUN_CREDENTIAL_TOKEN_FORMAT ||
    !segments[1] ||
    !segments[2]
  ) {
    return { ok: false, reason: "malformed_run_credential_token" };
  }

  let presentedSignature: Uint8Array;
  try {
    presentedSignature = base64UrlDecodeBytes(segments[2]);
  } catch {
    return { ok: false, reason: "malformed_run_credential_token" };
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
  const payload = parsePayload(raw, tokenFormat.type);
  if (!payload) return { ok: false, reason: "invalid_payload" };

  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  if (payload.iat > nowSeconds + RUN_CREDENTIAL_TOKEN_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (payload.exp <= nowSeconds) return { ok: false, reason: "expired" };
  const lifetimeSeconds = payload.exp - payload.iat;
  if (
    lifetimeSeconds < RUN_CREDENTIAL_TOKEN_MIN_TTL_SECONDS ||
    lifetimeSeconds > RUN_CREDENTIAL_TOKEN_MAX_TTL_SECONDS
  ) {
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
    input.expectedRunId !== undefined &&
    payload.runId !== input.expectedRunId
  ) {
    return { ok: false, reason: "run_mismatch" };
  }
  if (
    input.expectedInstallingPrincipalId !== undefined &&
    payload.installingPrincipalId !== input.expectedInstallingPrincipalId
  ) {
    return { ok: false, reason: "installing_principal_mismatch" };
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

function createPayload(
  input: CreateRunCredentialTokenInput,
): RunCredentialTokenPayload {
  const ttlSeconds = validTtlSeconds(input.ttlSeconds);
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  return {
    v: RUN_CREDENTIAL_TOKEN_VERSION,
    typ: RUN_CREDENTIAL_TOKEN_TYPE,
    aud: normalizedClaim(input.audience, "audience"),
    sub: normalizedClaim(input.subject, "subject"),
    workspaceId: normalizedClaim(input.workspaceId, "workspaceId"),
    capsuleId: normalizedClaim(input.capsuleId, "capsuleId"),
    runId: normalizedClaim(input.runId, "runId"),
    installingPrincipalId: normalizedClaim(
      input.installingPrincipalId,
      "installingPrincipalId",
    ),
    connectionId: normalizedClaim(input.connectionId, "connectionId"),
    provider: normalizedClaim(input.provider, "provider"),
    phase: normalizedPhase(input.phase),
    scopes: normalizedScopes(input.scopes),
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: normalizedClaim(input.jti ?? crypto.randomUUID(), "jti"),
  };
}

function parsePayload(
  value: unknown,
  expectedType: typeof RUN_CREDENTIAL_TOKEN_TYPE,
): RunCredentialTokenPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).length !== RUN_CREDENTIAL_PAYLOAD_KEYS.size ||
    Object.keys(raw).some((key) => !RUN_CREDENTIAL_PAYLOAD_KEYS.has(key)) ||
    raw.v !== RUN_CREDENTIAL_TOKEN_VERSION ||
    raw.typ !== expectedType ||
    !isBoundedExactString(raw.aud, RUN_CREDENTIAL_CLAIM_MAX_LENGTH) ||
    !isBoundedExactString(raw.sub, RUN_CREDENTIAL_CLAIM_MAX_LENGTH) ||
    !isBoundedExactString(raw.workspaceId, RUN_CREDENTIAL_CLAIM_MAX_LENGTH) ||
    !isBoundedExactString(raw.capsuleId, RUN_CREDENTIAL_CLAIM_MAX_LENGTH) ||
    !isBoundedExactString(raw.runId, RUN_CREDENTIAL_CLAIM_MAX_LENGTH) ||
    !isBoundedExactString(
      raw.installingPrincipalId,
      RUN_CREDENTIAL_CLAIM_MAX_LENGTH,
    ) ||
    !isBoundedExactString(raw.connectionId, RUN_CREDENTIAL_CLAIM_MAX_LENGTH) ||
    !isBoundedExactString(raw.provider, RUN_CREDENTIAL_CLAIM_MAX_LENGTH) ||
    !isRunCredentialPhase(raw.phase) ||
    !isBoundedExactString(raw.jti, RUN_CREDENTIAL_JTI_MAX_LENGTH) ||
    !Number.isSafeInteger(raw.iat) ||
    !Number.isSafeInteger(raw.exp) ||
    (raw.iat as number) < 0 ||
    (raw.exp as number) <= (raw.iat as number) ||
    !Array.isArray(raw.scopes) ||
    raw.scopes.length === 0 ||
    raw.scopes.length > RUN_CREDENTIAL_SCOPE_MAX_COUNT ||
    new Set(raw.scopes).size !== raw.scopes.length ||
    raw.scopes.some(
      (scope) =>
        !isBoundedExactString(scope, RUN_CREDENTIAL_SCOPE_MAX_LENGTH),
    )
  ) {
    return undefined;
  }
  return {
    v: 1,
    typ: expectedType,
    aud: raw.aud,
    sub: raw.sub,
    workspaceId: raw.workspaceId,
    capsuleId: raw.capsuleId,
    runId: raw.runId,
    installingPrincipalId: raw.installingPrincipalId,
    connectionId: raw.connectionId,
    provider: raw.provider,
    phase: raw.phase,
    scopes: Object.freeze([...(raw.scopes as string[])]),
    iat: raw.iat as number,
    exp: raw.exp as number,
    jti: raw.jti,
  };
}

function recognizedTokenFormat(token: string):
  | {
      readonly prefix: typeof RUN_CREDENTIAL_TOKEN_PREFIX;
      readonly type: typeof RUN_CREDENTIAL_TOKEN_TYPE;
    }
  | undefined {
  if (
    token.startsWith(
      `${RUN_CREDENTIAL_TOKEN_PREFIX}${RUN_CREDENTIAL_TOKEN_FORMAT}.`,
    )
  ) {
    return {
      prefix: RUN_CREDENTIAL_TOKEN_PREFIX,
      type: RUN_CREDENTIAL_TOKEN_TYPE,
    };
  }
  return undefined;
}

function validTtlSeconds(value: number | undefined): number {
  const ttl = value ?? RUN_CREDENTIAL_TOKEN_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(ttl) ||
    ttl < RUN_CREDENTIAL_TOKEN_MIN_TTL_SECONDS ||
    ttl > RUN_CREDENTIAL_TOKEN_MAX_TTL_SECONDS
  ) {
    throw new TypeError(
      `ttlSeconds must be an integer between ${RUN_CREDENTIAL_TOKEN_MIN_TTL_SECONDS} and ${RUN_CREDENTIAL_TOKEN_MAX_TTL_SECONDS}`,
    );
  }
  return ttl;
}

function normalizedScopes(scopes: readonly string[]): readonly string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > RUN_CREDENTIAL_SCOPE_MAX_COUNT ||
    scopes.some(
      (scope) =>
        !isBoundedExactString(scope, RUN_CREDENTIAL_SCOPE_MAX_LENGTH),
    )
  ) {
    throw new TypeError(
      `scopes must contain 1-${RUN_CREDENTIAL_SCOPE_MAX_COUNT} exact bounded values`,
    );
  }
  return Object.freeze([...new Set(scopes)]);
}

function normalizedPhase(value: string): CapsuleRunCredentialPhase {
  if (!isRunCredentialPhase(value)) {
    throw new TypeError("phase must be plan, apply, or destroy");
  }
  return value;
}

function isRunCredentialPhase(
  value: unknown,
): value is CapsuleRunCredentialPhase {
  return value === "plan" || value === "apply" || value === "destroy";
}

function normalizedClaim(value: string, name: string): string {
  const maxLength = name === "jti"
    ? RUN_CREDENTIAL_JTI_MAX_LENGTH
    : RUN_CREDENTIAL_CLAIM_MAX_LENGTH;
  if (!isBoundedExactString(value, maxLength)) {
    throw new TypeError(`${name} must be one exact bounded non-empty string`);
  }
  return name === "audience" ? normalizeAudience(value) : value;
}

function requiredRunCredentialTokenSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new TypeError("Run credential token secret must be one exact string");
  }
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    byteLength < RUN_CREDENTIAL_TOKEN_SECRET_MIN_BYTES ||
    byteLength > RUN_CREDENTIAL_TOKEN_SECRET_MAX_BYTES
  ) {
    throw new TypeError(
      `Run credential token secret must contain ${RUN_CREDENTIAL_TOKEN_SECRET_MIN_BYTES}-${RUN_CREDENTIAL_TOKEN_SECRET_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function isBoundedExactString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function boundedTokenEnvelope(token: string): boolean {
  return (
    token.length > 0 &&
    token.length <= RUN_CREDENTIAL_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9._-]+$/u.test(token)
  );
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
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("invalid base64url");
  }
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
