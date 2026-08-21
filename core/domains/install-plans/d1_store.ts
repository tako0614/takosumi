import {
  assertCompletionGeneration,
  assertImmutableScope,
  type ClaimGitInstallPlanResult,
  type CompleteGitInstallPlanResult,
  type CreateGitInstallPlanResult,
  type GitInstallPlanStore,
  type StoredGitInstallPlan,
} from "./store.ts";

interface D1Result<T> {
  readonly results?: readonly T[];
  readonly meta?: { readonly changes?: number };
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface GitInstallPlanD1Database {
  prepare(query: string): D1Statement;
}

interface GitInstallPlanD1Row {
  readonly id: string;
  readonly workspace_id: string;
  readonly actor_subject: string;
  readonly idempotency_key_hash: string;
  readonly request_digest: string;
  readonly generation: number | string;
  readonly record_json: string;
  readonly reconcile_lease_token: string | null;
  readonly reconcile_lease_expires_at: string | null;
}

/** D1/raw-SQL realization. The migration catalog owns all DDL. */
export class D1GitInstallPlanStore implements GitInstallPlanStore {
  readonly durable = true;
  readonly #db: GitInstallPlanD1Database;

  constructor(db: GitInstallPlanD1Database) {
    this.#db = db;
  }

  async create(plan: StoredGitInstallPlan): Promise<CreateGitInstallPlanResult> {
    await this.#db
      .prepare(
        `insert into git_install_plans
          (id, workspace_id, actor_subject, idempotency_key_hash,
           request_digest, phase, generation, record_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (workspace_id, actor_subject, idempotency_key_hash) do nothing`,
      )
      .bind(
        plan.id,
        plan.workspaceId,
        plan.actorSubject,
        plan.idempotencyKeyHash,
        plan.requestDigest,
        plan.phase,
        plan.generation,
        JSON.stringify(plan),
        plan.createdAt,
        plan.updatedAt,
      )
      .run();
    const existing = await this.#getByScope(plan);
    if (!existing) throw new Error("Git install plan insert was not readable");
    return {
      status:
        existing.id === plan.id
          ? "created"
          : existing.requestDigest === plan.requestDigest
            ? "replayed"
            : "conflict",
      plan: existing,
    };
  }

  async get(id: string): Promise<StoredGitInstallPlan | undefined> {
    const row = await this.#db
      .prepare("select * from git_install_plans where id = ?")
      .bind(id)
      .first<GitInstallPlanD1Row>();
    return row ? rowPlan(row) : undefined;
  }

  async claimReconcile(input: {
    readonly id: string;
    readonly expectedGeneration: number;
    readonly leaseToken: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
  }): Promise<ClaimGitInstallPlanResult> {
    const current = await this.get(input.id);
    if (!current) return { status: "not_found" };
    if (current.generation !== input.expectedGeneration) {
      return { status: "conflict", plan: current };
    }
    const claimed: StoredGitInstallPlan = {
      ...current,
      generation: current.generation + 1,
      updatedAt: input.claimedAt,
    };
    const result = await this.#db
      .prepare(
        `update git_install_plans
            set generation = ?, record_json = ?, reconcile_lease_token = ?,
                reconcile_lease_expires_at = ?, updated_at = ?
          where id = ? and generation = ?
            and (reconcile_lease_expires_at is null or reconcile_lease_expires_at <= ?)`,
      )
      .bind(
        claimed.generation,
        JSON.stringify(claimed),
        input.leaseToken,
        input.leaseExpiresAt,
        input.claimedAt,
        input.id,
        input.expectedGeneration,
        input.claimedAt,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return {
        status: "claimed",
        claim: {
          plan: claimed,
          leaseToken: input.leaseToken,
          leaseExpiresAt: input.leaseExpiresAt,
        },
      };
    }
    const latest = await this.get(input.id);
    if (!latest) return { status: "not_found" };
    return {
      status:
        latest.generation === input.expectedGeneration ? "busy" : "conflict",
      plan: latest,
    };
  }

  async completeReconcile(input: {
    readonly id: string;
    readonly expectedGeneration: number;
    readonly leaseToken: string;
    readonly plan: StoredGitInstallPlan;
  }): Promise<CompleteGitInstallPlanResult> {
    const current = await this.get(input.id);
    if (!current) return { status: "not_found" };
    assertCompletionGeneration(input.expectedGeneration, input.plan);
    assertImmutableScope(current, input.plan);
    const result = await this.#db
      .prepare(
        `update git_install_plans
            set phase = ?, record_json = ?, updated_at = ?,
                reconcile_lease_token = null, reconcile_lease_expires_at = null
          where id = ? and generation = ? and reconcile_lease_token = ?`,
      )
      .bind(
        input.plan.phase,
        JSON.stringify(input.plan),
        input.plan.updatedAt,
        input.id,
        input.expectedGeneration,
        input.leaseToken,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { status: "completed", plan: input.plan };
    }
    const latest = await this.get(input.id);
    return latest
      ? { status: "conflict", plan: latest }
      : { status: "not_found" };
  }

  async #getByScope(
    plan: Pick<
      StoredGitInstallPlan,
      "workspaceId" | "actorSubject" | "idempotencyKeyHash"
    >,
  ): Promise<StoredGitInstallPlan | undefined> {
    const row = await this.#db
      .prepare(
        `select * from git_install_plans
          where workspace_id = ? and actor_subject = ? and idempotency_key_hash = ?`,
      )
      .bind(plan.workspaceId, plan.actorSubject, plan.idempotencyKeyHash)
      .first<GitInstallPlanD1Row>();
    return row ? rowPlan(row) : undefined;
  }
}

function rowPlan(row: GitInstallPlanD1Row): StoredGitInstallPlan {
  const plan = JSON.parse(row.record_json) as StoredGitInstallPlan;
  const generation = Number(row.generation);
  if (
    !Number.isSafeInteger(generation) ||
    plan.id !== row.id ||
    plan.workspaceId !== row.workspace_id ||
    plan.actorSubject !== row.actor_subject ||
    plan.idempotencyKeyHash !== row.idempotency_key_hash ||
    plan.requestDigest !== row.request_digest ||
    plan.generation !== generation
  ) {
    throw new TypeError("invalid Git install plan row identity");
  }
  return structuredClone(plan);
}
