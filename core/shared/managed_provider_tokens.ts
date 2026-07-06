const MANAGED_PROVIDER_RUN_TOKEN_PREFIX = "takmpt_";
const MANAGED_PROVIDER_RUN_TOKEN_AUDIENCE = "takosumi-cloud-extension";
const MANAGED_PROVIDER_RUN_TOKEN_TYPE = "takosumi-managed-provider-run";
const MANAGED_PROVIDER_RUN_TOKEN_SUBJECT = "takosumi-managed-provider-run";
const MANAGED_PROVIDER_RUN_TOKEN_VERSION = 1;
const MANAGED_PROVIDER_RUN_TOKEN_SIGNATURE_BYTES = 16;
const MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES = 8;
const MANAGED_PROVIDER_RUN_TOKEN_WORKSPACE_BYTES = 8;
const MANAGED_PROVIDER_RUN_TOKEN_INSTALLATION_BYTES = 8;
const MANAGED_PROVIDER_RUN_TOKEN_MIN_TTL_SECONDS = 60;
const MANAGED_PROVIDER_RUN_TOKEN_MAX_TTL_SECONDS = 3600;
const MANAGED_PROVIDER_RUN_TOKEN_DEFAULT_TTL_SECONDS = 900;

const MANAGED_PROVIDER_RUN_TOKEN_FLAG_INSTALLATION = 1 << 0;
const MANAGED_PROVIDER_RUN_TOKEN_SCOPE_WRITE = 1 << 0;
const MANAGED_PROVIDER_RUN_TOKEN_SCOPE_ADMIN = 1 << 1;

export interface CreateManagedProviderRunTokenInput {
  readonly secret: string;
  readonly workspaceId: string;
  readonly installationId?: string;
  readonly connectionId?: string;
  readonly provider?: string;
  readonly providerBaseUrl?: string;
  readonly phase?: string;
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

export interface ManagedProviderRunTokenVerification {
  readonly ok: true;
  readonly payload: ManagedProviderRunTokenPayload;
}

export interface ManagedProviderRunTokenPayload {
  readonly v: 1;
  readonly typ: typeof MANAGED_PROVIDER_RUN_TOKEN_TYPE;
  readonly aud: typeof MANAGED_PROVIDER_RUN_TOKEN_AUDIENCE;
  readonly sub: string;
  readonly workspaceId: string;
  readonly installationId?: string;
  readonly connectionId?: string;
  readonly provider?: string;
  readonly providerBaseUrlHash?: string;
  readonly phase?: string;
  readonly scopes: readonly string[];
  readonly iat: number;
  readonly exp: number;
}

export type ManagedProviderRunTokenVerificationResult =
  | ManagedProviderRunTokenVerification
  | { readonly ok: false; readonly reason: string };

export function managedProviderRunTokenSecret(
  env: Record<string, unknown>,
): string | undefined {
  return (
    stringEnv(env.TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET) ??
    stringEnv(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN)
  );
}

export function isManagedProviderRunToken(token: string): boolean {
  return token.startsWith(MANAGED_PROVIDER_RUN_TOKEN_PREFIX);
}

export async function createManagedProviderRunToken(
  input: CreateManagedProviderRunTokenInput,
): Promise<{
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}> {
  const ttlSeconds = validTtlSeconds(input.ttlSeconds);
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const expSeconds = nowSeconds + ttlSeconds;
  const workspaceBytes = compactHexIdBytes(input.workspaceId, "space");
  if (!workspaceBytes) {
    throw new Error(
      "managed provider run tokens require a compact space_<16-hex> workspace id",
    );
  }
  const installationBytes = input.installationId
    ? compactHexIdBytes(input.installationId, "inst")
    : undefined;
  const routeHashBytes = input.providerBaseUrl
    ? await providerBaseUrlDigestBytes(input.providerBaseUrl)
    : new Uint8Array(MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES);
  const scopes = encodeScopeMask(input.scopes ?? ["write"]);
  const flags = installationBytes
    ? MANAGED_PROVIDER_RUN_TOKEN_FLAG_INSTALLATION
    : 0;
  const payloadLength =
    1 +
    1 +
    MANAGED_PROVIDER_RUN_TOKEN_WORKSPACE_BYTES +
    (installationBytes ? MANAGED_PROVIDER_RUN_TOKEN_INSTALLATION_BYTES : 0) +
    MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES +
    4 +
    1;
  const payload = new Uint8Array(payloadLength);
  let offset = 0;
  payload[offset++] = MANAGED_PROVIDER_RUN_TOKEN_VERSION;
  payload[offset++] = flags;
  payload.set(workspaceBytes, offset);
  offset += MANAGED_PROVIDER_RUN_TOKEN_WORKSPACE_BYTES;
  if (installationBytes) {
    payload.set(installationBytes, offset);
    offset += MANAGED_PROVIDER_RUN_TOKEN_INSTALLATION_BYTES;
  }
  payload.set(routeHashBytes, offset);
  offset += MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES;
  writeUint32(payload, offset, expSeconds);
  offset += 4;
  payload[offset] = scopes;

  const signature = (await hmacSha256Bytes(input.secret, payload)).slice(
    0,
    MANAGED_PROVIDER_RUN_TOKEN_SIGNATURE_BYTES,
  );
  const body = concatBytes(payload, signature);
  return {
    token: `${MANAGED_PROVIDER_RUN_TOKEN_PREFIX}${base64UrlEncodeBytes(body)}`,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

export async function verifyManagedProviderRunToken(
  token: string,
  input: {
    readonly secret: string;
    readonly now?: () => number;
    readonly expectedProviderBaseUrl?: string;
  },
): Promise<ManagedProviderRunTokenVerificationResult> {
  if (!isManagedProviderRunToken(token)) {
    return { ok: false, reason: "not_managed_provider_token" };
  }
  let body: Uint8Array;
  try {
    body = base64UrlDecodeBytes(
      token.slice(MANAGED_PROVIDER_RUN_TOKEN_PREFIX.length),
    );
  } catch {
    return { ok: false, reason: "malformed_managed_provider_token" };
  }
  const headerLength = 1 + 1 + MANAGED_PROVIDER_RUN_TOKEN_WORKSPACE_BYTES;
  const minimumLength =
    headerLength +
    MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES +
    4 +
    1 +
    MANAGED_PROVIDER_RUN_TOKEN_SIGNATURE_BYTES;
  if (body.length < minimumLength) {
    return { ok: false, reason: "malformed_managed_provider_token" };
  }
  const signatureOffset = body.length - MANAGED_PROVIDER_RUN_TOKEN_SIGNATURE_BYTES;
  const payload = body.slice(0, signatureOffset);
  const signature = body.slice(signatureOffset);
  const expectedSignature = (await hmacSha256Bytes(input.secret, payload)).slice(
    0,
    MANAGED_PROVIDER_RUN_TOKEN_SIGNATURE_BYTES,
  );
  if (!constantTimeEqual(signature, expectedSignature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const parsed = await parsePayload(payload, input.expectedProviderBaseUrl);
  if (!parsed.ok) return parsed;
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  if (parsed.payload.exp <= nowSeconds) return { ok: false, reason: "expired" };
  return parsed;
}

async function parsePayload(
  payload: Uint8Array,
  expectedProviderBaseUrl: string | undefined,
): Promise<ManagedProviderRunTokenVerificationResult> {
  let offset = 0;
  if (payload[offset++] !== MANAGED_PROVIDER_RUN_TOKEN_VERSION) {
    return { ok: false, reason: "invalid_payload" };
  }
  const flags = payload[offset++];
  const hasInstallation =
    (flags & MANAGED_PROVIDER_RUN_TOKEN_FLAG_INSTALLATION) !== 0;
  const expectedLength =
    1 +
    1 +
    MANAGED_PROVIDER_RUN_TOKEN_WORKSPACE_BYTES +
    (hasInstallation ? MANAGED_PROVIDER_RUN_TOKEN_INSTALLATION_BYTES : 0) +
    MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES +
    4 +
    1;
  if (payload.length !== expectedLength) {
    return { ok: false, reason: "invalid_payload" };
  }
  const workspaceBytes = payload.slice(
    offset,
    offset + MANAGED_PROVIDER_RUN_TOKEN_WORKSPACE_BYTES,
  );
  offset += MANAGED_PROVIDER_RUN_TOKEN_WORKSPACE_BYTES;
  const installationBytes = hasInstallation
    ? payload.slice(offset, offset + MANAGED_PROVIDER_RUN_TOKEN_INSTALLATION_BYTES)
    : undefined;
  if (installationBytes) offset += MANAGED_PROVIDER_RUN_TOKEN_INSTALLATION_BYTES;
  const routeHashBytes = payload.slice(
    offset,
    offset + MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES,
  );
  offset += MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES;
  const exp = readUint32(payload, offset);
  offset += 4;
  const scopes = decodeScopeMask(payload[offset] ?? 0);

  if (expectedProviderBaseUrl) {
    const expectedRouteHash = await providerBaseUrlDigestBytes(
      expectedProviderBaseUrl,
    );
    if (!constantTimeEqual(routeHashBytes, expectedRouteHash)) {
      return { ok: false, reason: "provider_base_url_mismatch" };
    }
  }

  return {
    ok: true,
    payload: {
      v: 1,
      typ: MANAGED_PROVIDER_RUN_TOKEN_TYPE,
      aud: MANAGED_PROVIDER_RUN_TOKEN_AUDIENCE,
      sub: MANAGED_PROVIDER_RUN_TOKEN_SUBJECT,
      workspaceId: `space_${bytesToHex(workspaceBytes)}`,
      ...(installationBytes
        ? { installationId: `inst_${bytesToHex(installationBytes)}` }
        : {}),
      providerBaseUrlHash: base64UrlEncodeBytes(routeHashBytes),
      scopes,
      iat: Math.max(0, exp - MANAGED_PROVIDER_RUN_TOKEN_DEFAULT_TTL_SECONDS),
      exp,
    },
  };
}

function validTtlSeconds(value: number | undefined): number {
  if (value === undefined) return MANAGED_PROVIDER_RUN_TOKEN_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(value) ||
    value < MANAGED_PROVIDER_RUN_TOKEN_MIN_TTL_SECONDS ||
    value > MANAGED_PROVIDER_RUN_TOKEN_MAX_TTL_SECONDS
  ) {
    return MANAGED_PROVIDER_RUN_TOKEN_DEFAULT_TTL_SECONDS;
  }
  return value;
}

function compactHexIdBytes(
  value: string,
  prefix: "space" | "inst",
): Uint8Array | undefined {
  const match = new RegExp(`^${prefix}_([0-9a-fA-F]{16})$`, "u").exec(value);
  if (!match?.[1]) return undefined;
  return hexToBytes(match[1]);
}

function encodeScopeMask(scopes: readonly string[]): number {
  let out = 0;
  if (scopes.includes("write")) out |= MANAGED_PROVIDER_RUN_TOKEN_SCOPE_WRITE;
  if (scopes.includes("admin")) out |= MANAGED_PROVIDER_RUN_TOKEN_SCOPE_ADMIN;
  return out || MANAGED_PROVIDER_RUN_TOKEN_SCOPE_WRITE;
}

function decodeScopeMask(mask: number): readonly string[] {
  const out: string[] = [];
  if ((mask & MANAGED_PROVIDER_RUN_TOKEN_SCOPE_WRITE) !== 0) out.push("write");
  if ((mask & MANAGED_PROVIDER_RUN_TOKEN_SCOPE_ADMIN) !== 0) out.push("admin");
  return out;
}

function stringEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href.replace(/\/+$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

async function providerBaseUrlDigestBytes(value: string): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      bytesToArrayBuffer(new TextEncoder().encode(normalizeUrl(value))),
    ),
  );
  return digest.slice(0, MANAGED_PROVIDER_RUN_TOKEN_ROUTE_HASH_BYTES);
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

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    ((source[offset] ?? 0) * 0x1000000 +
      ((source[offset + 1] ?? 0) << 16) +
      ((source[offset + 2] ?? 0) << 8) +
      (source[offset + 3] ?? 0)) >>>
    0
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecodeBytes(value: string): Uint8Array {
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
