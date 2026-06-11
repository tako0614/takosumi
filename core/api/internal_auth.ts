import {
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS,
  TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
  type TakosumiActorContext,
} from "takosumi-contract/reference/compat";
import {
  verifyTakosumiInternalRequestFromHeaders,
} from "takosumi-contract/internal/rpc";
import {
  InMemoryReplayProtectionStore,
  type ReplayProtectionStore,
} from "../adapters/replay-protection/mod.ts";

/**
 * Optional defense-in-depth hint for callers that cannot infer the workload
 * identity from the signed actor context alone. Route-level authorization only
 * trusts it when it matches a signed actor `serviceId`/`agentId`.
 */
export const TAKOSUMI_WORKLOAD_IDENTITY_ID_HEADER =
  "x-takos-workload-identity-id";

export interface InternalAuthOptions {
  /** Shared internal service secret. Inject from the process env at the host edge. */
  readonly secret?: string;
  readonly clock?: () => Date;
  readonly maxClockSkewMs?: number;
  /**
   * Replay protection store. Defaults to the in-process implementation, which
   * is sufficient because the worker terminates every signed internal request
   * inside one process.
   */
  readonly replayProtectionStore?: ReplayProtectionStore;
}

export type InternalAuthResult =
  | {
    readonly ok: true;
    readonly actor: TakosumiActorContext;
    readonly caller?: string;
    readonly audience?: string;
    readonly capabilities?: readonly string[];
    readonly workloadIdentityId?: string;
  }
  | { readonly ok: false; readonly error: string; readonly status: 401 };

/**
 * Verifies a signed internal API request (opentofu-runner / executor container
 * callbacks). Binds method, path, query, body digest, headers, and actor
 * context, and rejects replayed `request-id`s within the clock-skew window.
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
  const verified = await verifyTakosumiInternalRequestFromHeaders({
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
  actor: TakosumiActorContext,
  headers: Headers,
): string | false | undefined {
  const signedIdentityId = actor.serviceId ?? actor.agentId;
  const hintedIdentityId = headers.get(TAKOSUMI_WORKLOAD_IDENTITY_ID_HEADER) ??
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
  const requestId = headers.get(TAKOSUMI_INTERNAL_REQUEST_ID_HEADER);
  const timestamp = headers.get(TAKOSUMI_INTERNAL_TIMESTAMP_HEADER);
  if (!requestId || !timestamp) return false;
  const issuedAt = Date.parse(timestamp);
  if (!Number.isFinite(issuedAt)) return false;
  const now = options.clock?.().getTime() ?? Date.now();
  const ttl = options.maxClockSkewMs ?? TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS;
  const expiresAt = expiryFrom(issuedAt, ttl);
  const store = options.replayProtectionStore ?? defaultReplayProtectionStore;
  return await store.markSeen({
    namespace: "internal-request",
    requestId,
    timestamp: issuedAt,
    expiresAt,
    seenAt: now,
  });
}

function expiryFrom(issuedAt: number, ttl: number): number {
  return Number.isFinite(ttl) ? issuedAt + ttl : issuedAt + 60_000;
}
