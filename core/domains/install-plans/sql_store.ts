import type { SqlClient } from "../../adapters/storage/sql.ts";
import {
  assertCompletionGeneration,
  assertImmutableScope,
  type ClaimGitInstallPlanResult,
  type CompleteGitInstallPlanResult,
  type CreateGitInstallPlanResult,
  type GitInstallPlanStore,
  type StoredGitInstallPlan,
} from "./store.ts";

const TABLE = "takosumi_git_install_plans";

interface GitInstallPlanRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  actor_subject: string;
  idempotency_key_hash: string;
  request_digest: string;
  generation: number | string;
  record_json: unknown;
  reconcile_lease_token: string | null;
  reconcile_lease_expires_at: string | null;
}

/** Postgres/raw-SQL realization. Schema is migration-owned; no DDL runs here. */
export class SqlGitInstallPlanStore implements GitInstallPlanStore {
  readonly durable = true;
  readonly #client: SqlClient;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  async create(plan: StoredGitInstallPlan): Promise<CreateGitInstallPlanResult> {
    await this.#client.query(
      `insert into ${TABLE}
        (id, workspace_id, actor_subject, idempotency_key_hash,
         request_digest, phase, generation, record_json, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       on conflict (workspace_id, actor_subject, idempotency_key_hash) do nothing`,
      [
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
      ],
    );
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
    const result = await this.#client.query<GitInstallPlanRow>(
      `select * from ${TABLE} where id = $1`,
      [id],
    );
    return result.rows[0] ? rowPlan(result.rows[0]) : undefined;
  }

  async hasInFlightRevisionForCapsule(capsuleId: string): Promise<boolean> {
    const result = await this.#client.query<{ readonly present: boolean }>(
      `select exists (
         select 1 from ${TABLE}
          where record_json ->> 'operation' = 'revision'
            and record_json ->> 'capsuleId' = $1
            and phase not in ('failed', 'reviewable')
       ) as present`,
      [capsuleId],
    );
    return result.rows[0]?.present === true;
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
    const result = await this.#client.query<GitInstallPlanRow>(
      `update ${TABLE}
          set generation = $1, record_json = $2::jsonb,
              reconcile_lease_token = $3, reconcile_lease_expires_at = $4,
              updated_at = $5
        where id = $6 and generation = $7
          and (reconcile_lease_expires_at is null or reconcile_lease_expires_at <= $5)
        returning *`,
      [
        claimed.generation,
        JSON.stringify(claimed),
        input.leaseToken,
        input.leaseExpiresAt,
        input.claimedAt,
        input.id,
        input.expectedGeneration,
      ],
    );
    const row = result.rows[0];
    if (row) {
      return {
        status: "claimed",
        claim: {
          plan: rowPlan(row),
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
    const result = await this.#client.query<GitInstallPlanRow>(
      `update ${TABLE}
          set phase = $1, record_json = $2::jsonb, updated_at = $3,
              reconcile_lease_token = null, reconcile_lease_expires_at = null
        where id = $4 and generation = $5 and reconcile_lease_token = $6
        returning *`,
      [
        input.plan.phase,
        JSON.stringify(input.plan),
        input.plan.updatedAt,
        input.id,
        input.expectedGeneration,
        input.leaseToken,
      ],
    );
    if (result.rows[0]) {
      return { status: "completed", plan: rowPlan(result.rows[0]) };
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
    const result = await this.#client.query<GitInstallPlanRow>(
      `select * from ${TABLE}
        where workspace_id = $1 and actor_subject = $2
          and idempotency_key_hash = $3`,
      [plan.workspaceId, plan.actorSubject, plan.idempotencyKeyHash],
    );
    return result.rows[0] ? rowPlan(result.rows[0]) : undefined;
  }
}

function rowPlan(row: GitInstallPlanRow): StoredGitInstallPlan {
  const raw =
    typeof row.record_json === "string"
      ? JSON.parse(row.record_json)
      : row.record_json;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("invalid Git install plan record_json");
  }
  const plan = raw as StoredGitInstallPlan;
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
