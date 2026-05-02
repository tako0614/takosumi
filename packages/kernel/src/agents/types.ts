import type { SignedGatewayManifest } from "takosumi-contract";

export type RuntimeAgentId = string;
export type RuntimeAgentWorkId = string;
export type RuntimeAgentLeaseId = string;
export type RuntimeAgentStatus =
  | "registered"
  | "ready"
  | "draining"
  | "revoked"
  | "expired";
export type RuntimeAgentWorkStatus =
  | "queued"
  | "leased"
  | "completed"
  | "failed"
  | "cancelled";

export interface RuntimeAgentCapabilities {
  readonly providers: readonly string[];
  readonly maxConcurrentLeases?: number;
  readonly labels?: Record<string, string>;
}

export interface RuntimeAgentRecord {
  readonly id: RuntimeAgentId;
  readonly provider: string;
  readonly endpoint?: string;
  readonly capabilities: RuntimeAgentCapabilities;
  readonly status: RuntimeAgentStatus;
  readonly registeredAt: string;
  readonly lastHeartbeatAt: string;
  readonly drainRequestedAt?: string;
  readonly revokedAt?: string;
  readonly expiredAt?: string;
  readonly hostKeyDigest?: string;
  readonly metadata: Record<string, unknown>;
}

export interface RegisterRuntimeAgentInput {
  readonly agentId?: RuntimeAgentId;
  readonly provider: string;
  readonly endpoint?: string;
  readonly capabilities?: Partial<RuntimeAgentCapabilities>;
  readonly metadata?: Record<string, unknown>;
  readonly heartbeatAt?: string;
  /**
   * SHA-256 hex digest of the agent's host key. Subsequent enrollments under
   * the same `agentId` must present an identical digest, otherwise the
   * registry treats it as impersonation. On mismatch, the registry first
   * revokes the prior record (which requeues every `leased` work item the
   * old agent held — so a malicious operator cannot strand work in `leased`)
   * and then rejects the call with `conflict`. Operators that legitimately
   * need to rotate the digest must opt in via `allowHostKeyRotation`.
   */
  readonly hostKeyDigest?: string;
  /**
   * Operator-driven credential rotation. When true and the call presents a
   * host-key digest that differs from the prior enrollment, the registry
   * revokes the old record (requeueing every leased work item) and then
   * re-enrolls the agent under the new digest in the same call.
   */
  readonly allowHostKeyRotation?: boolean;
}

export interface RuntimeAgentHeartbeatInput {
  readonly agentId: RuntimeAgentId;
  readonly heartbeatAt?: string;
  readonly status?: Extract<RuntimeAgentStatus, "ready" | "draining">;
  readonly metadata?: Record<string, unknown>;
}

export interface RuntimeAgentWorkItem {
  readonly id: RuntimeAgentWorkId;
  readonly kind: string;
  readonly status: RuntimeAgentWorkStatus;
  readonly payload: Record<string, unknown>;
  readonly provider?: string;
  readonly priority: number;
  readonly queuedAt: string;
  readonly leasedByAgentId?: RuntimeAgentId;
  readonly leaseId?: RuntimeAgentLeaseId;
  readonly leaseExpiresAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly failureReason?: string;
  readonly attempts: number;
  readonly metadata: Record<string, unknown>;
  readonly idempotencyKey?: string;
  /** Last reported progress payload (set by `reportProgress`). */
  readonly lastProgress?: Record<string, unknown>;
  readonly lastProgressAt?: string;
  /** Final operation result payload reported on completion / failure. */
  readonly result?: Record<string, unknown>;
}

export interface EnqueueRuntimeAgentWorkInput {
  readonly workId?: RuntimeAgentWorkId;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly provider?: string;
  readonly priority?: number;
  readonly metadata?: Record<string, unknown>;
  readonly queuedAt?: string;
  /**
   * If set, deduplicates with any non-terminal work item that has the same
   * idempotency key. The previously enqueued item is returned instead of
   * creating a duplicate.
   */
  readonly idempotencyKey?: string;
}

export interface RuntimeAgentWorkLease {
  readonly id: RuntimeAgentLeaseId;
  readonly workId: RuntimeAgentWorkId;
  readonly agentId: RuntimeAgentId;
  readonly leasedAt: string;
  readonly expiresAt: string;
  readonly renewAfter: string;
  readonly work: RuntimeAgentWorkItem;
}

export interface LeaseRuntimeAgentWorkInput {
  readonly agentId: RuntimeAgentId;
  readonly leaseTtlMs?: number;
  readonly now?: string;
}
export interface CompleteRuntimeAgentWorkInput {
  readonly agentId: RuntimeAgentId;
  readonly leaseId: RuntimeAgentLeaseId;
  readonly completedAt?: string;
  readonly result?: Record<string, unknown>;
}
export interface FailRuntimeAgentWorkInput {
  readonly agentId: RuntimeAgentId;
  readonly leaseId: RuntimeAgentLeaseId;
  readonly reason: string;
  readonly retry?: boolean;
  readonly failedAt?: string;
  readonly result?: Record<string, unknown>;
}

/**
 * Progress report. The agent reports `progress` while a long-running op is
 * still running so the kernel can:
 *   - extend the lease window so the work is not requeued,
 *   - surface intermediate state on `Deployment.conditions[]`.
 */
export interface ReportRuntimeAgentProgressInput {
  readonly agentId: RuntimeAgentId;
  readonly leaseId: RuntimeAgentLeaseId;
  readonly progress?: Record<string, unknown>;
  readonly extendUntil?: string;
  readonly reportedAt?: string;
}

/** Detect agents whose `lastHeartbeatAt` is older than `now - ttlMs`. */
export interface DetectStaleAgentsInput {
  readonly ttlMs: number;
  readonly now?: string;
}

export interface StaleAgentDetection {
  readonly stale: readonly RuntimeAgentRecord[];
  readonly requeuedWork: readonly RuntimeAgentWorkItem[];
}

export interface RuntimeAgentTerminalWorkReporter {
  complete(work: RuntimeAgentWorkItem): Promise<unknown>;
  fail(work: RuntimeAgentWorkItem): Promise<unknown>;
}

/**
 * Long-running operation queue helper — descriptor a provider plugin enqueues
 * when its inline materialize() exceeded the threshold.
 */
export interface EnqueueLongRunningOperationInput {
  readonly provider: string;
  readonly descriptor: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly payload: Record<string, unknown>;
  readonly priority?: number;
  readonly idempotencyKey?: string;
  readonly enqueuedAt?: string;
}

/**
 * Input the kernel uses to issue a signed {@link SignedGatewayManifest} the
 * remote runtime-agent will pin at startup. The agent calls
 * `GET /api/internal/v1/runtime/agents/:agentId/gateway-manifest` and the
 * route delegates to {@link RuntimeAgentRegistry.issueGatewayManifest}.
 */
export interface IssueGatewayManifestInput {
  readonly agentId: RuntimeAgentId;
  /** Gateway URL the agent has been told to talk to (operator-injected). */
  readonly gatewayUrl: string;
  /** Optional override for issuance time (tests). */
  readonly issuedAt?: string;
}

/**
 * Signs a {@link SignedGatewayManifest} for the supplied agent. The kernel
 * looks up the agent's allowed providers + cert pin from the registry and
 * signs with the kernel-trusted private key.
 */
export interface GatewayManifestIssuer {
  issue(input: IssueGatewayManifestInput): Promise<SignedGatewayManifest>;
}

export interface RuntimeAgentRegistry {
  register(input: RegisterRuntimeAgentInput): Promise<RuntimeAgentRecord>;
  heartbeat(input: RuntimeAgentHeartbeatInput): Promise<RuntimeAgentRecord>;
  getAgent(agentId: RuntimeAgentId): Promise<RuntimeAgentRecord | undefined>;
  listAgents(): Promise<readonly RuntimeAgentRecord[]>;
  requestDrain(
    agentId: RuntimeAgentId,
    at?: string,
  ): Promise<RuntimeAgentRecord>;
  revoke(agentId: RuntimeAgentId, at?: string): Promise<RuntimeAgentRecord>;
  enqueueWork(
    input: EnqueueRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem>;
  leaseWork(
    input: LeaseRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkLease | undefined>;
  completeWork(
    input: CompleteRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem>;
  failWork(input: FailRuntimeAgentWorkInput): Promise<RuntimeAgentWorkItem>;
  /** Extend the lease window for an in-flight long-running operation. */
  reportProgress(
    input: ReportRuntimeAgentProgressInput,
  ): Promise<RuntimeAgentWorkItem>;
  /**
   * Mark agents whose `lastHeartbeatAt` is older than the supplied TTL as
   * `expired`, requeue any leases they hold, and return the affected
   * records.
   */
  detectStaleAgents(
    input: DetectStaleAgentsInput,
  ): Promise<StaleAgentDetection>;
  /**
   * Helper that records a long-running provider operation onto the work
   * queue. Equivalent to `enqueueWork` but with the descriptor / target
   * shape Phase 17B expects.
   */
  enqueueLongRunningOperation(
    input: EnqueueLongRunningOperationInput,
  ): Promise<RuntimeAgentWorkItem>;
  getWork(
    workId: RuntimeAgentWorkId,
  ): Promise<RuntimeAgentWorkItem | undefined>;
  listWork(): Promise<readonly RuntimeAgentWorkItem[]>;
}
