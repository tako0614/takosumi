import {
  signInternalResponse as signInternalResponseContract,
  TAKOS_INTERNAL_REQUEST_ID_HEADER,
  TAKOS_INTERNAL_SIGNATURE_HEADER,
  TAKOS_INTERNAL_SIGNATURE_MAX_SKEW_MS,
  TAKOS_INTERNAL_TIMESTAMP_HEADER,
  type TakosActorContext,
  verifySignedInternalResponseFromHeaders,
} from "takosumi-contract";
import {
  verifyTakosInternalRequestFromHeaders,
} from "takosumi-contract/internal-rpc";
import {
  InMemoryReplayProtectionStore,
  type ReplayProtectionNamespace,
  type ReplayProtectionStore,
} from "../adapters/replay-protection/mod.ts";

/**
 * Optional defense-in-depth hint for callers that cannot infer the workload
 * identity from the signed actor context alone. Route-level authorization only
 * trusts it when it matches a signed actor `serviceId`/`agentId`.
 */
export const TAKOS_WORKLOAD_IDENTITY_ID_HEADER = "x-takos-workload-identity-id";

export interface InternalAuthOptions {
  /** Shared internal service secret. Inject from the process env at the host edge. */
  readonly secret?: string;
  readonly clock?: () => Date;
  readonly maxClockSkewMs?: number;
  /**
   * Shared replay protection store. When provided, takes precedence over the
   * in-process default. Inject a `SqlReplayProtectionStore` at the host edge
   * to harden distributed deploys against cross-process / cross-pod replay.
   */
  readonly replayProtectionStore?: ReplayProtectionStore;
}

export type InternalAuthResult =
  | {
    readonly ok: true;
    readonly actor: TakosActorContext;
    readonly caller?: string;
    readonly audience?: string;
    readonly capabilities?: readonly string[];
    readonly workloadIdentityId?: string;
  }
  | { readonly ok: false; readonly error: string; readonly status: 401 };

/**
 * Skeleton helper for signed internal API authentication.
 *
 * The current entrypoint still owns live routes. Future routes can call this
 * helper so internal RPC remains bound to method, path, body digest, headers,
 * and actor context instead of re-implementing auth per endpoint.
 */
export async function readInternalAuth(
  request: Request,
  options: InternalAuthOptions,
): Promise<InternalAuthResult> {
  if (!options.secret) {
    return unauthorized("internal service secret missing");
  }

  const body = await request.clone().text();
  const url = new URL(request.url);
  const verified = await verifyTakosInternalRequestFromHeaders({
    method: request.method,
    path: url.pathname,
    query: url.search,
    body,
    secret: options.secret,
    headers: request.headers,
    now: options.clock,
    maxClockSkewMs: options.maxClockSkewMs,
    expectedAudience: "takosumi",
  });
  if (!verified) return unauthorized("invalid internal signature");
  if (!await rememberRequestId(request.headers, options)) {
    return unauthorized("replayed internal request");
  }
  const workloadIdentityId = readSignedWorkloadIdentityId(
    verified.actor,
    request.headers,
  );
  if (workloadIdentityId === false) {
    return unauthorized("workload identity mismatch");
  }
  return {
    ok: true,
    actor: Object.freeze(structuredClone(verified.actor)),
    caller: verified.caller,
    audience: verified.audience,
    capabilities: verified.capabilities,
    ...(workloadIdentityId ? { workloadIdentityId } : {}),
  };
}

function unauthorized(error: string): InternalAuthResult {
  return { ok: false, error, status: 401 };
}

function readSignedWorkloadIdentityId(
  actor: TakosActorContext,
  headers: Headers,
): string | false | undefined {
  const signedIdentityId = actor.serviceId ?? actor.agentId;
  const hintedIdentityId = headers.get(TAKOS_WORKLOAD_IDENTITY_ID_HEADER) ??
    undefined;
  if (
    hintedIdentityId && signedIdentityId &&
    hintedIdentityId !== signedIdentityId
  ) {
    return false;
  }
  return signedIdentityId;
}

const defaultReplayProtectionStore = new InMemoryReplayProtectionStore();

async function rememberRequestId(
  headers: Headers,
  options: InternalAuthOptions,
): Promise<boolean> {
  const requestId = headers.get(TAKOS_INTERNAL_REQUEST_ID_HEADER);
  const timestamp = headers.get(TAKOS_INTERNAL_TIMESTAMP_HEADER);
  if (!requestId || !timestamp) return false;
  const issuedAt = Date.parse(timestamp);
  if (!Number.isFinite(issuedAt)) return false;
  const now = options.clock?.().getTime() ?? Date.now();
  const ttl = options.maxClockSkewMs ?? TAKOS_INTERNAL_SIGNATURE_MAX_SKEW_MS;
  const expiresAt = expiryFrom(issuedAt, ttl);
  return await claimReplayNonce({
    namespace: "internal-request",
    requestId,
    issuedAt,
    expiresAt,
    now,
    replayProtectionStore: options.replayProtectionStore,
  });
}

/**
 * Thrown when an inbound internal RPC response (e.g. Worker -> kernel) fails
 * signature verification. Callers must fail-closed instead of trusting the
 * response payload.
 */
export class SignatureVerificationError extends Error {
  readonly code: string;
  constructor(reason: string) {
    super(`internal response signature verification failed: ${reason}`);
    this.name = "SignatureVerificationError";
    this.code = reason;
  }
}

export interface SignInternalResponseOptions {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: string;
  readonly requestId: string;
  readonly clock?: () => Date;
}

/**
 * Sign an internal RPC response so the caller (typically the kernel) can
 * verify the response did not get tampered with by an intermediate worker
 * surface. Uses the same operator-managed `TAKOS_INTERNAL_API_SECRET`
 * HMAC-SHA256 secret as internal request signing.
 */
export async function signInternalResponse(
  options: SignInternalResponseOptions,
): Promise<Headers> {
  const timestamp = (options.clock?.() ?? new Date()).toISOString();
  const signed = await signInternalResponseContract({
    method: options.method,
    path: options.path,
    status: options.status,
    body: options.body,
    timestamp,
    requestId: options.requestId,
    secret: options.secret,
  });
  return new Headers(signed.headers);
}

export interface VerifyInternalResponseOptions {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly expectedRequestId?: string;
  readonly clock?: () => Date;
  readonly maxClockSkewMs?: number;
  /**
   * Shared replay protection store. When provided, takes precedence over the
   * in-process default. Inject a `SqlReplayProtectionStore` at the host edge
   * to harden distributed deploys against cross-process / cross-pod replay.
   */
  readonly replayProtectionStore?: ReplayProtectionStore;
}

interface ReadResponseBody {
  clone(): Response;
  text(): Promise<string>;
  status: number;
  headers: Headers;
}

/**
 * Verify an internal RPC response signature. Used by the kernel when reading
 * results returned by Cloudflare Worker (or other forwarder) surfaces. Throws
 * `SignatureVerificationError` on any mismatch / missing / stale / replayed
 * signature so callers fail-closed.
 */
export async function verifyInternalResponse(
  response: Response | ReadResponseBody,
  options: VerifyInternalResponseOptions,
): Promise<{ body: string }> {
  if (!options.secret) {
    throw new SignatureVerificationError("internal service secret missing");
  }
  const headers = response.headers;
  const signature = headers.get(TAKOS_INTERNAL_SIGNATURE_HEADER);
  const timestamp = headers.get(TAKOS_INTERNAL_TIMESTAMP_HEADER);
  const requestId = headers.get(TAKOS_INTERNAL_REQUEST_ID_HEADER);
  if (!signature) {
    throw new SignatureVerificationError("missing signature header");
  }
  if (!timestamp) {
    throw new SignatureVerificationError("missing timestamp header");
  }
  if (!requestId) {
    throw new SignatureVerificationError("missing request id header");
  }

  const issuedAt = Date.parse(timestamp);
  if (!Number.isFinite(issuedAt)) {
    throw new SignatureVerificationError("invalid timestamp");
  }
  const skew = options.maxClockSkewMs ?? TAKOS_INTERNAL_SIGNATURE_MAX_SKEW_MS;
  const now = (options.clock?.() ?? new Date()).getTime();
  if (Number.isFinite(skew) && Math.abs(now - issuedAt) > skew) {
    throw new SignatureVerificationError("expired timestamp");
  }
  if (
    options.expectedRequestId && options.expectedRequestId !== requestId
  ) {
    throw new SignatureVerificationError("request id mismatch");
  }

  const body = await response.clone().text();
  const valid = await verifySignedInternalResponseFromHeaders({
    method: options.method,
    path: options.path,
    status: response.status,
    body,
    expectedRequestId: options.expectedRequestId,
    secret: options.secret,
    headers,
    now: options.clock,
    maxClockSkewMs: options.maxClockSkewMs,
  });
  if (!valid) {
    throw new SignatureVerificationError("signature mismatch");
  }
  if (
    !await rememberResponseSignatureId(
      requestId,
      issuedAt,
      now,
      skew,
      options.replayProtectionStore,
    )
  ) {
    throw new SignatureVerificationError("replayed response");
  }
  return { body };
}

async function rememberResponseSignatureId(
  requestId: string,
  issuedAt: number,
  now: number,
  ttl: number,
  replayProtectionStore?: ReplayProtectionStore,
): Promise<boolean> {
  return await claimReplayNonce({
    namespace: "internal-response",
    requestId,
    issuedAt,
    expiresAt: expiryFrom(issuedAt, ttl),
    now,
    replayProtectionStore,
  });
}

async function claimReplayNonce(input: {
  readonly namespace: ReplayProtectionNamespace;
  readonly requestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly now: number;
  readonly replayProtectionStore?: ReplayProtectionStore;
}): Promise<boolean> {
  const store = input.replayProtectionStore ?? defaultReplayProtectionStore;
  return await store.markSeen({
    namespace: input.namespace,
    requestId: input.requestId,
    timestamp: input.issuedAt,
    expiresAt: input.expiresAt,
    seenAt: input.now,
  });
}

function expiryFrom(issuedAt: number, ttl: number): number {
  return Number.isFinite(ttl) ? issuedAt + ttl : issuedAt + 60_000;
}
