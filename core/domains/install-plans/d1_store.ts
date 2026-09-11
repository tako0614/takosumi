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
import {
  assertWorkspaceManagementAuthorityInput,
  WorkspaceManagementAdmissionConflictError,
  type WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";

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
  readonly phase: string;
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
    const observed = await this.#getByScope(plan);
    if (observed) return createResult(plan, observed);
    const authority = gitInstallPlanManagementAuthority(plan, expectedWorkspaceManagementAuthority);
    const result = await this.#db
      .prepare(
        `insert into git_install_plans
          (id, workspace_id, actor_subject, idempotency_key_hash,
           request_digest, phase, generation, record_json, created_at, updated_at)
         select ?, workspace.id, ?, ?, ?, ?, ?, ?, ?, ?
           from workspaces as workspace
          where workspace.id = ?
            and workspace.management_state = 'active'
            and workspace.management_epoch = ?
         on conflict (workspace_id, actor_subject, idempotency_key_hash) do nothing`,
      )
      .bind(
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
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      const inserted = await this.get(plan.id);
      if (!inserted) throw new Error("Git install plan insert was not readable");
      return { status: "created", plan: inserted };
    }
    // A no-op can be either an existing scope (which is still observable
    // while draining) or a failed Workspace admission. Read back the scope
    // to distinguish those outcomes without an unconditional write.
    const existing = await this.#getByScope(plan);
    if (existing) return createResult(plan, existing);
    throw new WorkspaceManagementAdmissionConflictError(plan.workspaceId);
  }

  async get(id: string): Promise<StoredGitInstallPlan | undefined> {
    const row = await this.#getByIdRow(id);
    return row ? rowPlan(row) : undefined;
  }

  async getByScope(scope: GitInstallPlanScope): Promise<StoredGitInstallPlan | undefined> {
    return await this.#getByScope(scope);
  }

  async hasInFlightRevisionForCapsule(capsuleId: string): Promise<boolean> {
    const row = await this.#db
      .prepare(
        `select exists (
           select 1 from git_install_plans
            where json_extract(record_json, '$.operation') = 'revision'
              and json_extract(record_json, '$.capsuleId') = ?
              and phase not in ('failed', 'reviewable')
         ) as present`,
      )
      .bind(capsuleId)
      .first<{ readonly present: number }>();
    return row?.present === 1;
  }

  async hasWorkspaceManagementBlockers(workspaceId: string): Promise<boolean> {
    const result = await this.#db
      .prepare(
        `select exists (
           select 1 from git_install_plans
            where workspace_id = ?
              and (
                phase is null
                or phase not in ('failed', 'reviewable')
                or reconcile_lease_token is not null
                or reconcile_lease_expires_at is not null
                or case when json_valid(record_json) = 1 then
                    case when
                      json_type(record_json, '$.workspaceId') = 'text'
                      and json_extract(record_json, '$.workspaceId') is workspace_id
                      and json_type(record_json, '$.phase') = 'text'
                      and json_extract(record_json, '$.phase') is phase
                      and json_type(record_json, '$.generation') = 'integer'
                      and json_extract(record_json, '$.generation') is generation
                    then 0 else 1 end
                  else 1 end = 1
              )
         ) as present`,
      )
      .bind(workspaceId)
      .first<{ readonly present: number }>();
    if (
      result === null ||
      typeof result !== "object" ||
      (result.present !== 0 && result.present !== 1)
    ) {
      throw new TypeError("Git install-plan blocker predicate result is indeterminate");
    }
    return result.present === 1;
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
    const claimedGeneration = observed.generation + 1;
    const authority = gitInstallPlanManagementAuthority(observed, input.expectedWorkspaceManagementAuthority);
    const claimedRow = await this.#db
      .prepare(
        `update git_install_plans
            set generation = ?,
                record_json = json_set(record_json, '$.generation', ?, '$.updatedAt', ?),
                reconcile_lease_token = ?,
                reconcile_lease_expires_at = ?, updated_at = ?
          where id = ? and workspace_id = ? and generation = ?
            and (reconcile_lease_expires_at is null or reconcile_lease_expires_at <= ?)
            and phase in (
              'syncing_source', 'compiling_install',
              'analyzing_compatibility', 'creating_capsule', 'planning'
            )
            and json_valid(record_json) = 1
            and json_type(record_json, '$.phase') = 'text'
            and json_extract(record_json, '$.phase') = phase
            and json_type(record_json, '$.workspaceId') = 'text'
            and json_extract(record_json, '$.workspaceId') = workspace_id
            and json_type(record_json, '$.generation') = 'integer'
            and json_extract(record_json, '$.generation') = generation
            and exists (
              select 1 from workspaces as workspace
               where workspace.id = git_install_plans.workspace_id
                 and workspace.management_state = 'active'
                 and workspace.management_epoch = ?
            )
          returning *`,
      )
      .bind(
        claimedGeneration,
        claimedGeneration,
        input.claimedAt,
        input.leaseToken,
        input.leaseExpiresAt,
        input.claimedAt,
        input.id,
        observed.workspaceId,
        input.expectedGeneration,
        input.claimedAt,
        authority.managementEpoch,
      )
      .first<GitInstallPlanD1Row>();
    if (claimedRow) {
      return {
        status: "claimed",
        claim: {
          plan: rowPlan(claimedRow),
          leaseToken: input.leaseToken,
          leaseExpiresAt: input.leaseExpiresAt,
        },
      };
    }
    const latestRow = await this.#getByIdRow(input.id);
    if (!latestRow) return { status: "not_found" };
    const latest = rowPlan(latestRow);
    if (latest.workspaceId !== observed.workspaceId) {
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
    throw new WorkspaceManagementAdmissionConflictError(observed.workspaceId);
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

  async #getByIdRow(id: string): Promise<GitInstallPlanD1Row | undefined> {
    const row = await this.#db
      .prepare("select * from git_install_plans where id = ?")
      .bind(id)
      .first<GitInstallPlanD1Row>();
    return row ?? undefined;
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
  row: Pick<GitInstallPlanD1Row, "reconcile_lease_expires_at">,
  claimedAt: string,
): boolean {
  return row.reconcile_lease_expires_at !== null &&
    row.reconcile_lease_expires_at > claimedAt;
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
