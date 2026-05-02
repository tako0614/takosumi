/**
 * Minimal Google Cloud OAuth 2.0 helper for the `Direct*Lifecycle` classes.
 *
 * The shape-provider layer exposes two ways to authenticate against GCP REST
 * APIs:
 *  1. operator-supplied OAuth bearer token (pre-fetched out-of-band) — happy
 *     path for short-lived deployments / operator scripts;
 *  2. service-account JSON key (`{ client_email, private_key }`) — kernel
 *     mints a self-signed JWT and exchanges it at the token endpoint.
 *
 * The two flows are wrapped behind {@link GcpAccessTokenProvider} so each
 * Direct lifecycle stays simple.
 */

export interface GcpServiceAccountKey {
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

export interface GcpAccessTokenProviderOptions {
  /** Pre-fetched OAuth bearer token. Highest priority if present. */
  readonly bearerToken?: string;
  /** Service-account JSON key text or parsed object. */
  readonly serviceAccountKey?: string | GcpServiceAccountKey;
  /** OAuth scopes; default `https://www.googleapis.com/auth/cloud-platform`. */
  readonly scope?: string;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
}

export class GcpAccessTokenProvider {
  readonly #bearerToken?: string;
  readonly #key?: GcpServiceAccountKey;
  readonly #scope: string;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  #cached?: { token: string; expiresAt: number };

  constructor(options: GcpAccessTokenProviderOptions) {
    this.#bearerToken = options.bearerToken;
    this.#scope = options.scope ??
      "https://www.googleapis.com/auth/cloud-platform";
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? (() => new Date());
    if (options.serviceAccountKey) {
      this.#key = typeof options.serviceAccountKey === "string"
        ? JSON.parse(options.serviceAccountKey) as GcpServiceAccountKey
        : options.serviceAccountKey;
    }
  }

  async getAccessToken(): Promise<string> {
    if (this.#bearerToken) return this.#bearerToken;
    if (!this.#key) {
      throw new Error(
        "GcpAccessTokenProvider requires either bearerToken or serviceAccountKey",
      );
    }
    const now = this.#clock().getTime();
    if (this.#cached && this.#cached.expiresAt > now + 60_000) {
      return this.#cached.token;
    }
    const tokenUri = this.#key.token_uri ??
      "https://oauth2.googleapis.com/token";
    const assertion = await this.#signJwt(this.#key, this.#scope);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const response = await this.#fetch(tokenUri, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `GCP token exchange failed: HTTP ${response.status} ${text}`,
      );
    }
    const json = await response.json() as {
      access_token: string;
      expires_in: number;
    };
    this.#cached = {
      token: json.access_token,
      expiresAt: now + json.expires_in * 1000,
    };
    return json.access_token;
  }

  async #signJwt(
    key: GcpServiceAccountKey,
    scope: string,
  ): Promise<string> {
    const issuedAt = Math.floor(this.#clock().getTime() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claim = {
      iss: key.client_email,
      scope,
      aud: key.token_uri ?? "https://oauth2.googleapis.com/token",
      exp: issuedAt + 3600,
      iat: issuedAt,
    };
    const encodedHeader = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify(header)),
    );
    const encodedClaim = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify(claim)),
    );
    const signingInput = `${encodedHeader}.${encodedClaim}`;
    const cryptoKey = await importPkcs8RsaPrivateKey(key.private_key);
    const signatureBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signingInput),
    );
    const signature = base64UrlEncode(new Uint8Array(signatureBuf));
    return `${signingInput}.${signature}`;
  }
}

async function importPkcs8RsaPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Helper for performing a JSON-bearing GCP REST call with the access token
 * applied. Used by every Direct GCP lifecycle.
 */
export async function gcpJsonFetch<T = unknown>(
  tokens: GcpAccessTokenProvider,
  request: {
    readonly method: string;
    readonly url: string | URL;
    readonly body?: unknown;
    readonly fetch?: typeof fetch;
  },
): Promise<{ status: number; ok: boolean; json: T | undefined; text: string }> {
  const token = await tokens.getAccessToken();
  const fetchImpl = request.fetch ?? fetch;
  const response = await fetchImpl(`${request.url}`, {
    method: request.method,
    headers: {
      "authorization": `Bearer ${token}`,
      ...(request.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      "accept": "application/json",
    },
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  let json: T | undefined;
  if (text) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, ok: response.ok, json, text };
}

export function ensureGcpResponseOk(
  result: { ok: boolean; status: number; text: string },
  context: string,
): void {
  if (result.ok) return;
  throw new Error(
    `${context} failed: HTTP ${result.status}${
      result.text ? `: ${result.text}` : ""
    }`,
  );
}
