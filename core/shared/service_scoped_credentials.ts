/**
 * Provider-neutral service credential used by Capsule-to-Capsule connections.
 *
 * This is deliberately not a runner token. It is an API-key-like credential
 * embedded by a reviewed OpenTofu plan into a long-lived workload, scoped to a
 * Workspace, consumer Capsule, service audience, prefix, and verb set. A
 * producer signing-key rotation revokes every credential it issued.
 *
 * Wire form: `tksvc_<base64url(JSON payload)>.<base64url(HMAC-SHA256 body)>`
 */

export type ServiceCredentialVerb = "r" | "w" | "d" | "l";

export interface ServiceScopedCredentialPayload {
  readonly v: 1;
  readonly ws: string;
  readonly sub: string;
  readonly pfx: string;
  readonly cap: readonly ServiceCredentialVerb[];
  readonly aud: string;
  readonly iat: number;
}

export type ServiceScopedCredentialVerifyResult =
  | { readonly ok: true; readonly payload: ServiceScopedCredentialPayload }
  | {
      readonly ok: false;
      readonly reason: "format" | "signature" | "payload" | "version";
    };

export const SERVICE_SCOPED_CREDENTIAL_PREFIX = "tksvc_";

export interface MintServiceScopedCredentialInput {
  readonly signingKey: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly prefix: string;
  readonly verbs: readonly ServiceCredentialVerb[];
  readonly audience: string;
  readonly now?: () => number;
}

export async function mintServiceScopedCredential(
  input: MintServiceScopedCredentialInput,
): Promise<{ readonly credential: string; readonly issuedAt: string }> {
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const payload: ServiceScopedCredentialPayload = {
    v: 1,
    ws: input.workspaceId,
    sub: input.capsuleId,
    pfx: input.prefix,
    cap: [...new Set(input.verbs)],
    aud: input.audience,
    iat: nowSeconds,
  };
  const body = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await hmacSha256(input.signingKey, body);
  return {
    credential: `${SERVICE_SCOPED_CREDENTIAL_PREFIX}${body}.${base64UrlEncode(signature)}`,
    issuedAt: new Date(nowSeconds * 1000).toISOString(),
  };
}

export async function verifyServiceScopedCredential(
  signingKey: string,
  credential: string,
  audience: string,
): Promise<ServiceScopedCredentialVerifyResult> {
  if (!credential.startsWith(SERVICE_SCOPED_CREDENTIAL_PREFIX)) {
    return { ok: false, reason: "format" };
  }
  const rest = credential.slice(SERVICE_SCOPED_CREDENTIAL_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1) {
    return { ok: false, reason: "format" };
  }
  const body = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);
  const expected = await hmacSha256(signingKey, body);
  try {
    if (!constantTimeEqual(base64UrlDecode(signature), expected)) {
      return { ok: false, reason: "signature" };
    }
  } catch {
    return { ok: false, reason: "signature" };
  }

  let payload: ServiceScopedCredentialPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(body)),
    ) as ServiceScopedCredentialPayload;
  } catch {
    return { ok: false, reason: "payload" };
  }
  if (
    payload.v !== 1 ||
    payload.aud !== audience ||
    typeof payload.ws !== "string" ||
    payload.ws.length === 0 ||
    typeof payload.sub !== "string" ||
    payload.sub.length === 0 ||
    typeof payload.pfx !== "string" ||
    payload.pfx.length === 0 ||
    !Array.isArray(payload.cap) ||
    typeof payload.iat !== "number"
  ) {
    return { ok: false, reason: "version" };
  }
  return { ok: true, payload };
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
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
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
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
