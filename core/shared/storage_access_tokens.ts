/**
 * Storage access tokens — the Takosumi minting side of the `takos-storage`
 * scoped-token contract.
 *
 * The `takos-storage` Worker verifies these tokens with the shared HMAC key it
 * received at install; Takosumi mints one per consumer at bind time, bounded to
 * a key prefix (`pfx`) and a verb set (`cap`). The wire format MUST stay
 * byte-for-byte compatible with `takos-storage/src/token.ts`:
 *
 *   takstor_<base64url(JSON payload)>.<base64url(HMAC-SHA256 over the b64 body)>
 *
 * Kept dependency-free (Web Crypto) so it runs in every host worker.
 */

export type StorageTokenVerb = "r" | "w" | "d" | "l";

export interface StorageAccessTokenPayload {
  readonly v: 1;
  /** Workspace (space) id the grant belongs to. */
  readonly ws: string;
  /** Consumer installation id the token was minted for. */
  readonly sub: string;
  /** Key prefix the token is scoped to. Empty string means whole bucket. */
  readonly pfx: string;
  /** Allowed verbs: read / write / delete / list. */
  readonly cap: readonly StorageTokenVerb[];
  /** Audience — always the storage publication name. */
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

export type StorageAccessTokenVerifyResult =
  | { readonly ok: true; readonly payload: StorageAccessTokenPayload }
  | {
      readonly ok: false;
      readonly reason:
        "format" | "signature" | "payload" | "version" | "expired";
    };

export const STORAGE_ACCESS_TOKEN_PREFIX = "takstor_";
export const STORAGE_ACCESS_TOKEN_AUDIENCE = "takos.storage.workspace";

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const DEFAULT_TTL_SECONDS = 900;

export interface MintStorageAccessTokenInput {
  readonly signingKey: string;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly prefix: string;
  readonly verbs: readonly StorageTokenVerb[];
  readonly ttlSeconds?: number;
  readonly now?: () => number;
}

export async function mintStorageAccessToken(
  input: MintStorageAccessTokenInput,
): Promise<{
  readonly token: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}> {
  const ttlSeconds = clampTtlSeconds(input.ttlSeconds);
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const exp = nowSeconds + ttlSeconds;
  const payload: StorageAccessTokenPayload = {
    v: 1,
    ws: input.workspaceId,
    sub: input.installationId,
    pfx: input.prefix,
    cap: dedupeVerbs(input.verbs),
    aud: STORAGE_ACCESS_TOKEN_AUDIENCE,
    iat: nowSeconds,
    exp,
  };
  const body = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await hmacSha256(input.signingKey, body);
  return {
    token: `${STORAGE_ACCESS_TOKEN_PREFIX}${body}.${base64UrlEncode(signature)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
    ttlSeconds,
  };
}

/** Verify signature, version, audience, and expiry. Mirror of the Worker side; used by tests. */
export async function verifyStorageAccessToken(
  signingKey: string,
  token: string,
  nowSeconds: number,
): Promise<StorageAccessTokenVerifyResult> {
  if (!token.startsWith(STORAGE_ACCESS_TOKEN_PREFIX))
    return { ok: false, reason: "format" };
  const rest = token.slice(STORAGE_ACCESS_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1)
    return { ok: false, reason: "format" };
  const body = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);

  const expected = await hmacSha256(signingKey, body);
  let signatureOk = false;
  try {
    signatureOk = constantTimeEqual(base64UrlDecode(signature), expected);
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (!signatureOk) return { ok: false, reason: "signature" };

  let payload: StorageAccessTokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(body)),
    ) as StorageAccessTokenPayload;
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (
    payload.v !== 1 ||
    payload.aud !== STORAGE_ACCESS_TOKEN_AUDIENCE ||
    !Array.isArray(payload.cap) ||
    typeof payload.pfx !== "string" ||
    payload.pfx.length === 0
  ) {
    return { ok: false, reason: "version" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

/** Maps `takos.storage.workspace` grant scopes (`files:read` / `files:write`) to token verbs. */
export function storageVerbsFromScopes(
  scopes: readonly string[],
): readonly StorageTokenVerb[] {
  const verbs = new Set<StorageTokenVerb>();
  for (const scope of scopes) {
    if (scope === "files:read") {
      verbs.add("r");
      verbs.add("l");
    } else if (scope === "files:write") {
      verbs.add("r");
      verbs.add("w");
      verbs.add("d");
      verbs.add("l");
    }
  }
  // Default to read-only when no recognized scope was requested.
  if (verbs.size === 0) {
    verbs.add("r");
    verbs.add("l");
  }
  return [...verbs];
}

function clampTtlSeconds(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value < MIN_TTL_SECONDS ||
    value > MAX_TTL_SECONDS
  ) {
    return DEFAULT_TTL_SECONDS;
  }
  return value;
}

function dedupeVerbs(
  verbs: readonly StorageTokenVerb[],
): readonly StorageTokenVerb[] {
  return [...new Set(verbs)];
}

async function hmacSha256(
  secret: string,
  body: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  const binary = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < left.byteLength; i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}
