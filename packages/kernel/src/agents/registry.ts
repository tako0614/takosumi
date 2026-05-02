import { conflict, invalidArgument, notFound } from "../shared/errors.ts";
import {
  type GatewayManifest,
  type SignedGatewayManifest,
  signGatewayManifest,
} from "takosumi-contract";
import type {
  CompleteRuntimeAgentWorkInput,
  DetectStaleAgentsInput,
  EnqueueLongRunningOperationInput,
  EnqueueRuntimeAgentWorkInput,
  FailRuntimeAgentWorkInput,
  GatewayManifestIssuer,
  IssueGatewayManifestInput,
  LeaseRuntimeAgentWorkInput,
  RegisterRuntimeAgentInput,
  ReportRuntimeAgentProgressInput,
  RuntimeAgentHeartbeatInput,
  RuntimeAgentId,
  RuntimeAgentRecord,
  RuntimeAgentRegistry,
  RuntimeAgentTerminalWorkReporter,
  RuntimeAgentWorkId,
  RuntimeAgentWorkItem,
  RuntimeAgentWorkLease,
  StaleAgentDetection,
} from "./types.ts";
import {
  rehydrateLeases,
  type WorkLedger,
  type WorkLedgerMutation,
  type WorkLedgerSnapshot,
} from "./work_ledger.ts";

export interface InMemoryRuntimeAgentRegistryOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly defaultLeaseTtlMs?: number;
  readonly maxLeaseTtlMs?: number;
  readonly terminalReporter?: RuntimeAgentTerminalWorkReporter;
  /**
   * Optional persistent work ledger. When provided every mutating call
   * mirrors its agent + work-item state into the ledger so the kernel
   * can resume in-flight long-running operations after a restart.
   */
  readonly ledger?: WorkLedger;
}

export class InMemoryRuntimeAgentRegistry implements RuntimeAgentRegistry {
  readonly #agents = new Map<RuntimeAgentId, RuntimeAgentRecord>();
  readonly #work = new Map<RuntimeAgentWorkId, RuntimeAgentWorkItem>();
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #defaultLeaseTtlMs: number;
  readonly #maxLeaseTtlMs: number;
  readonly #ledger?: WorkLedger;
  readonly #terminalReporter?: RuntimeAgentTerminalWorkReporter;

  constructor(options: InMemoryRuntimeAgentRegistryOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 30_000;
    this.#maxLeaseTtlMs = options.maxLeaseTtlMs ?? 15 * 60_000;
    this.#ledger = options.ledger;
    this.#terminalReporter = options.terminalReporter;
    if (
      !Number.isFinite(this.#defaultLeaseTtlMs) ||
      this.#defaultLeaseTtlMs <= 0
    ) {
      throw invalidArgument("defaultLeaseTtlMs must be a positive integer", {
        defaultLeaseTtlMs: this.#defaultLeaseTtlMs,
      });
    }
    if (!Number.isFinite(this.#maxLeaseTtlMs) || this.#maxLeaseTtlMs <= 0) {
      throw invalidArgument("maxLeaseTtlMs must be a positive integer", {
        maxLeaseTtlMs: this.#maxLeaseTtlMs,
      });
    }
  }

  /**
   * Hydrate a registry from a previously persisted {@link WorkLedger}
   * snapshot. Stale leases (whose lease window has elapsed) are rewritten
   * back to `queued` so a fresh agent lease can pick them up. Used by the
   * kernel boot path so long-running operations resume across restarts.
   */
  static async fromLedger(
    ledger: WorkLedger,
    options: Omit<InMemoryRuntimeAgentRegistryOptions, "ledger"> & {
      readonly now?: string;
    } = {},
  ): Promise<InMemoryRuntimeAgentRegistry> {
    const raw = await ledger.snapshot();
    const registry = new InMemoryRuntimeAgentRegistry({ ...options, ledger });
    await registry.#hydrate(raw, options.now);
    return registry;
  }

  async #hydrate(raw: WorkLedgerSnapshot, now?: string): Promise<void> {
    const { snapshot, requeuedWorkIds } = rehydrateLeases(raw, {
      now: now ?? this.#now(),
    });
    if (requeuedWorkIds.length > 0) {
      await this.#persist({
        works: snapshot.works.filter((work) =>
          requeuedWorkIds.includes(work.id)
        ),
      });
    }
    for (const agent of snapshot.agents) this.#agents.set(agent.id, agent);
    for (const work of snapshot.works) this.#work.set(work.id, work);
  }

  register(input: RegisterRuntimeAgentInput): Promise<RuntimeAgentRecord> {
    const now = input.heartbeatAt ?? this.#now();
    const id = input.agentId ?? `agent_${this.#idGenerator()}`;
    const existing = this.#agents.get(id);
    const digestMismatch = !!(
      existing?.hostKeyDigest && input.hostKeyDigest &&
      existing.hostKeyDigest !== input.hostKeyDigest
    );

    // C4 — host-key impersonation guard. The default behaviour:
    //   - revoke the prior agent record (which requeues every leased
    //     work item the prior agent held), THEN
    //   - reject the call with `conflict` so the operator must opt into
    //     credential rotation explicitly.
    // When `allowHostKeyRotation` is true we still revoke + requeue, but
    // then re-enroll under the new digest in the same call.
    let preMutation: WorkLedgerMutation | undefined;
    if (digestMismatch) {
      const requeued = this.#requeueAgentLeases(id);
      const revoked: RuntimeAgentRecord = freezeClone({
        ...(existing as RuntimeAgentRecord),
        status: "revoked",
        revokedAt: existing!.revokedAt ?? now,
      });
      this.#agents.set(id, revoked);
      preMutation = { agent: revoked, works: requeued };
      if (!input.allowHostKeyRotation) {
        const err = conflict("runtime agent host key mismatch", {
          agentId: id,
          expected: existing!.hostKeyDigest,
          received: input.hostKeyDigest,
          requeuedWorkIds: requeued.map((work) => work.id),
        });
        return this.#persist(preMutation).then(() => {
          throw err;
        });
      }
      // Rotation path falls through — emit a fresh `ready` record below.
    } else if (existing?.status === "revoked" && !input.allowHostKeyRotation) {
      throw conflict("runtime agent has been revoked", { agentId: id });
    }

    const priorForCarry = digestMismatch ? undefined : existing;
    const record: RuntimeAgentRecord = freezeClone({
      id,
      provider: input.provider,
      endpoint: input.endpoint,
      capabilities: {
        providers: input.capabilities?.providers ?? [input.provider],
        maxConcurrentLeases: input.capabilities?.maxConcurrentLeases,
        labels: { ...input.capabilities?.labels },
      },
      status: priorForCarry?.status === "draining" ? "draining" : "ready",
      registeredAt: priorForCarry?.registeredAt ?? now,
      lastHeartbeatAt: now,
      drainRequestedAt: priorForCarry?.drainRequestedAt,
      revokedAt: undefined,
      expiredAt: undefined,
      hostKeyDigest: input.hostKeyDigest ?? priorForCarry?.hostKeyDigest,
      metadata: { ...priorForCarry?.metadata, ...input.metadata },
    });
    this.#agents.set(id, record);
    return this.#persistChain(preMutation, { agent: record, works: [] }).then(
      () => record,
    );
  }

  heartbeat(input: RuntimeAgentHeartbeatInput): Promise<RuntimeAgentRecord> {
    const existing = this.#requireAgent(input.agentId);
    if (existing.status === "revoked") {
      throw conflict("runtime agent has been revoked", {
        agentId: input.agentId,
      });
    }
    const status = existing.status === "draining"
      ? "draining"
      : input.status ?? "ready";
    const record: RuntimeAgentRecord = freezeClone({
      ...existing,
      status,
      // A heartbeat clears the `expired` flag — the agent has reconnected.
      expiredAt: undefined,
      lastHeartbeatAt: input.heartbeatAt ?? this.#now(),
      metadata: { ...existing.metadata, ...input.metadata },
    });
    this.#agents.set(record.id, record);
    return this.#persist({ agent: record, works: [] }).then(() => record);
  }

  getAgent(agentId: RuntimeAgentId): Promise<RuntimeAgentRecord | undefined> {
    return Promise.resolve(this.#agents.get(agentId));
  }
  listAgents(): Promise<readonly RuntimeAgentRecord[]> {
    return Promise.resolve([...this.#agents.values()]);
  }

  requestDrain(
    agentId: RuntimeAgentId,
    at: string = this.#now(),
  ): Promise<RuntimeAgentRecord> {
    const existing = this.#requireAgent(agentId);
    const record: RuntimeAgentRecord = freezeClone({
      ...existing,
      status: "draining",
      drainRequestedAt: existing.drainRequestedAt ?? at,
    });
    this.#agents.set(agentId, record);
    return this.#persist({ agent: record, works: [] }).then(() => record);
  }

  revoke(
    agentId: RuntimeAgentId,
    at: string = this.#now(),
  ): Promise<RuntimeAgentRecord> {
    const existing = this.#requireAgent(agentId);
    const record: RuntimeAgentRecord = freezeClone({
      ...existing,
      status: "revoked",
      revokedAt: existing.revokedAt ?? at,
    });
    this.#agents.set(agentId, record);
    const requeued = this.#requeueAgentLeases(agentId);
    return this.#persist({ agent: record, works: requeued }).then(() => record);
  }

  enqueueWork(
    input: EnqueueRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem> {
    if (input.idempotencyKey) {
      const dup = [...this.#work.values()].find((existing) =>
        existing.idempotencyKey === input.idempotencyKey &&
        (existing.status === "queued" || existing.status === "leased")
      );
      if (dup) return Promise.resolve(dup);
    }
    const id = input.workId ?? `work_${this.#idGenerator()}`;
    if (this.#work.has(id)) {
      throw conflict("runtime agent work already exists", { workId: id });
    }
    const item: RuntimeAgentWorkItem = freezeClone({
      id,
      kind: input.kind,
      status: "queued",
      payload: { ...input.payload },
      provider: input.provider,
      priority: input.priority ?? 0,
      queuedAt: input.queuedAt ?? this.#now(),
      leasedByAgentId: undefined,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      completedAt: undefined,
      failedAt: undefined,
      failureReason: undefined,
      attempts: 0,
      metadata: { ...input.metadata },
      idempotencyKey: input.idempotencyKey,
      lastProgress: undefined,
      lastProgressAt: undefined,
      result: undefined,
    });
    this.#work.set(id, item);
    return this.#persist({ works: [item] }).then(() => item);
  }

  enqueueLongRunningOperation(
    input: EnqueueLongRunningOperationInput,
  ): Promise<RuntimeAgentWorkItem> {
    return this.enqueueWork({
      kind: `provider.${input.provider}.${input.descriptor}`,
      provider: input.provider,
      priority: input.priority,
      queuedAt: input.enqueuedAt,
      idempotencyKey: input.idempotencyKey,
      payload: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        targetId: input.targetId,
        ...input.payload,
      },
      metadata: {
        descriptor: input.descriptor,
        desiredStateId: input.desiredStateId,
        ...(input.targetId ? { targetId: input.targetId } : {}),
      },
    });
  }

  leaseWork(
    input: LeaseRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkLease | undefined> {
    const agent = this.#requireAgent(input.agentId);
    if (agent.status !== "ready") return Promise.resolve(undefined);
    const now = input.now ?? this.#now();
    const nowMs = this.#parseTimestamp(now, "now");
    const expiredRequeues = this.#requeueExpiredLeases(now);
    const cap = agent.capabilities.maxConcurrentLeases;
    if (cap !== undefined && cap > 0) {
      const inFlight = [...this.#work.values()].filter((work) =>
        work.status === "leased" && work.leasedByAgentId === agent.id
      ).length;
      if (inFlight >= cap) {
        if (expiredRequeues.length > 0) {
          return this.#persist({ works: expiredRequeues }).then(
            () =>
              undefined,
          );
        }
        return Promise.resolve(undefined);
      }
    }
    const candidate =
      [...this.#work.values()].filter((work) =>
        work.status === "queued" &&
        (!work.provider || agent.capabilities.providers.includes(work.provider))
      ).sort((a, b) =>
        b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt)
      )[0];
    if (!candidate) {
      if (expiredRequeues.length > 0) {
        return this.#persist({ works: expiredRequeues }).then(() => undefined);
      }
      return Promise.resolve(undefined);
    }
    const leaseId = `lease_${this.#idGenerator()}`;
    const ttlMs = this.#effectiveLeaseTtlMs(input.leaseTtlMs);
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const renewAfter = new Date(
      nowMs + Math.floor(ttlMs / 2),
    ).toISOString();
    const leasedWork: RuntimeAgentWorkItem = freezeClone({
      ...candidate,
      status: "leased",
      leasedByAgentId: agent.id,
      leaseId,
      leaseExpiresAt: expiresAt,
      attempts: candidate.attempts + 1,
    });
    this.#work.set(leasedWork.id, leasedWork);
    // Persist both the newly-leased item and any expired-lease requeues
    // in the same mutation so the ledger never observes a half-applied
    // state across a kernel restart.
    const persistWorks = [...expiredRequeues, leasedWork].filter(
      (work, index, all) =>
        all.findIndex((other) => other.id === work.id) === index,
    );
    return this.#persist({ works: persistWorks }).then(() =>
      freezeClone({
        id: leaseId,
        workId: leasedWork.id,
        agentId: agent.id,
        leasedAt: now,
        expiresAt,
        renewAfter,
        work: leasedWork,
      })
    );
  }

  completeWork(
    input: CompleteRuntimeAgentWorkInput,
  ): Promise<RuntimeAgentWorkItem> {
    const work = this.#requireLease(input.agentId, input.leaseId);
    const completed: RuntimeAgentWorkItem = freezeClone({
      ...work,
      status: "completed",
      completedAt: input.completedAt ?? this.#now(),
      result: input.result ?? work.result,
    });
    this.#work.set(work.id, completed);
    return this.#persist({ works: [completed] })
      .then(() => this.#terminalReporter?.complete(completed))
      .then(() => completed);
  }

  failWork(input: FailRuntimeAgentWorkInput): Promise<RuntimeAgentWorkItem> {
    const work = this.#requireLease(input.agentId, input.leaseId);
    const failed: RuntimeAgentWorkItem = freezeClone({
      ...work,
      status: input.retry ? "queued" : "failed",
      leasedByAgentId: undefined,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      failedAt: input.failedAt ?? this.#now(),
      failureReason: input.reason,
      result: input.result ?? work.result,
    });
    this.#work.set(work.id, failed);
    return this.#persist({ works: [failed] })
      .then(() => this.#terminalReporter?.fail(failed))
      .then(() => failed);
  }

  reportProgress(
    input: ReportRuntimeAgentProgressInput,
  ): Promise<RuntimeAgentWorkItem> {
    const work = this.#requireLease(input.agentId, input.leaseId);
    const reportedAt = input.reportedAt ?? this.#now();
    const reportedAtMs = this.#parseTimestamp(reportedAt, "reportedAt");
    let nextExpiresAt = work.leaseExpiresAt;
    if (input.extendUntil) {
      const requestedExtendUntilMs = this.#parseTimestamp(
        input.extendUntil,
        "extendUntil",
      );
      const cappedExtendUntil = new Date(
        Math.min(
          requestedExtendUntilMs,
          reportedAtMs + this.#maxLeaseTtlMs,
        ),
      ).toISOString();
      // Refuse to shrink the lease window via progress reports — the lease
      // can only ever be extended.
      if (
        !work.leaseExpiresAt ||
        Date.parse(cappedExtendUntil) > Date.parse(work.leaseExpiresAt)
      ) {
        nextExpiresAt = cappedExtendUntil;
      }
    }
    const updated: RuntimeAgentWorkItem = freezeClone({
      ...work,
      leaseExpiresAt: nextExpiresAt,
      lastProgress: input.progress
        ? { ...work.lastProgress, ...input.progress }
        : work.lastProgress,
      lastProgressAt: reportedAt,
    });
    this.#work.set(work.id, updated);
    return this.#persist({ works: [updated] }).then(() => updated);
  }

  detectStaleAgents(
    input: DetectStaleAgentsInput,
  ): Promise<StaleAgentDetection> {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw invalidArgument("ttlMs must be a positive integer", {
        ttlMs: input.ttlMs,
      });
    }
    const now = input.now ?? this.#now();
    const cutoff = Date.parse(now) - input.ttlMs;
    const stale: RuntimeAgentRecord[] = [];
    const requeued: RuntimeAgentWorkItem[] = [];
    const persistTasks: Promise<void>[] = [];
    for (const agent of [...this.#agents.values()]) {
      if (agent.status === "revoked" || agent.status === "expired") continue;
      const beat = Date.parse(agent.lastHeartbeatAt);
      if (!Number.isFinite(beat) || beat > cutoff) continue;
      const updated: RuntimeAgentRecord = freezeClone({
        ...agent,
        status: "expired",
        expiredAt: now,
      });
      this.#agents.set(agent.id, updated);
      stale.push(updated);
      const agentRequeues: RuntimeAgentWorkItem[] = [];
      for (const work of this.#work.values()) {
        if (work.leasedByAgentId === agent.id && work.status === "leased") {
          const requeuedItem: RuntimeAgentWorkItem = freezeClone({
            ...work,
            status: "queued",
            leasedByAgentId: undefined,
            leaseId: undefined,
            leaseExpiresAt: undefined,
          });
          this.#work.set(work.id, requeuedItem);
          requeued.push(requeuedItem);
          agentRequeues.push(requeuedItem);
        }
      }
      persistTasks.push(
        this.#persist({ agent: updated, works: agentRequeues }),
      );
    }
    return Promise.all(persistTasks).then(() => ({
      stale,
      requeuedWork: requeued,
    }));
  }

  getWork(
    workId: RuntimeAgentWorkId,
  ): Promise<RuntimeAgentWorkItem | undefined> {
    return Promise.resolve(this.#work.get(workId));
  }
  listWork(): Promise<readonly RuntimeAgentWorkItem[]> {
    return Promise.resolve([...this.#work.values()]);
  }
  #now(): string {
    return this.#clock().toISOString();
  }
  #effectiveLeaseTtlMs(requested?: number): number {
    if (requested === undefined) return this.#defaultLeaseTtlMs;
    if (!Number.isFinite(requested) || requested <= 0) {
      throw invalidArgument("leaseTtlMs must be a positive integer", {
        leaseTtlMs: requested,
      });
    }
    return Math.min(Math.floor(requested), this.#maxLeaseTtlMs);
  }
  #parseTimestamp(value: string, field: string): number {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw invalidArgument(`${field} must be an ISO-8601 timestamp`, {
        [field]: value,
      });
    }
    return parsed;
  }
  #requireAgent(agentId: RuntimeAgentId): RuntimeAgentRecord {
    const agent = this.#agents.get(agentId);
    if (!agent) throw notFound("runtime agent not found", { agentId });
    return agent;
  }
  #requireLease(
    agentId: RuntimeAgentId,
    leaseId: string,
  ): RuntimeAgentWorkItem {
    const work = [...this.#work.values()].find((candidate) =>
      candidate.leaseId === leaseId && candidate.leasedByAgentId === agentId
    );
    if (!work) {
      throw notFound("runtime agent work lease not found", {
        agentId,
        leaseId,
      });
    }
    if (work.status !== "leased") {
      throw conflict("runtime agent work is not leased", { agentId, leaseId });
    }
    return work;
  }
  #requeueExpiredLeases(now: string): RuntimeAgentWorkItem[] {
    const requeued: RuntimeAgentWorkItem[] = [];
    for (const work of this.#work.values()) {
      if (
        work.status === "leased" && work.leaseExpiresAt &&
        work.leaseExpiresAt <= now
      ) {
        const next = freezeClone({
          ...work,
          status: "queued" as const,
          leasedByAgentId: undefined,
          leaseId: undefined,
          leaseExpiresAt: undefined,
        });
        this.#work.set(work.id, next);
        requeued.push(next);
      }
    }
    return requeued;
  }

  /**
   * Requeue every `leased` work item the named agent currently holds.
   * Used by both `revoke()` and the C4 host-key impersonation guard so
   * malicious operators cannot strand work in `leased` state.
   */
  #requeueAgentLeases(agentId: RuntimeAgentId): RuntimeAgentWorkItem[] {
    const requeued: RuntimeAgentWorkItem[] = [];
    for (const work of this.#work.values()) {
      if (work.leasedByAgentId === agentId && work.status === "leased") {
        const next = freezeClone({
          ...work,
          status: "queued" as const,
          leasedByAgentId: undefined,
          leaseId: undefined,
          leaseExpiresAt: undefined,
        });
        this.#work.set(work.id, next);
        requeued.push(next);
      }
    }
    return requeued;
  }

  #persist(mutation: WorkLedgerMutation): Promise<void> {
    if (!this.#ledger) return Promise.resolve();
    if (!mutation.agent && mutation.works.length === 0) {
      return Promise.resolve();
    }
    return this.#ledger.apply(mutation);
  }

  /** Apply two mutations in order — used by `register` when a host-key
   * rotation has produced a `revoked + requeue` step before the fresh
   * `ready` enrollment is persisted. */
  #persistChain(
    pre: WorkLedgerMutation | undefined,
    post: WorkLedgerMutation,
  ): Promise<void> {
    if (!pre) return this.#persist(post);
    return this.#persist(pre).then(() => this.#persist(post));
  }
}

/**
 * Reference {@link GatewayManifestIssuer} that mints a signed manifest using
 * the operator-supplied kernel-trusted Ed25519 keypair. Operators wire this
 * into {@link registerRuntimeAgentRoutes} via `gatewayManifestIssuer`.
 */
export interface RuntimeAgentGatewayManifestIssuerOptions {
  readonly registry: RuntimeAgentRegistry;
  /** Kernel-trusted Ed25519 private key used to sign manifests. */
  readonly signingKey: CryptoKey;
  /** Base64 of the Ed25519 public key. Bound into the manifest. */
  readonly publicKeyBase64: string;
  /** Hex SHA-256 of the public key bytes. Bound into the manifest. */
  readonly publicKeyFingerprint: string;
  /** Logical issuer id, e.g. `operator-control-plane`. */
  readonly issuer: string;
  /** TTL for issued manifests. Default 1 hour. */
  readonly manifestTtlMs?: number;
  /** Optional cert pin (base64 SHA-256 of TLS leaf SPKI). */
  readonly tlsPubkeySha256?: string;
  readonly clock?: () => Date;
  /**
   * Allow-list of gateway URLs the issuer will sign for. The bootstrap
   * registers each URL the operator controls (`https://aws-gateway.example`
   * etc.) so an attacker who tricks the agent into pointing at an unknown
   * URL cannot get a valid manifest minted for it. When omitted, every URL
   * is allowed — only suitable for tests.
   */
  readonly allowedGatewayUrls?: readonly string[];
}

export class RuntimeAgentGatewayManifestIssuer
  implements GatewayManifestIssuer {
  readonly #registry: RuntimeAgentRegistry;
  readonly #signingKey: CryptoKey;
  readonly #publicKeyBase64: string;
  readonly #publicKeyFingerprint: string;
  readonly #issuer: string;
  readonly #manifestTtlMs: number;
  readonly #tlsPubkeySha256?: string;
  readonly #clock: () => Date;
  readonly #allowedGatewayUrls?: ReadonlySet<string>;

  constructor(options: RuntimeAgentGatewayManifestIssuerOptions) {
    this.#registry = options.registry;
    this.#signingKey = options.signingKey;
    this.#publicKeyBase64 = options.publicKeyBase64;
    this.#publicKeyFingerprint = options.publicKeyFingerprint;
    this.#issuer = options.issuer;
    this.#manifestTtlMs = options.manifestTtlMs ?? 60 * 60 * 1000;
    this.#tlsPubkeySha256 = options.tlsPubkeySha256;
    this.#clock = options.clock ?? (() => new Date());
    this.#allowedGatewayUrls = options.allowedGatewayUrls
      ? new Set(options.allowedGatewayUrls)
      : undefined;
  }

  async issue(
    input: IssueGatewayManifestInput,
  ): Promise<SignedGatewayManifest> {
    const agent = await this.#registry.getAgent(input.agentId);
    if (!agent) {
      throw notFound("runtime agent not found", { agentId: input.agentId });
    }
    if (agent.status === "revoked") {
      throw conflict("runtime agent has been revoked", {
        agentId: input.agentId,
      });
    }
    if (
      this.#allowedGatewayUrls &&
      !this.#allowedGatewayUrls.has(input.gatewayUrl)
    ) {
      throw conflict("gateway url not allow-listed", {
        agentId: input.agentId,
        gatewayUrl: input.gatewayUrl,
      });
    }
    const issuedAt = input.issuedAt ?? this.#clock().toISOString();
    const expiresAt = new Date(
      Date.parse(issuedAt) + this.#manifestTtlMs,
    ).toISOString();
    const manifest: GatewayManifest = {
      gatewayUrl: input.gatewayUrl,
      issuer: this.#issuer,
      agentId: agent.id,
      issuedAt,
      expiresAt,
      allowedProviderKinds: [...agent.capabilities.providers],
      pubkey: this.#publicKeyBase64,
      pubkeyFingerprint: this.#publicKeyFingerprint,
      tlsPubkeySha256: this.#tlsPubkeySha256,
    };
    return await signGatewayManifest(manifest, this.#signingKey);
  }
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
