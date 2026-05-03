import { conflict, invalidArgument, notFound } from "../../shared/errors.ts";

/**
 * Phase 18.2 (H8) — Takos signed routing token service.
 *
 * Tenant routing currently authenticates the request boundary only when the
 * Cloudflare dispatch namespace forwards the request to the tenant Worker.
 * For external routing surfaces (AWS ALB, GCP HTTP(S) LB, k8s Ingress with
 * cert-manager) the request reaches the tenant Worker / app without the
 * Takos-internal signed actor context, so the auth boundary effectively
 * disappears once the request leaves the routing edge.
 *
 * The routing-token service issues a short-lived HS256 JWT scoped to a
 * `(tenantId, groupId, deploymentId)` triple and rotates it on a fixed
 * cadence (default 1h). The kernel injects the active token as the
 * `TAKOSUMI_ROUTING_TOKEN` env binding when materializing the desired state.
 * Tenant edges (CF dispatch, ALB, GCP LB, k8s Ingress) carry the token in the
 * `X-Takos-Routing-Token` request header so the tenant Worker / app can call
 * back into the kernel (or verify locally with the public secret) before
 * accepting the request.
 *
 * The token is minted with HMAC-SHA256, deliberately matching the existing
 * `paas-contract` internal-API signature primitive so the kernel does not
 * need to ship a separate KMS-backed signer for Phase 18.2. Rotation is
 * implemented by overlapping issue windows: the service stores both the
 * current and previous active token per tenant so verifies during the cutover
 * window do not race against a freshly-rotated key.
 */

export const TAKOSUMI_ROUTING_TOKEN_HEADER = "x-takos-routing-token";

/** Default rotation period: 1 hour. */
export const DEFAULT_ROUTING_TOKEN_ROTATION_MS = 60 * 60 * 1000;

/**
 * Default verification clock skew: 60 seconds. Kept tight to limit replay
 * window after rotation; tenant edges that cannot stay within the window
 * should request a fresh token rather than widening the skew.
 */
export const DEFAULT_ROUTING_TOKEN_CLOCK_SKEW_MS = 60_000;

export interface RoutingTokenScope {
  readonly tenantId: string;
  readonly groupId: string;
  readonly deploymentId: string;
}

export interface RoutingTokenIssueInput extends RoutingTokenScope {
  readonly hostnames?: readonly string[];
}

export interface RoutingTokenRecord {
  readonly token: string;
  readonly scope: RoutingTokenScope;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly hostnames: readonly string[];
}

export interface RoutingTokenVerifyInput {
  readonly token: string;
  /** Optional scope assertion. When provided the verifier rejects tokens whose
   * `(tenantId, groupId, deploymentId)` triple does not match. */
  readonly expectedScope?: Partial<RoutingTokenScope>;
  /**
   * Optional hostname assertion. When provided the verifier rejects tokens
   * that did not include the hostname in the issued scope (case-insensitive).
   */
  readonly expectedHostname?: string;
}

export interface RoutingTokenVerifyResult {
  readonly ok: true;
  readonly scope: RoutingTokenScope;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly hostnames: readonly string[];
  /** True when the token matched the previous (rotated-out) key. */
  readonly fromPrevious: boolean;
}

export interface RoutingTokenServiceOptions {
  /**
   * Operator-managed signing secret. Rotated by configuration; the service
   * keeps the previous secret in memory for the duration of one rotation
   * window so tokens issued just before rotation continue to verify.
   */
  readonly secret: string;
  readonly rotationPeriodMs?: number;
  readonly clock?: () => Date;
  readonly maxClockSkewMs?: number;
  /**
   * Identifier embedded in the JWT `iss` claim. Defaults to
   * `takosumi-routing`.
   */
  readonly issuer?: string;
}

interface ActiveSecret {
  readonly secret: string;
  readonly activatedAt: number;
}

/**
 * Routing token service. Stateless other than the rolling
 * `(current, previous)` secret pair used to keep verification stable across a
 * rotation window.
 */
export class RoutingTokenService {
  readonly #clock: () => Date;
  readonly #rotationPeriodMs: number;
  readonly #maxClockSkewMs: number;
  readonly #issuer: string;
  #current: ActiveSecret;
  #previous?: ActiveSecret;

  constructor(options: RoutingTokenServiceOptions) {
    if (!options.secret || !options.secret.trim()) {
      throw invalidArgument("routing token secret is required");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#rotationPeriodMs = options.rotationPeriodMs ??
      DEFAULT_ROUTING_TOKEN_ROTATION_MS;
    if (
      !Number.isFinite(this.#rotationPeriodMs) || this.#rotationPeriodMs <= 0
    ) {
      throw invalidArgument(
        "rotationPeriodMs must be a positive finite number",
      );
    }
    this.#maxClockSkewMs = options.maxClockSkewMs ??
      DEFAULT_ROUTING_TOKEN_CLOCK_SKEW_MS;
    this.#issuer = options.issuer ?? "takosumi-routing";
    this.#current = {
      secret: options.secret,
      activatedAt: this.#clock().getTime(),
    };
  }

  /**
   * Rotate to a new signing secret. The previously-active secret is retained
   * for one rotation period so tokens already issued continue to verify until
   * they expire.
   */
  rotate(nextSecret: string): void {
    if (!nextSecret || !nextSecret.trim()) {
      throw invalidArgument("rotation secret is required");
    }
    if (nextSecret === this.#current.secret) {
      throw conflict("rotation secret must differ from the current secret");
    }
    this.#previous = this.#current;
    this.#current = {
      secret: nextSecret,
      activatedAt: this.#clock().getTime(),
    };
  }

  /** Active rotation period in ms. Useful for tests / metrics. */
  get rotationPeriodMs(): number {
    return this.#rotationPeriodMs;
  }

  /**
   * Issue a token scoped to the requested deployment. The issued token is
   * cryptographically bound to the tenant / group / deployment triple and to
   * any hostnames carried in the routing edge so a token leaked from one
   * deployment cannot be replayed onto a sibling deployment.
   */
  async issue(input: RoutingTokenIssueInput): Promise<RoutingTokenRecord> {
    assertScope(input);
    const issuedAtDate = this.#clock();
    const issuedAt = issuedAtDate.toISOString();
    const expiresAtMs = issuedAtDate.getTime() + this.#rotationPeriodMs;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const hostnames = canonicalizeHostnames(input.hostnames ?? []);
    const payload: TokenPayload = {
      iss: this.#issuer,
      sub: input.deploymentId,
      tenantId: input.tenantId,
      groupId: input.groupId,
      deploymentId: input.deploymentId,
      hostnames,
      iat: Math.floor(issuedAtDate.getTime() / 1000),
      exp: Math.floor(expiresAtMs / 1000),
    };
    const token = await signToken(this.#current.secret, payload);
    return Object.freeze<RoutingTokenRecord>({
      token,
      scope: Object.freeze({
        tenantId: input.tenantId,
        groupId: input.groupId,
        deploymentId: input.deploymentId,
      }),
      issuedAt,
      expiresAt,
      hostnames,
    });
  }

  /**
   * Verify a token presented at the routing edge. Tries the current secret
   * first, then the previous secret (rotation overlap window). Tokens that
   * pass cryptographic verification but whose scope / hostname do not match
   * the assertion arguments are rejected with `permission_denied` semantics
   * surfaced as `conflict` to keep the public error surface narrow.
   */
  async verify(
    input: RoutingTokenVerifyInput,
  ): Promise<RoutingTokenVerifyResult> {
    if (!input.token || !input.token.trim()) {
      throw invalidArgument("token is required");
    }
    const decoded = await this.#tryVerifyAcrossKeys(input.token);
    if (!decoded) {
      throw notFound("routing token signature did not verify");
    }
    const { payload, fromPrevious } = decoded;
    const nowMs = this.#clock().getTime();
    const expMs = payload.exp * 1000;
    if (Number.isFinite(this.#maxClockSkewMs)) {
      if (nowMs > expMs + this.#maxClockSkewMs) {
        throw conflict("routing token expired", {
          expiresAt: new Date(expMs).toISOString(),
        });
      }
    }
    const expected = input.expectedScope;
    if (expected) {
      if (expected.tenantId && payload.tenantId !== expected.tenantId) {
        throw conflict("routing token tenant mismatch", {
          expected: expected.tenantId,
          actual: payload.tenantId,
        });
      }
      if (expected.groupId && payload.groupId !== expected.groupId) {
        throw conflict("routing token group mismatch", {
          expected: expected.groupId,
          actual: payload.groupId,
        });
      }
      if (
        expected.deploymentId &&
        payload.deploymentId !== expected.deploymentId
      ) {
        throw conflict("routing token deployment mismatch", {
          expected: expected.deploymentId,
          actual: payload.deploymentId,
        });
      }
    }
    if (input.expectedHostname) {
      const requested = canonicalizeHostnames([input.expectedHostname])[0];
      if (!payload.hostnames.includes(requested)) {
        throw conflict("routing token hostname mismatch", {
          expected: requested,
          allowed: payload.hostnames,
        });
      }
    }
    return Object.freeze<RoutingTokenVerifyResult>({
      ok: true,
      scope: Object.freeze({
        tenantId: payload.tenantId,
        groupId: payload.groupId,
        deploymentId: payload.deploymentId,
      }),
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(expMs).toISOString(),
      hostnames: payload.hostnames,
      fromPrevious,
    });
  }

  async #tryVerifyAcrossKeys(
    token: string,
  ): Promise<
    { readonly payload: TokenPayload; readonly fromPrevious: boolean } | null
  > {
    const current = await tryVerifyToken(this.#current.secret, token);
    if (current) return { payload: current, fromPrevious: false };
    if (!this.#previous) return null;
    // Stop honoring the previous secret once a full rotation period has
    // elapsed since rotation. Tokens minted under the previous secret have
    // already passed `exp` by then.
    const elapsed = this.#clock().getTime() - this.#current.activatedAt;
    if (elapsed > this.#rotationPeriodMs) return null;
    const previous = await tryVerifyToken(this.#previous.secret, token);
    if (!previous) return null;
    return { payload: previous, fromPrevious: true };
  }
}

interface TokenPayload {
  readonly iss: string;
  readonly sub: string;
  readonly tenantId: string;
  readonly groupId: string;
  readonly deploymentId: string;
  readonly hostnames: readonly string[];
  readonly iat: number;
  readonly exp: number;
}

function assertScope(input: RoutingTokenScope): void {
  if (!input.tenantId) throw invalidArgument("tenantId is required");
  if (!input.groupId) throw invalidArgument("groupId is required");
  if (!input.deploymentId) {
    throw invalidArgument("deploymentId is required");
  }
}

function canonicalizeHostnames(
  hostnames: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hostnames) {
    if (!raw) continue;
    const normalized = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return Object.freeze(out);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const JWT_HEADER = base64UrlEncode(
  textEncoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
);

async function signToken(
  secret: string,
  payload: TokenPayload,
): Promise<string> {
  const body = base64UrlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signingInput = `${JWT_HEADER}.${body}`;
  const signature = await hmacSha256(secret, signingInput);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function tryVerifyToken(
  secret: string,
  token: string,
): Promise<TokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, bodySegment, signatureSegment] = parts;
  if (headerSegment !== JWT_HEADER) return null;
  const expected = await hmacSha256(secret, `${headerSegment}.${bodySegment}`);
  let presented: Uint8Array;
  try {
    presented = base64UrlDecode(signatureSegment);
  } catch {
    return null;
  }
  if (!timingSafeEqual(new Uint8Array(expected), presented)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(textDecoder.decode(base64UrlDecode(bodySegment)));
  } catch {
    return null;
  }
  if (
    typeof payload.iss !== "string" ||
    typeof payload.tenantId !== "string" ||
    typeof payload.groupId !== "string" ||
    typeof payload.deploymentId !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    !Array.isArray(payload.hostnames)
  ) {
    return null;
  }
  return payload;
}

async function hmacSha256(
  secret: string,
  message: string,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
}

function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  const filled = remainder === 0 ? padded : padded + "=".repeat(4 - remainder);
  const binary = atob(filled);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
