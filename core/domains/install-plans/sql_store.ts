import type { SqlClient } from "../../adapters/storage/sql.ts";
import {
  assertWorkspaceManagementAdmission,
  assertWorkspaceManagementAuthorityInput,
  WorkspaceManagementAdmissionConflictError,
  type WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";
import { pgWorkspaceManagementForTransaction } from "../deploy-control/store_sql.ts";
import {
  assertCompletionGeneration,
  assertImmutableScope,
  gitInstallPlanManagementAuthority,
  type ClaimGitInstallPlanResult,
  type CompleteGitInstallPlanResult,
  type CreateGitInstallPlanResult,
  type GitInstallPlanScope,
  type GitInstallPlanStore,
  type StoredGitInstallPlan,
  isReconcileableGitInstallPlanPhase,
  isTerminalGitInstallPlanPhase,
} from "./store.ts";
import { PG_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL } from "./management_blockers_sql.ts";

const TABLE = "takosumi_git_install_plans";

interface GitInstallPlanRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  actor_subject: string;
  idempotency_key_hash: string;
  request_digest: string;
  phase: string;
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

  async create(
    plan: StoredGitInstallPlan,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<CreateGitInstallPlanResult> {
    if (plan.workspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(plan.workspaceManagementAuthority, plan.workspaceId);
    }
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        expectedWorkspaceManagementAuthority,
        plan.workspaceId,
      );
    }
    return await this.#client.transaction(async (transaction) => {
      // An existing exact scope is an observation-only replay/conflict and is
      // intentionally readable while Workspace management is draining.
      const existing = await this.#getByScope(plan, transaction);
      if (existing) return createResult(plan, existing);
      const authority = gitInstallPlanManagementAuthority(plan, expectedWorkspaceManagementAuthority);

      // Workspace is the outer lock for a new dependent row. The persisted
      // active/epoch predicate below keeps the write bound to this Workspace.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        plan.workspaceId,
      );
      // A concurrent writer may have created this scope while the initial
      // observation raced with the Workspace lock. Re-check before applying
      // the mutable admission predicate so that exact retries remain readable
      // even if management stopped in the meantime.
      const afterLock = await this.#getByScope(plan, transaction);
      if (afterLock) return createResult(plan, afterLock);
      assertWorkspaceManagementAdmission(
        management,
        plan.workspaceId,
        authority,
      );
      const inserted = await transaction.query<GitInstallPlanRow>(
        `insert into ${TABLE}
          (id, workspace_id, actor_subject, idempotency_key_hash,
           request_digest, phase, generation, record_json, created_at, updated_at)
         select $1, workspace.id, $2, $3, $4, $5, $6, $7::jsonb, $8, $9
           from takosumi_workspaces as workspace
          where workspace.id = $10
            and workspace.management_state = 'active'
            and workspace.management_epoch = $11
         on conflict (workspace_id, actor_subject, idempotency_key_hash) do nothing
         returning *`,
        [
          plan.id,
          plan.actorSubject,
          plan.idempotencyKeyHash,
          plan.requestDigest,
          plan.phase,
          plan.generation,
          JSON.stringify(plan),
          plan.createdAt,
          plan.updatedAt,
          plan.workspaceId,
          authority.managementEpoch,
        ],
      );
      if (inserted.rowCount > 0 && inserted.rows[0]) {
        return { status: "created", plan: rowPlan(inserted.rows[0]) };
      }

      // A concurrent writer may have won the scope unique key while this
      // transaction waited for the Workspace lock. Re-read only to classify
      // that existing row; an absent row means the admission predicate lost.
      const after = await this.#getByScope(plan, transaction);
      if (after) return createResult(plan, after);
      throw new WorkspaceManagementAdmissionConflictError(plan.workspaceId);
    });
  }

  async get(id: string): Promise<StoredGitInstallPlan | undefined> {
    return await this.#getById(id);
  }

  async getByScope(scope: GitInstallPlanScope): Promise<StoredGitInstallPlan | undefined> {
    return await this.#getByScope(scope);
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

  async hasWorkspaceManagementBlockers(workspaceId: string): Promise<boolean> {
    const result = await this.#client.query<{ readonly present: boolean }>(
      `select exists (
         select 1 from ${TABLE}
          where workspace_id = $1
            and ${PG_GIT_INSTALL_PLAN_MANAGEMENT_BLOCKER_SQL}
       ) as present`,
      [workspaceId],
    );
    if (
      result.rows.length !== 1 ||
      typeof result.rows[0]?.present !== "boolean"
    ) {
      throw new TypeError("Git install-plan blocker predicate result is indeterminate");
    }
    return result.rows[0].present;
  }

  async claimReconcile(input: {
    readonly id: string;
    readonly expectedGeneration: number;
    readonly leaseToken: string;
    readonly claimedAt: string;
    readonly leaseExpiresAt: string;
    readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
  }): Promise<ClaimGitInstallPlanResult> {
    const observedRow = await this.#getByIdRow(input.id);
    if (!observedRow) return { status: "not_found" };
    const observed = rowPlan(observedRow);
    if (input.expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(
        input.expectedWorkspaceManagementAuthority,
        observed.workspaceId,
      );
    }
    if (observed.generation !== input.expectedGeneration) {
      return { status: "conflict", plan: observed };
    }
    if (
      !isReconcileableGitInstallPlanPhase(observed.phase) ||
      observedRow.phase !== observed.phase ||
      isTerminalGitInstallPlanPhase(observedRow.phase)
    ) {
      return { status: "conflict", plan: observed };
    }
    if (leaseIsBusy(observedRow, input.claimedAt)) {
      return { status: "busy", plan: observed };
    }

    const workspaceId = observed.workspaceId;
    return await this.#client.transaction(async (transaction) => {
      // Capture the Git row's Workspace before taking the shared Workspace
      // lock; never trust a caller-supplied Workspace to choose the lock.
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        workspaceId,
      );
      const currentRow = await this.#getByIdRow(input.id, transaction);
      if (!currentRow) return { status: "not_found" };
      const current = rowPlan(currentRow);
      if (current.workspaceId !== workspaceId) {
        return { status: "conflict", plan: current };
      }
      if (current.generation !== input.expectedGeneration) {
        return { status: "conflict", plan: current };
      }
      if (
        !isReconcileableGitInstallPlanPhase(current.phase) ||
        currentRow.phase !== current.phase ||
        isTerminalGitInstallPlanPhase(currentRow.phase)
      ) {
        return { status: "conflict", plan: current };
      }
      if (leaseIsBusy(currentRow, input.claimedAt)) {
        return { status: "busy", plan: current };
      }

      const authority = gitInstallPlanManagementAuthority(current, input.expectedWorkspaceManagementAuthority);
      assertWorkspaceManagementAdmission(
        management,
        workspaceId,
        authority,
      );
      const claimed: StoredGitInstallPlan = {
        ...current,
        generation: current.generation + 1,
        updatedAt: input.claimedAt,
      };
      const result = await transaction.query<GitInstallPlanRow>(
        `update ${TABLE}
            set generation = $1, record_json = $2::jsonb,
                reconcile_lease_token = $3, reconcile_lease_expires_at = $4,
                updated_at = $5
          where id = $6 and workspace_id = $7 and generation = $8
            and phase in (
              'syncing_source', 'compiling_install',
              'analyzing_compatibility', 'creating_capsule', 'planning'
            )
            and jsonb_typeof(record_json -> 'phase') = 'string'
            and record_json ->> 'phase' = phase
            and jsonb_typeof(record_json -> 'workspaceId') = 'string'
            and record_json ->> 'workspaceId' = workspace_id
            and jsonb_typeof(record_json -> 'generation') = 'number'
            and record_json ->> 'generation' = generation::text
            and (reconcile_lease_expires_at is null or reconcile_lease_expires_at <= $5)
            and exists (
              select 1 from takosumi_workspaces as workspace
               where workspace.id = ${TABLE}.workspace_id
                 and workspace.management_state = 'active'
                 and workspace.management_epoch = $9
            )
          returning *`,
        [
          claimed.generation,
          JSON.stringify(claimed),
          input.leaseToken,
          input.leaseExpiresAt,
          input.claimedAt,
          input.id,
          workspaceId,
          input.expectedGeneration,
          authority.managementEpoch,
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
      const latestRow = await this.#getByIdRow(input.id, transaction);
      if (!latestRow) return { status: "not_found" };
      const latest = rowPlan(latestRow);
      if (latest.workspaceId !== workspaceId) {
        return { status: "conflict", plan: latest };
      }
      if (latest.generation !== input.expectedGeneration) {
        return { status: "conflict", plan: latest };
      }
      if (
        !isReconcileableGitInstallPlanPhase(latest.phase) ||
        latestRow.phase !== latest.phase ||
        isTerminalGitInstallPlanPhase(latestRow.phase)
      ) {
        return { status: "conflict", plan: latest };
      }
      if (leaseIsBusy(latestRow, input.claimedAt)) {
        return { status: "busy", plan: latest };
      }
      throw new WorkspaceManagementAdmissionConflictError(workspaceId);
    });
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
    client: SqlClient = this.#client,
  ): Promise<StoredGitInstallPlan | undefined> {
    const result = await client.query<GitInstallPlanRow>(
      `select * from ${TABLE}
        where workspace_id = $1 and actor_subject = $2
        and idempotency_key_hash = $3`,
      [plan.workspaceId, plan.actorSubject, plan.idempotencyKeyHash],
    );
    return result.rows[0] ? rowPlan(result.rows[0]) : undefined;
  }

  async #getById(
    id: string,
    client: SqlClient = this.#client,
  ): Promise<StoredGitInstallPlan | undefined> {
    const row = await this.#getByIdRow(id, client);
    return row ? rowPlan(row) : undefined;
  }

  async #getByIdRow(
    id: string,
    client: SqlClient = this.#client,
  ): Promise<GitInstallPlanRow | undefined> {
    const result = await client.query<GitInstallPlanRow>(
      `select * from ${TABLE} where id = $1`,
      [id],
    );
    return result.rows[0];
  }
}

function createResult(
  plan: StoredGitInstallPlan,
  existing: StoredGitInstallPlan,
): CreateGitInstallPlanResult {
  return {
    status:
      existing.requestDigest === plan.requestDigest ? "replayed" : "conflict",
    plan: existing,
  };
}

function leaseIsBusy(
  row: Pick<GitInstallPlanRow, "reconcile_lease_expires_at">,
  claimedAt: string,
): boolean {
  return row.reconcile_lease_expires_at !== null &&
    row.reconcile_lease_expires_at > claimedAt;
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
