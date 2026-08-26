import type { GitInstallPlan } from "takosumi-contract";

export const GIT_INSTALL_PLAN_RECONCILE_LEASE_MS = 30_000;

export interface StoredGitInstallPlan extends GitInstallPlan {
  /** Exact actor boundary used for idempotency; not projected separately. */
  readonly actorSubject: string;
  /** SHA-256 digest of the caller's Idempotency-Key; raw key is never stored. */
  readonly idempotencyKeyHash: string;
  /** Private Capsule execution-authority fence for revision coordination. */
  readonly capsuleExecutionAuthorityEpoch?: number;
}

export interface ClaimedGitInstallPlan {
  readonly plan: StoredGitInstallPlan;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export type CreateGitInstallPlanResult =
  | { readonly status: "created"; readonly plan: StoredGitInstallPlan }
  | { readonly status: "replayed"; readonly plan: StoredGitInstallPlan }
  | { readonly status: "conflict"; readonly plan: StoredGitInstallPlan };

export type ClaimGitInstallPlanResult =
  | { readonly status: "claimed"; readonly claim: ClaimedGitInstallPlan }
  | { readonly status: "busy" | "conflict"; readonly plan: StoredGitInstallPlan }
  | { readonly status: "not_found" };

export type CompleteGitInstallPlanResult =
  | { readonly status: "completed"; readonly plan: StoredGitInstallPlan }
  | { readonly status: "conflict"; readonly plan: StoredGitInstallPlan }
  | { readonly status: "not_found" };

export interface GitInstallPlanStore {
  readonly durable: boolean;
  create(plan: StoredGitInstallPlan): Promise<CreateGitInstallPlanResult>;
  get(id: string): Promise<StoredGitInstallPlan | undefined>;
  hasInFlightRevisionForCapsule(capsuleId: string): Promise<boolean>;
  claimReconcile(input: {
    readonly id: string;
    readonly expectedGeneration: number;
    readonly leaseToken: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<ClaimGitInstallPlanResult>;
  completeReconcile(input: {
    readonly id: string;
    readonly expectedGeneration: number;
    readonly leaseToken: string;
    readonly plan: StoredGitInstallPlan;
  }): Promise<CompleteGitInstallPlanResult>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface InMemoryEntry {
  plan: StoredGitInstallPlan;
  leaseToken?: string;
  leaseExpiresAt?: string;
}

/** Development/test realization with the same idempotency and CAS semantics. */
export class InMemoryGitInstallPlanStore implements GitInstallPlanStore {
  readonly durable = false;
  readonly #entries = new Map<string, InMemoryEntry>();
  readonly #scopeIndex = new Map<string, string>();

  async create(plan: StoredGitInstallPlan): Promise<CreateGitInstallPlanResult> {
    const scope = scopeKey(plan);
    const existingId = this.#scopeIndex.get(scope);
    if (existingId) {
      const existing = this.#entries.get(existingId)!.plan;
      return {
        status:
          existing.requestDigest === plan.requestDigest
            ? "replayed"
            : "conflict",
        plan: clone(existing),
      };
    }
    if (this.#entries.has(plan.id)) {
      throw new Error("Git install plan id collision");
    }
    this.#entries.set(plan.id, { plan: clone(plan) });
    this.#scopeIndex.set(scope, plan.id);
    return { status: "created", plan: clone(plan) };
  }

  async get(id: string): Promise<StoredGitInstallPlan | undefined> {
    const entry = this.#entries.get(id);
    return entry ? clone(entry.plan) : undefined;
  }

  hasInFlightRevisionForCapsule(capsuleId: string): Promise<boolean> {
    return Promise.resolve(
      Array.from(this.#entries.values()).some(
        ({ plan }) =>
          plan.operation === "revision" &&
          plan.capsuleId === capsuleId &&
          plan.phase !== "failed" && plan.phase !== "reviewable",
      ),
    );
  }

  async claimReconcile(
    input: Parameters<GitInstallPlanStore["claimReconcile"]>[0],
  ): Promise<ClaimGitInstallPlanResult> {
    const entry = this.#entries.get(input.id);
    if (!entry) return { status: "not_found" };
    if (entry.plan.generation !== input.expectedGeneration) {
      return { status: "conflict", plan: clone(entry.plan) };
    }
    if (
      entry.leaseToken &&
      entry.leaseExpiresAt &&
      entry.leaseExpiresAt > input.claimedAt
    ) {
      return { status: "busy", plan: clone(entry.plan) };
    }
    entry.plan = {
      ...entry.plan,
      generation: entry.plan.generation + 1,
      updatedAt: input.claimedAt,
    };
    entry.leaseToken = input.leaseToken;
    entry.leaseExpiresAt = input.leaseExpiresAt;
    return {
      status: "claimed",
      claim: {
        plan: clone(entry.plan),
        leaseToken: input.leaseToken,
        leaseExpiresAt: input.leaseExpiresAt,
      },
    };
  }

  async completeReconcile(
    input: Parameters<GitInstallPlanStore["completeReconcile"]>[0],
  ): Promise<CompleteGitInstallPlanResult> {
    const entry = this.#entries.get(input.id);
    if (!entry) return { status: "not_found" };
    if (
      entry.plan.generation !== input.expectedGeneration ||
      entry.leaseToken !== input.leaseToken
    ) {
      return { status: "conflict", plan: clone(entry.plan) };
    }
    assertCompletionGeneration(input.expectedGeneration, input.plan);
    assertImmutableScope(entry.plan, input.plan);
    entry.plan = clone(input.plan);
    delete entry.leaseToken;
    delete entry.leaseExpiresAt;
    return { status: "completed", plan: clone(entry.plan) };
  }
}

export function publicGitInstallPlan(plan: StoredGitInstallPlan): GitInstallPlan {
  const {
    actorSubject: _actorSubject,
    idempotencyKeyHash: _idempotencyKeyHash,
    capsuleExecutionAuthorityEpoch: _capsuleExecutionAuthorityEpoch,
    ...publicPlan
  } = plan;
  return publicPlan;
}

export function assertImmutableScope(
  current: StoredGitInstallPlan,
  next: StoredGitInstallPlan,
): void {
  if (
    current.id !== next.id ||
    current.workspaceId !== next.workspaceId ||
    current.actorSubject !== next.actorSubject ||
    current.idempotencyKeyHash !== next.idempotencyKeyHash ||
    current.capsuleExecutionAuthorityEpoch !==
      next.capsuleExecutionAuthorityEpoch ||
    current.requestDigest !== next.requestDigest ||
    current.createdBy !== next.createdBy ||
    current.createdAt !== next.createdAt ||
    (current.operation ?? "install") !== (next.operation ?? "install") ||
    JSON.stringify(current.source) !== JSON.stringify(next.source) ||
    JSON.stringify(current.capsule) !== JSON.stringify(next.capsule) ||
    JSON.stringify(current.options) !== JSON.stringify(next.options) ||
    JSON.stringify(current.revision) !== JSON.stringify(next.revision) ||
    (current.operation === "revision" &&
      (current.sourceId !== next.sourceId ||
        current.capsuleId !== next.capsuleId ||
        current.installConfigId !== next.installConfigId ||
        current.installConfigBaseId !== next.installConfigBaseId ||
        current.installConfigBaseDigest !== next.installConfigBaseDigest ||
        current.installModulePath !== next.installModulePath))
  ) {
    throw new TypeError("Git install plan immutable request scope changed");
  }
}

export function assertCompletionGeneration(
  expectedGeneration: number,
  plan: StoredGitInstallPlan,
): void {
  if (plan.generation !== expectedGeneration) {
    throw new TypeError("Git install plan completion generation changed");
  }
}

function scopeKey(plan: StoredGitInstallPlan): string {
  return `${plan.workspaceId}\0${plan.actorSubject}\0${plan.idempotencyKeyHash}`;
}
