/**
 * Runtime agent (remote) RPC contract — Phase 17B.
 *
 * The kernel ↔ remote runtime-agent JSON / HTTP RPC. A runtime-agent is a
 * lightweight process that runs *inside* the operator-owned tenant cloud
 * (AWS EC2 / GCP Compute / k8s pod / etc.). It pulls work from the kernel,
 * executes long-running provider operations (RDS create, ECS deploy, Cloud
 * SQL provision, ...) using operator-owned credentials, and reports the
 * outcome back via the same RPC.
 *
 * The kernel never reaches a tenant cloud directly. It only:
 *   1. accepts an `enroll` registration from a remote agent,
 *   2. distributes work `lease` records,
 *   3. consumes `heartbeat` and `report` records from the agent.
 *
 * All RPC payloads are JSON-only and avoid `unknown` so they can be cached
 * / replayed deterministically. Timestamps are ISO-8601 strings, durations
 * are integer ms.
 *
 * See:
 *   - {@link RuntimeAgentRegistration} — enrollment
 *   - {@link RuntimeAgentWorkLease} — work lease distribution
 *   - {@link RuntimeAgentHeartbeat} — periodic liveness
 *   - {@link RuntimeAgentReport} — operation result (progress / success / failure)
 *   - {@link RUNTIME_AGENT_RPC_PATHS} — canonical HTTP routes the kernel exposes
 */

import type { JsonObject } from "./types.ts";

/**
 * Canonical HTTP endpoint paths the kernel exposes for runtime-agent RPC.
 *
 * Every path is prefixed with `/api/internal/v1/runtime/agents/` and is signed
 * with the same internal-auth scheme as other internal RPC calls.
 */
export const RUNTIME_AGENT_RPC_PATHS = {
  enroll: "/api/internal/v1/runtime/agents/enroll",
  heartbeat: "/api/internal/v1/runtime/agents/:agentId/heartbeat",
  lease: "/api/internal/v1/runtime/agents/:agentId/leases",
  report: "/api/internal/v1/runtime/agents/:agentId/reports",
  drain: "/api/internal/v1/runtime/agents/:agentId/drain",
  gatewayManifest: "/api/internal/v1/runtime/agents/:agentId/gateway-manifest",
} as const;

/**
 * Header carrying the kernel-trusted Ed25519 signature of the gateway's
 * identity claim on every RPC response. The agent verifies it against the
 * pinned {@link GatewayManifest.pubkey} before trusting the response.
 *
 * The signed payload is the canonical request (method, path, response body
 * SHA-256, response timestamp, and optional request replay binding) — see
 * {@link canonicalGatewayResponse}.
 */
export const TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_HEADER =
  "x-takosumi-gateway-identity-sig";

/**
 * Header carrying the response timestamp the gateway included inside the
 * canonical-response signature payload. Required so the agent can enforce
 * a max clock-skew window on the gateway's identity proof.
 */
export const TAKOSUMI_GATEWAY_IDENTITY_TIMESTAMP_HEADER =
  "x-takosumi-gateway-identity-timestamp";

export const TAKOSUMI_GATEWAY_IDENTITY_REQUEST_ID_HEADER =
  "x-takosumi-gateway-identity-request-id";

export const TAKOSUMI_GATEWAY_IDENTITY_NONCE_HEADER =
  "x-takosumi-gateway-identity-nonce";

export const TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export type RuntimeAgentRpcPath =
  (typeof RUNTIME_AGENT_RPC_PATHS)[keyof typeof RUNTIME_AGENT_RPC_PATHS];

/**
 * Resolve a templated agent path to a concrete path for `agentId`.
 *
 * `RUNTIME_AGENT_RPC_PATHS.heartbeat` → `/api/internal/v1/runtime/agents/agent_1/heartbeat`.
 */
export function resolveRuntimeAgentRpcPath(
  template: RuntimeAgentRpcPath,
  agentId: string,
): string {
  return template.replace(":agentId", encodeURIComponent(agentId));
}

/**
 * Capabilities a runtime-agent exposes at enrollment time. The kernel uses
 * these to filter work leases:
 *
 *   - `providers` is the list of provider plugin ids the agent can execute
 *     (e.g. `aws`, `gcp`, `k8s`). A queued work item without an explicit
 *     provider is leasable by any agent.
 *   - `maxConcurrentLeases` (optional) caps in-flight leases per agent. The
 *     kernel never grants more than this many active leases at once.
 *   - `labels` are operator-defined tags (region, instance class, ...) used
 *     for routing.
 */
export interface RuntimeAgentCapabilitiesPayload {
  readonly providers: readonly string[];
  readonly maxConcurrentLeases?: number;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * `POST /api/internal/v1/runtime/agents/enroll` — registration request.
 *
 * The agent supplies a host-key digest so the kernel can detect impersonation
 * across re-enrollments (the same `agentId` must always present the same
 * digest; mismatch ⇒ kernel revokes the prior identity and refuses the
 * enrollment until operator intervention).
 */
export interface RuntimeAgentRegistration {
  /** Agent identifier — stable across restarts of the same process. */
  readonly agentId: string;
  /** Provider this agent primarily serves. */
  readonly provider: string;
  /** Optional public callback URL the kernel could later push work to. */
  readonly endpoint?: string;
  readonly capabilities: RuntimeAgentCapabilitiesPayload;
  /**
   * SHA-256 hex digest of the agent's host key (long-lived per machine).
   * Used to detect impersonation across re-enrollments. Optional during
   * Phase 17B; required once mTLS gateway is in place.
   */
  readonly hostKeyDigest?: string;
  /** Agent runtime metadata (binary version, region, az, ...). */
  readonly metadata?: JsonObject;
  /** Wall-clock timestamp the agent considered itself enrolled at. */
  readonly enrolledAt?: string;
}

/** `201 Created` envelope returned on successful enrollment. */
export interface RuntimeAgentRegistrationResponse {
  readonly agent: {
    readonly id: string;
    readonly provider: string;
    readonly status: "ready" | "draining" | "registered";
    readonly registeredAt: string;
    readonly lastHeartbeatAt: string;
    readonly capabilities: RuntimeAgentCapabilitiesPayload;
  };
  /**
   * Renew window in ms — the agent must heartbeat at least this often or it
   * will be marked `expired` by the kernel and have its leases revoked.
   */
  readonly renewAfterMs: number;
}

/**
 * `POST /api/internal/v1/runtime/agents/:agentId/heartbeat` — periodic
 * liveness ping. Carries lightweight TTL metadata so the kernel can detect
 * stale agents without a long-poll connection.
 */
export interface RuntimeAgentHeartbeat {
  readonly agentId: string;
  /** Optional diagnostic wall-clock timestamp at the agent; liveness uses kernel time. */
  readonly heartbeatAt?: string;
  /** Optional new status — agent can voluntarily drain. */
  readonly status?: "ready" | "draining";
  /** Total leases currently held by the agent. */
  readonly inFlightLeases?: number;
  /**
   * Suggested TTL in ms. The kernel treats this as advisory only and caps
   * the effective heartbeat/lease window.
   */
  readonly ttlMs?: number;
  readonly metadata?: JsonObject;
}

export interface RuntimeAgentHeartbeatResponse {
  readonly agent: {
    readonly id: string;
    readonly status: "ready" | "draining" | "revoked" | "expired";
    readonly lastHeartbeatAt: string;
  };
  /** Effective TTL the kernel granted. Heartbeat before this elapses. */
  readonly renewAfterMs: number;
}

/**
 * `POST /api/internal/v1/runtime/agents/:agentId/leases` — work lease pull.
 *
 * The kernel responds with at most one lease. If no work is available,
 * `lease` is `null` and the agent retries after a short backoff.
 */
export interface RuntimeAgentLeaseRequest {
  readonly agentId: string;
  /** Requested lease TTL in ms; the kernel caps this if too long. */
  readonly leaseTtlMs?: number;
  /** Optional diagnostic wall-clock at agent; lease timestamps use kernel time. */
  readonly now?: string;
}

/**
 * Work item shape carried inside a lease. Mirrors the kernel's
 * `RuntimeAgentWorkItem` projection but with the JSON-safe fields the agent
 * needs.
 */
export interface RuntimeAgentWorkPayload {
  readonly id: string;
  readonly kind: string;
  readonly provider?: string;
  readonly priority: number;
  readonly attempts: number;
  readonly payload: JsonObject;
  readonly metadata: JsonObject;
  readonly queuedAt: string;
}

export interface RuntimeAgentWorkLease {
  readonly id: string;
  readonly workId: string;
  readonly agentId: string;
  readonly leasedAt: string;
  readonly expiresAt: string;
  /**
   * Suggested time after which the agent should send a `progress` report or
   * renew its lease. Allows long-running provider ops to extend their lease
   * mid-execution without losing it.
   */
  readonly renewAfter: string;
  readonly work: RuntimeAgentWorkPayload;
}

export type RuntimeAgentLeaseResponse = {
  readonly lease: RuntimeAgentWorkLease | null;
};

/**
 * `POST /api/internal/v1/runtime/agents/:agentId/reports` — operation result.
 *
 * A single endpoint covers all three flavours via `status`:
 *   - `progress` — operation still in flight; carries renewed lease window
 *     and optional structured progress (e.g. `{ stage: "rds.creating" }`).
 *   - `completed` — terminal success. Carries `result` payload.
 *   - `failed` — terminal failure. Carries `reason` and optional `retry`
 *     flag; the kernel re-queues the work if `retry === true`.
 */
export type RuntimeAgentReportStatus =
  | "progress"
  | "completed"
  | "failed";

export interface RuntimeAgentReportBase {
  readonly agentId: string;
  readonly leaseId: string;
  readonly reportedAt?: string;
}

export interface RuntimeAgentProgressReport extends RuntimeAgentReportBase {
  readonly status: "progress";
  /** Optional structured progress (stage, percent, condition snapshot, ...). */
  readonly progress?: JsonObject;
  /** Suggested new expiry; the kernel caps it relative to kernel receipt time. */
  readonly extendUntil?: string;
}

export interface RuntimeAgentCompletedReport extends RuntimeAgentReportBase {
  readonly status: "completed";
  readonly completedAt?: string;
  /** Operation result payload — typically a `ProviderOperation` JSON. */
  readonly result?: JsonObject;
}

export interface RuntimeAgentFailedReport extends RuntimeAgentReportBase {
  readonly status: "failed";
  readonly reason: string;
  /** Whether the kernel should re-queue this work item. */
  readonly retry?: boolean;
  readonly failedAt?: string;
  readonly result?: JsonObject;
}

export type RuntimeAgentReport =
  | RuntimeAgentProgressReport
  | RuntimeAgentCompletedReport
  | RuntimeAgentFailedReport;

export interface RuntimeAgentReportResponse {
  readonly work: {
    readonly id: string;
    readonly status: "queued" | "leased" | "completed" | "failed" | "cancelled";
    readonly leaseId?: string;
    readonly leaseExpiresAt?: string;
    readonly attempts: number;
  };
}

/**
 * `POST /api/internal/v1/runtime/agents/:agentId/drain` — operator-initiated
 * drain. The agent is allowed to finish its current leases but will not be
 * granted new ones. Kernel caller signs the request as usual.
 */
export interface RuntimeAgentDrainRequest {
  readonly agentId: string;
  readonly drainRequestedAt?: string;
  readonly reason?: string;
}

/**
 * Signed claim that binds a gateway URL to a kernel-trusted Ed25519 public
 * key. The runtime-agent fetches this manifest from the kernel at startup
 * (via {@link RUNTIME_AGENT_RPC_PATHS.gatewayManifest}) and pins
 * `gatewayUrl` + `pubkey` for the lifetime of the agent process.
 *
 * Why: an operator-injected gateway URL (`https://aws-gateway.example.com`)
 * is otherwise un-authenticated. A malicious operator that controls
 * deployment configuration can swap the URL for an attacker-owned host,
 * harvest signed RPC requests, and then forward them to the real kernel —
 * stealing whatever credentials the agent later signs with.
 *
 * The manifest closes that gap: the kernel's control plane signs the
 * manifest with a **kernel-trusted Ed25519 key** the agent learns out-of-
 * band (operator bootstrap secret), so the agent can detect tampering and
 * fail-closed before it enrolls.
 *
 * Each subsequent RPC response carries an Ed25519 signature in
 * {@link TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_HEADER} that the agent verifies
 * against the pinned `pubkey`. The signed payload is
 * `canonicalGatewayResponse({ method, path, bodySha256, timestamp, requestId, nonce })`.
 *
 * @see verifyGatewayManifest
 * @see verifyGatewayResponseSignature
 */
export interface GatewayManifest {
  /** The exact gateway base URL the agent must talk to. */
  readonly gatewayUrl: string;
  /** Logical id of the operator control plane that issued the manifest. */
  readonly issuer: string;
  /** Agent the manifest was issued for. */
  readonly agentId: string;
  /** ISO-8601 timestamp the manifest was signed at. */
  readonly issuedAt: string;
  /** ISO-8601 timestamp after which the manifest is invalid. */
  readonly expiresAt: string;
  /**
   * Provider plugin kinds the gateway is allowed to broker for. The agent
   * will refuse to lease work whose `provider` is not in this list.
   */
  readonly allowedProviderKinds: readonly string[];
  /** Base64 (raw, no padding stripped) Ed25519 public key. */
  readonly pubkey: string;
  /** Hex-encoded SHA-256 of `pubkey`. */
  readonly pubkeyFingerprint: string;
  /**
   * Optional cert pinning — base64-encoded SHA-256 of the gateway TLS leaf
   * certificate's `SubjectPublicKeyInfo`. When present the agent must verify
   * the connection peer matches.
   */
  readonly tlsPubkeySha256?: string;
}

/**
 * Envelope the kernel returns to the agent's `gateway-manifest` RPC. The
 * `signature` is `Ed25519(bytes(JSON.stringify(manifest, sortKeys)))` using
 * the kernel-trusted private key.
 */
export interface SignedGatewayManifest {
  readonly manifest: GatewayManifest;
  /** Base64-encoded Ed25519 signature over `canonicalGatewayManifest()`. */
  readonly signature: string;
}

const textEncoder = /* @__PURE__ */ new TextEncoder();

/**
 * Canonical bytes for the manifest signature. We sort top-level keys so the
 * signing input is deterministic regardless of JSON serialiser quirks.
 */
export function canonicalGatewayManifest(
  manifest: GatewayManifest,
): Uint8Array {
  const sorted: Record<string, unknown> = {};
  for (
    const [key, value] of Object.entries(manifest).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  ) {
    sorted[key] = value;
  }
  return textEncoder.encode(JSON.stringify(sorted));
}

/**
 * Canonical bytes for a per-RPC response identity signature. Includes the
 * response timestamp so a captured signature cannot be replayed against a
 * different request later.
 */
export function canonicalGatewayResponse(input: {
  readonly method: string;
  readonly path: string;
  readonly bodySha256: string;
  readonly timestamp: string;
  readonly requestId: string;
  readonly nonce: string;
}): Uint8Array {
  return textEncoder.encode(
    [
      "takosumi-gateway-identity",
      input.method.toUpperCase(),
      input.path,
      input.timestamp,
      input.requestId,
      input.nonce,
      input.bodySha256,
    ].join("\n"),
  );
}

export interface VerifyGatewayManifestInput {
  readonly signed: SignedGatewayManifest;
  /** Base64-encoded Ed25519 public key that must verify the signature. */
  readonly trustedPubkey: string;
  /** Expected gateway URL — typically the URL the operator injected. */
  readonly expectedGatewayUrl: string;
  readonly expectedAgentId?: string;
  readonly expectedProviderKind?: string;
  readonly now?: () => Date;
}

export type GatewayManifestVerification =
  | { readonly ok: true; readonly manifest: GatewayManifest }
  | { readonly ok: false; readonly reason: string };

export async function verifyGatewayManifest(
  input: VerifyGatewayManifestInput,
): Promise<GatewayManifestVerification> {
  const { signed, trustedPubkey, expectedGatewayUrl } = input;
  const manifest = signed.manifest;
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, reason: "missing manifest" };
  }
  if (manifest.gatewayUrl !== expectedGatewayUrl) {
    return { ok: false, reason: "gateway url mismatch" };
  }
  if (input.expectedAgentId && manifest.agentId !== input.expectedAgentId) {
    return { ok: false, reason: "agent id mismatch" };
  }
  if (
    input.expectedProviderKind &&
    !manifest.allowedProviderKinds.includes(input.expectedProviderKind)
  ) {
    return { ok: false, reason: "provider kind not allowed" };
  }
  const issuedAt = Date.parse(manifest.issuedAt);
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: "invalid manifest timestamps" };
  }
  const now = (input.now?.() ?? new Date()).getTime();
  if (now > expiresAt) {
    return { ok: false, reason: "manifest expired" };
  }
  if (now + TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_MAX_SKEW_MS < issuedAt) {
    return { ok: false, reason: "manifest not yet valid" };
  }
  // Verify the manifest's pubkeyFingerprint really hashes its pubkey — this
  // prevents an attacker mixing keys / fingerprints across manifests.
  const computedFingerprint = await sha256Hex(
    base64ToBytes(manifest.pubkey),
  );
  if (computedFingerprint !== manifest.pubkeyFingerprint) {
    return { ok: false, reason: "pubkey fingerprint mismatch" };
  }
  const trusted = await importEd25519PublicKey(trustedPubkey);
  const signatureBytes = base64ToBytes(signed.signature);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    trusted,
    toArrayBuffer(signatureBytes),
    toArrayBuffer(canonicalGatewayManifest(manifest)),
  );
  if (!valid) return { ok: false, reason: "manifest signature invalid" };
  return { ok: true, manifest };
}

export interface VerifyGatewayResponseSignatureInput {
  readonly manifest: GatewayManifest;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly signature: string;
  readonly timestamp: string;
  readonly requestId: string;
  readonly nonce: string;
  readonly now?: () => Date;
  readonly maxClockSkewMs?: number;
}

export async function verifyGatewayResponseSignature(
  input: VerifyGatewayResponseSignatureInput,
): Promise<boolean> {
  const skew = input.maxClockSkewMs ??
    TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_MAX_SKEW_MS;
  const parsed = Date.parse(input.timestamp);
  if (!Number.isFinite(parsed)) return false;
  const now = (input.now?.() ?? new Date()).getTime();
  if (Math.abs(now - parsed) > skew) return false;
  const bodySha = await sha256Hex(textEncoder.encode(input.body));
  const key = await importEd25519PublicKey(input.manifest.pubkey);
  const sig = base64ToBytes(input.signature);
  return await crypto.subtle.verify(
    "Ed25519",
    key,
    toArrayBuffer(sig),
    toArrayBuffer(
      canonicalGatewayResponse({
        method: input.method,
        path: input.path,
        bodySha256: bodySha,
        timestamp: input.timestamp,
        requestId: input.requestId,
        nonce: input.nonce,
      }),
    ),
  );
}

/**
 * Sign a per-RPC gateway-identity response signature on the gateway side.
 * The kernel uses this when forwarding a response to a runtime agent.
 */
export async function signGatewayResponse(input: {
  readonly privateKey: CryptoKey;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: string;
  readonly requestId: string;
  readonly nonce: string;
}): Promise<string> {
  const bodySha = await sha256Hex(textEncoder.encode(input.body));
  const sig = await crypto.subtle.sign(
    "Ed25519",
    input.privateKey,
    toArrayBuffer(
      canonicalGatewayResponse({
        method: input.method,
        path: input.path,
        bodySha256: bodySha,
        timestamp: input.timestamp,
        requestId: input.requestId,
        nonce: input.nonce,
      }),
    ),
  );
  return bytesToBase64(new Uint8Array(sig));
}

/** Sign a {@link SignedGatewayManifest} from a raw manifest. */
export async function signGatewayManifest(
  manifest: GatewayManifest,
  privateKey: CryptoKey,
): Promise<SignedGatewayManifest> {
  const sig = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    toArrayBuffer(canonicalGatewayManifest(manifest)),
  );
  return { manifest, signature: bytesToBase64(new Uint8Array(sig)) };
}

async function importEd25519PublicKey(base64Key: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64ToBytes(base64Key)),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  // Detach from any SharedArrayBuffer the type system might let in by copying
  // into a fresh ArrayBuffer. crypto.subtle requires a strict ArrayBuffer.
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Long-running operation queue helper — descriptor of what to enqueue when a
 * provider materialize() exceeds its threshold (default 30s) and needs to be
 * handed off to a remote agent.
 */
export interface LongRunningOperationEnqueue {
  /** Provider plugin id the agent must speak (`aws`, `gcp`, `k8s`). */
  readonly provider: string;
  /** Component / action descriptor (e.g. `aws.rds.create`). */
  readonly descriptor: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  /** Arbitrary, JSON-safe payload the provider plugin understands. */
  readonly payload: JsonObject;
  /** Operator priority (higher first). Default 0. */
  readonly priority?: number;
  /** Idempotency key — kernel deduplicates equal keys to one queued item. */
  readonly idempotencyKey?: string;
  readonly enqueuedAt?: string;
}
