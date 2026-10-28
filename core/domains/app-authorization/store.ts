import type { AppAccessResolver } from "../../../contract/app-access.ts";
import type { SqlClient } from "../../adapters/storage/sql.ts";
import type { D1Like, D1LikePreparedStatement } from "../../adapters/storage/d1.ts";
import type { SourceSyncRun } from "../../../contract/sources.ts";
import { sourceSyncRunForDrainFailure } from "../deploy-control/store.ts";
import { AppAuthorizationError } from "./errors.ts";

export interface AppAuthorizationMember {
  readonly accountId: string;
  readonly status: "active" | "invited";
}

export interface AppAuthorizationTransfer {
  readonly transferId: string;
  readonly capsuleId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly state: "pending" | "accepted" | "cancelled";
}

export interface AppAuthorizationMutations extends AppAccessResolver {
  listMembers(capsuleId: string): Promise<{ readonly ownerAccountId: string; readonly ownershipEpoch: number; readonly members: readonly AppAuthorizationMember[] }>;
  addMember(input: MemberMutationInput): Promise<AppAuthorizationMember>;
  removeMember(input: MemberMutationInput): Promise<void>;
  createTransfer(input: TransferCreationInput): Promise<{ readonly transferId: string; readonly state: "pending" }>;
  getTransfer(transferId: string): Promise<AppAuthorizationTransfer | undefined>;
  acceptTransfer(input: { readonly transferId: string; readonly actorAccountId: string }): Promise<{ readonly transferId: string; readonly state: "pending" | "accepted" }>;
  cancelTransfer(input: { readonly transferId: string; readonly actorAccountId: string }): Promise<void>;
}

export interface MemberMutationInput {
  readonly capsuleId: string;
  readonly actorAccountId: string;
  readonly accountId: string;
  readonly expectedOwnershipEpoch: number;
}

export interface TransferCreationInput {
  readonly capsuleId: string;
  readonly actorAccountId: string;
  readonly toAccountId: string;
  readonly expectedOwnershipEpoch: number;
}

type OwnerRow = {
  owner_account_id: string | null;
  ownership_epoch: number;
  management_state: string;
  management_epoch: number;
};
type MemberRow = { account_id: string; status: string };
type TransferRow = {
  id: string;
  capsule_id: string;
  from_account_id: string;
  to_account_id: string;
  ownership_epoch: number;
  drain_management_epoch: number | null;
  state: string;
};
type RunRow = { id: string; kind: string; status: string; lease_token: string | null; run_json: unknown; source_id?: string | null };

const unavailable = () => new AppAuthorizationError("feature_unavailable", "App ownership storage is unavailable.");
const conflict = (message: string) => new AppAuthorizationError("conflict", message);
const pending = () => new AppAuthorizationError("ownership_transfer_pending", "App management is draining; retry after active Runs settle.");

function schemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|no such column|does not exist|undefined column|undefined table/i.test(message);
}

function withSchemaError(error: unknown): never {
  if (schemaError(error)) throw unavailable();
  throw error;
}

function requireOwner(row: OwnerRow | undefined, input: { actorAccountId: string; expectedOwnershipEpoch: number }): OwnerRow {
  if (!row?.owner_account_id) throw unavailable();
  if (row.owner_account_id !== input.actorAccountId) throw new AppAuthorizationError("app_owner_only", "Only the current app owner can perform this action.");
  if (row.ownership_epoch !== input.expectedOwnershipEpoch || row.management_state !== "active") throw conflict("App ownership or management state changed.");
  return row;
}

function transferRecord(row: TransferRow | undefined): AppAuthorizationTransfer | undefined {
  if (!row) return undefined;
  if (row.state !== "pending" && row.state !== "accepted" && row.state !== "cancelled") throw unavailable();
  return {
    transferId: row.id,
    capsuleId: row.capsule_id,
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    state: row.state,
  };
}

function parseRunJson(row: RunRow): Record<string, unknown> {
  const parsed = typeof row.run_json === "string" ? JSON.parse(row.run_json) : row.run_json;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).id !== row.id ||
    (parsed as Record<string, unknown>).status !== row.status) throw conflict("Run ledger is inconsistent.");
  return parsed as Record<string, unknown>;
}

/** Only exact, never-started Plan/Apply rows can be cancelled by revocation. */
function cancelledRun(row: RunRow, now: number): Record<string, unknown> {
  const run = parseRunJson(row);
  if (row.lease_token !== null ||
    (row.status !== "queued" && row.status !== "waiting_approval") ||
    (row.status === "queued" && run.startedAt !== undefined) ||
    (row.kind !== "plan" && row.kind !== "destroy_plan" && row.kind !== "apply" && row.kind !== "destroy_apply") ||
    !Array.isArray(run.auditEvents) || typeof run.updatedAt !== "number" ||
    run.updatedAt > now) throw conflict("A member Run cannot be cancelled safely yet.");
  if ((row.kind === "apply" || row.kind === "destroy_apply") && row.status !== "queued") {
    throw conflict("A member Apply Run cannot be cancelled safely yet.");
  }
  const eventType = row.kind === "plan" || row.kind === "destroy_plan" ? "plan.cancelled" : "apply.cancelled";
  return {
    ...run,
    status: "cancelled",
    auditEvents: [...run.auditEvents, { id: `${row.id}:${eventType}:${now}`, type: eventType, at: now }],
    updatedAt: now,
    finishedAt: now,
  };
}

/** Settle a never-claimed app Run while management is durably draining. */
function transferDrainRun(row: RunRow, now: number): { status: "cancelled" | "failed"; run: Record<string, unknown> } | undefined {
  if (row.lease_token !== null || (row.status !== "queued" && row.status !== "waiting_approval")) return undefined;
  const run = parseRunJson(row);
  if (row.kind === "plan" || row.kind === "destroy_plan" || row.kind === "apply" || row.kind === "destroy_apply") {
    try { return { status: "cancelled", run: cancelledRun(row, now) }; }
    catch (error) { if (error instanceof AppAuthorizationError && error.code === "conflict") return undefined; throw error; }
  }
  const finishedAt = new Date(now).toISOString();
  if (typeof run.createdAt !== "string" || !Number.isFinite(Date.parse(run.createdAt)) ||
    run.startedAt !== undefined || run.heartbeatAt !== undefined || run.finishedAt !== undefined ||
    run.executionEvidence !== undefined || run.stateVersionId !== undefined || run.outputId !== undefined) return undefined;
  if (row.kind === "source_sync") {
    if (row.status !== "queued" || run.resolvedCommit !== undefined || run.archiveDigest !== undefined) return undefined;
    return { status: "failed", run: {
      ...run, status: "failed", errorCode: "app_ownership_draining",
      error: "App ownership transfer drained this unstarted source sync.",
      updatedAt: finishedAt, finishedAt,
    } };
  }
  if (row.kind === "restore" || row.kind === "backup" || row.kind === "compatibility_check" ||
    row.kind === "drift_check" || row.kind === "state_recovery") {
    if (row.status === "waiting_approval" && row.kind !== "restore") return undefined;
    return { status: "cancelled", run: {
      ...run, status: "cancelled", finishedAt,
      ...(Array.isArray(run.auditEvents) ? {
        auditEvents: [...run.auditEvents, { id: `${row.id}:app_ownership.cancelled:${now}`, type: "app_ownership.cancelled", at: now }],
      } : {}),
    } };
  }
  return undefined;
}

/** SourceSyncRun has no `cancelled` status; revocation fails an unstarted run. */
function failedSourceSync(
  row: RunRow, now: number, errorCode: string, error: string, actorAccountId?: string,
): Record<string, unknown> {
  const run = parseRunJson(row);
  if (row.kind !== "source_sync" || row.status !== "queued" || row.lease_token !== null ||
    run.kind !== "source_sync" ||
    (actorAccountId !== undefined && run.actorAccountId !== actorAccountId) || run.sourceId !== row.source_id) {
    throw conflict("Source sync ownership changed before member removal.");
  }
  const failed = sourceSyncRunForDrainFailure(run as unknown as SourceSyncRun, new Date(now).toISOString());
  if (!failed) throw conflict("Source sync has execution evidence and cannot be failed safely.");
  return {
    ...failed,
    errorCode,
    error,
  };
}

function revokedSourceSync(row: RunRow, actorAccountId: string, now: number): Record<string, unknown> {
  return failedSourceSync(row, now, "app_access_revoked", "App membership was removed before this source sync started.", actorAccountId);
}

function targetRuns(rows: readonly RunRow[], actor: string): { row: RunRow; cancelled: Record<string, unknown> }[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const planCreator = (planId: unknown): unknown => {
    if (typeof planId !== "string") return undefined;
    const plan = byId.get(planId);
    return plan ? parseRunJson(plan).createdBy : undefined;
  };
  const now = Date.now();
  return [...byId.values()].flatMap((row) => {
    if (row.status !== "queued" && row.status !== "waiting_approval") return [];
    const run = parseRunJson(row);
    const createdBy = run.createdBy ?? planCreator(run.planRunId);
    if (createdBy !== actor) return [];
    return [{ row, cancelled: cancelledRun(row, now) }];
  });
}

function requireTransfer(row: TransferRow | undefined, actor: string, action: "accept" | "cancel"): TransferRow {
  if (!row) throw new AppAuthorizationError("not_found", "Transfer was not found.");
  if (row.state !== "pending") throw conflict("Transfer is no longer pending.");
  if (action === "accept" && row.to_account_id !== actor) throw new AppAuthorizationError("app_access_denied", "Only the recipient can accept a transfer.");
  if (action === "cancel" && row.from_account_id !== actor) throw new AppAuthorizationError("app_owner_only", "Only the current owner can cancel a transfer.");
  return row;
}

/** PostgreSQL mutation adapter. Every compound write locks the Capsule row. */
export class SqlAppAuthorizationStore implements AppAuthorizationMutations {
  constructor(readonly client: SqlClient, readonly access: AppAccessResolver) {}
  resolveAppAccess(accountId: string, capsuleId: string) { return this.access.resolveAppAccess(accountId, capsuleId); }
  listAccessibleApps(accountId: string, page?: { cursor?: string; limit?: number }) { return this.access.listAccessibleApps(accountId, page); }

  async #owner(tx: SqlClient, capsuleId: string, lock: boolean): Promise<OwnerRow | undefined> {
    const result = await tx.query<OwnerRow>(
      `select owner_account_id, ownership_epoch, management_state, management_epoch
       from takosumi_capsules where id=$1 ${lock ? "for update" : ""}`,
      [capsuleId],
    );
    return result.rows[0];
  }
  async #transfer(tx: SqlClient, id: string, lock: boolean): Promise<TransferRow | undefined> {
    const result = await tx.query<TransferRow>(
      `select * from takosumi_capsule_ownership_transfers where id=$1 ${lock ? "for update" : ""}`,
      [id],
    );
    return result.rows[0];
  }
  async #lockedTransfer(tx: SqlClient, id: string): Promise<{ transfer: TransferRow; owner: OwnerRow | undefined }> {
    // Create takes Capsule then transfer. Read the capsule id without a row
    // lock, then take locks in that same order for accept and cancel.
    const observed = await this.#transfer(tx, id, false);
    if (!observed) throw new AppAuthorizationError("not_found", "Transfer was not found.");
    const owner = await this.#owner(tx, observed.capsule_id, true);
    const transfer = await this.#transfer(tx, id, true);
    if (!transfer || transfer.capsule_id !== observed.capsule_id) throw conflict("Transfer changed during the write.");
    return { transfer, owner };
  }
  async listMembers(capsuleId: string) {
    try {
      return await this.client.transaction(async (tx) => {
        const owner = await this.#owner(tx, capsuleId, false);
        if (!owner?.owner_account_id) throw unavailable();
        const members = await tx.query<MemberRow>(
          `select account_id, status from takosumi_capsule_members where capsule_id=$1 order by account_id`,
          [capsuleId],
        );
        return {
          ownerAccountId: owner.owner_account_id,
          ownershipEpoch: owner.ownership_epoch,
          members: members.rows.map((row) => ({ accountId: row.account_id, status: memberStatus(row.status) })),
        };
      });
    } catch (error) { withSchemaError(error); }
  }
  async addMember(input: MemberMutationInput): Promise<AppAuthorizationMember> {
    try {
      return await this.client.transaction(async (tx) => {
        const owner = requireOwner(await this.#owner(tx, input.capsuleId, true), input);
        if (owner.owner_account_id === input.accountId) throw conflict("Owner cannot be a member.");
        const now = new Date().toISOString();
        await tx.query(
          `insert into takosumi_capsule_members (capsule_id,account_id,status,added_by,created_at,updated_at)
           values ($1,$2,'active',$3,$4,$4)
           on conflict (capsule_id,account_id) do update set status='active',added_by=excluded.added_by,updated_at=excluded.updated_at`,
          [input.capsuleId, input.accountId, input.actorAccountId, now],
        );
        return { accountId: input.accountId, status: "active" as const };
      });
    } catch (error) { withSchemaError(error); }
  }
  async removeMember(input: MemberMutationInput): Promise<void> {
    try {
      await this.client.transaction(async (tx) => {
        const owner = await this.#owner(tx, input.capsuleId, true);
        if (!owner?.owner_account_id) throw unavailable();
        if (owner.ownership_epoch !== input.expectedOwnershipEpoch || owner.management_state !== "active") throw conflict("App ownership or management state changed.");
        if (input.accountId === owner.owner_account_id || (input.actorAccountId !== owner.owner_account_id && input.actorAccountId !== input.accountId)) {
          throw new AppAuthorizationError("app_owner_only", "Only the owner or departing member may remove membership.");
        }
        // Canonical Plan/Apply admission locks Capsule before inserting Runs.
        // Keep that order here; Source sync enqueue does not lock Capsule, so
        // fence inserts while selecting and settling its run rows.
        await tx.query(`lock table takosumi_runs in share row exclusive mode`);
        const rows = await tx.query<RunRow>(
          `select id,kind,status,lease_token,run_json from takosumi_runs
           where installation_id=$1 and status in ('queued','waiting_approval','running') limit 81 for update`,
          [input.capsuleId],
        );
        if (rows.rows.length > 80) throw conflict("Too many active Runs for atomic member removal.");
        const planIds = rows.rows.flatMap((row) => {
          const run = parseRunJson(row);
          return typeof run.planRunId === "string" ? [run.planRunId] : [];
        });
        const plans = planIds.length === 0 ? [] : (await tx.query<RunRow>(
          `select id,kind,status,lease_token,run_json from takosumi_runs where id = any($1::text[]) for update`,
          [planIds],
        )).rows;
        const ambiguousSource = await tx.query<{ id: string }>(
          `select r.id from takosumi_runs r
           join takosumi_capsules c on c.id=$1 and c.source_id=r.source_id
           join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and r.status in ('queued','running')
             and r.run_json->>'actorAccountId'=$2
             and s.source_json->>'ownerCapsuleId' is distinct from $1
           limit 1`,
          [input.capsuleId, input.accountId],
        );
        if (ambiguousSource.rows.length > 0) throw conflict("Source sync cannot be attributed to this app safely.");
        const sourceRows = await tx.query<RunRow>(
          `select r.id,r.kind,r.status,r.lease_token,r.run_json,r.source_id
           from takosumi_runs r join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and r.status in ('queued','running')
             and r.run_json->>'actorAccountId'=$2
             and s.source_json->>'ownerCapsuleId'=$1
           limit 81 for update of r,s`,
          [input.capsuleId, input.accountId],
        );
        if (sourceRows.rows.length > 80) throw conflict("Too many active Source sync Runs for atomic member removal.");
        if (sourceRows.rows.some((row) => row.status === "running" || row.lease_token !== null)) {
          throw conflict("Member has an active Source sync Run; removal must wait for it to settle.");
        }
        const cancels = targetRuns([...rows.rows, ...plans], input.accountId).filter(({ row }) =>
          row.status === "queued" || row.status === "waiting_approval"
        );
        if ([...rows.rows, ...plans].some((row) => row.status === "running" &&
          (parseRunJson(row).createdBy === input.accountId ||
            plans.some((plan) => plan.id === parseRunJson(row).planRunId && parseRunJson(plan).createdBy === input.accountId)))) {
          throw conflict("Member has an active Run; removal must wait for it to settle.");
        }
        for (const { row, cancelled } of cancels) {
          await tx.query(
            `update takosumi_runs set status='cancelled',lease_token=null,heartbeat_at=null,run_json=$2::jsonb where id=$1`,
            [row.id, JSON.stringify(cancelled)],
          );
          if (row.kind === "plan" || row.kind === "destroy_plan") {
            await tx.query(`delete from takosumi_plan_run_inputs where plan_run_id=$1`, [row.id]);
          }
        }
        const now = Date.now();
        for (const row of sourceRows.rows) {
          await tx.query(
            `update takosumi_runs set status='failed',lease_token=null,heartbeat_at=null,run_json=$2::jsonb where id=$1`,
            [row.id, JSON.stringify(revokedSourceSync(row, input.accountId, now))],
          );
        }
        const removed = await tx.query(
          `delete from takosumi_capsule_members where capsule_id=$1 and account_id=$2`,
          [input.capsuleId, input.accountId],
        );
        if (removed.rowCount !== 1) throw new AppAuthorizationError("not_found", "Member was not found.");
      });
    } catch (error) { withSchemaError(error); }
  }
  async createTransfer(input: TransferCreationInput) {
    try {
      return await this.client.transaction(async (tx) => {
        requireOwner(await this.#owner(tx, input.capsuleId, true), input);
        if (input.toAccountId === input.actorAccountId) throw conflict("Owner cannot transfer to self.");
        const existing = await tx.query<{ id: string }>(
          `select id from takosumi_capsule_ownership_transfers where capsule_id=$1 and state='pending'`,
          [input.capsuleId],
        );
        if (existing.rows.length > 0) throw pending();
        const transferId = crypto.randomUUID();
        const now = new Date().toISOString();
        await tx.query(
          `insert into takosumi_capsule_ownership_transfers
           (id,capsule_id,from_account_id,to_account_id,ownership_epoch,state,created_at,updated_at)
           values ($1,$2,$3,$4,$5,'pending',$6,$6)`,
          [transferId, input.capsuleId, input.actorAccountId, input.toAccountId, input.expectedOwnershipEpoch, now],
        );
        return { transferId, state: "pending" as const };
      });
    } catch (error) { withSchemaError(error); }
  }
  async getTransfer(id: string) {
    try { return transferRecord(await this.#transfer(this.client, id, false)); }
    catch (error) { withSchemaError(error); }
  }
  async cancelTransfer(input: { transferId: string; actorAccountId: string }): Promise<void> {
    try {
      await this.client.transaction(async (tx) => {
        const locked = await this.#lockedTransfer(tx, input.transferId);
        const transfer = requireTransfer(locked.transfer, input.actorAccountId, "cancel");
        const owner = locked.owner;
        if (owner?.owner_account_id !== transfer.from_account_id || owner.ownership_epoch !== transfer.ownership_epoch) throw conflict("App ownership changed.");
        const now = new Date().toISOString();
        await tx.query(`update takosumi_capsule_ownership_transfers set state='cancelled',updated_at=$2 where id=$1`, [input.transferId, now]);
        if (owner.management_state === "draining") {
          if (transfer.drain_management_epoch !== owner.management_epoch) throw conflict("Another app management drain is active.");
          await tx.query(
            `update takosumi_capsules set management_state='active',management_epoch=management_epoch+1,
             installation_json=jsonb_set(jsonb_set(installation_json,'{managementState}','"active"'::jsonb),'{managementEpoch}',to_jsonb(management_epoch+1))
             where id=$1`,
            [transfer.capsule_id],
          );
        }
      });
    } catch (error) { withSchemaError(error); }
  }
  async acceptTransfer(input: { transferId: string; actorAccountId: string }) {
    try {
      return await this.client.transaction(async (tx) => {
        const locked = await this.#lockedTransfer(tx, input.transferId);
        const transfer = requireTransfer(locked.transfer, input.actorAccountId, "accept");
        const owner = locked.owner;
        if (owner?.owner_account_id !== transfer.from_account_id || owner.ownership_epoch !== transfer.ownership_epoch ||
          (owner.management_state !== "active" && owner.management_state !== "draining")) throw conflict("App ownership changed.");
        if (owner.management_state === "draining" && transfer.drain_management_epoch !== owner.management_epoch) throw conflict("Another app management drain is active.");
        // #lockedTransfer took Capsule then transfer. Keep Runs last, matching
        // canonical admission's Capsule -> Runs order while fencing Source sync.
        await tx.query(`lock table takosumi_runs in share row exclusive mode`);
        // Persist drain on the first call; a caller retries after in-flight Runs settle.
        if (owner.management_state === "active") {
          await tx.query(
            `update takosumi_capsules set management_state='draining',management_epoch=management_epoch+1,
             installation_json=jsonb_set(jsonb_set(installation_json,'{managementState}','"draining"'::jsonb),'{managementEpoch}',to_jsonb(management_epoch+1))
             where id=$1`,
            [transfer.capsule_id],
          );
          await tx.query(`update takosumi_capsule_ownership_transfers set drain_management_epoch=$2 where id=$1`,
            [transfer.id, owner.management_epoch + 1]);
        }
        const queued = await tx.query<RunRow>(
          `select id,kind,status,lease_token,run_json from takosumi_runs
           where installation_id=$1 and status in ('queued','waiting_approval') limit 81 for update`,
          [transfer.capsule_id],
        );
        const nowMs = Date.now();
        for (const row of queued.rows.slice(0, 80)) {
          const settled = transferDrainRun(row, nowMs);
          if (!settled) continue;
          await tx.query(
            `update takosumi_runs set status=$2,lease_token=null,heartbeat_at=null,run_json=$3::jsonb where id=$1`,
            [row.id, settled.status, JSON.stringify(settled.run)],
          );
          if (row.kind === "plan" || row.kind === "destroy_plan") {
            await tx.query(`delete from takosumi_plan_run_inputs where plan_run_id=$1`, [row.id]);
          }
        }
        const ambiguousSource = await tx.query<{ id: string }>(
          `select r.id from takosumi_runs r
           join takosumi_capsules c on c.id=$1 and c.source_id=r.source_id
           join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
             and s.source_json->>'ownerCapsuleId' is distinct from $1 limit 1`,
          [transfer.capsule_id],
        );
        if (ambiguousSource.rows.length > 0) throw conflict("Source sync cannot be attributed to this app safely.");
        const sourceRows = await tx.query<RunRow>(
          `select r.id,r.kind,r.status,r.lease_token,r.run_json,r.source_id
           from takosumi_runs r join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
             and s.source_json->>'ownerCapsuleId'=$1
           limit 81 for update of r,s`,
          [transfer.capsule_id],
        );
        if (sourceRows.rows.length > 80) throw conflict("Too many active Source sync Runs for atomic transfer drain.");
        for (const row of sourceRows.rows) {
          if (row.status !== "queued") continue;
          await tx.query(
            `update takosumi_runs set status='failed',lease_token=null,heartbeat_at=null,run_json=$2::jsonb where id=$1`,
            [row.id, JSON.stringify(failedSourceSync(row, nowMs, "app_ownership_transfer_draining",
              "App ownership transfer stopped this source sync before it started."))],
          );
        }
        const active = await tx.query<{ id: string }>(
          `select r.id from takosumi_runs r left join takosumi_sources s on s.id=r.source_id
           where (r.installation_id=$1 or (r.kind='source_sync' and s.source_json->>'ownerCapsuleId'=$1))
             and (r.status in ('queued','running','waiting_approval') or r.lease_token is not null) limit 1`,
          [transfer.capsule_id],
        );
        if (active.rows.length > 0) return { transferId: input.transferId, state: "pending" as const };
        const now = new Date().toISOString();
        await tx.query(`delete from takosumi_provider_env_binding_sets where installation_id=$1`, [transfer.capsule_id]);
        // The owner is represented only by capsules.owner_account_id. A prior
        // member row for the recipient must not survive the ownership swap.
        await tx.query(`delete from takosumi_capsule_members where capsule_id=$1 and account_id=$2`,
          [transfer.capsule_id, transfer.to_account_id]);
        await tx.query(
          `update takosumi_capsules set owner_account_id=$2,ownership_epoch=ownership_epoch+1,
           management_state='active',management_epoch=management_epoch+1,
           installation_json=jsonb_set(jsonb_set(jsonb_set(jsonb_set(installation_json,'{ownerAccountId}',to_jsonb($2::text)),'{ownershipEpoch}',to_jsonb(ownership_epoch+1)),'{managementState}','"active"'::jsonb),'{managementEpoch}',to_jsonb(management_epoch+1))
           where id=$1`,
          [transfer.capsule_id, transfer.to_account_id],
        );
        await tx.query(`update takosumi_capsule_ownership_transfers set state='accepted',updated_at=$2 where id=$1`, [input.transferId, now]);
        return { transferId: input.transferId, state: "accepted" as const };
      });
    } catch (error) { withSchemaError(error); }
  }
}

function memberStatus(status: string): "active" | "invited" {
  if (status === "active" || status === "invited") return status;
  throw unavailable();
}

/** D1 mutations use one atomic batch with in-batch invalid-row guards. */
export class D1AppAuthorizationStore implements AppAuthorizationMutations {
  constructor(readonly db: D1Like, readonly access: AppAccessResolver) {}
  resolveAppAccess(accountId: string, capsuleId: string) { return this.access.resolveAppAccess(accountId, capsuleId); }
  listAccessibleApps(accountId: string, page?: { cursor?: string; limit?: number }) { return this.access.listAccessibleApps(accountId, page); }

  #batch(statements: readonly D1LikePreparedStatement[]) {
    if (!this.db.batch) throw unavailable();
    return this.db.batch(statements);
  }
  #guard(condition: string, values: readonly unknown[]): D1LikePreparedStatement {
    // A failed guard attempts an impossible CHECK value and rolls back every
    // statement in the D1 batch. The transfer table migration is mandatory.
    return this.db.prepare(
      `insert into capsule_ownership_transfers
       (id,capsule_id,from_account_id,to_account_id,ownership_epoch,state,created_at,updated_at)
       select hex(randomblob(16)),'guard','guard','guard',0,'invalid','guard','guard'
       where not (${condition})`,
    ).bind(...values);
  }
  #owner(id: string) {
    return this.db.prepare(
      `select owner_account_id,ownership_epoch,management_state,management_epoch from capsules where id=?`,
    ).bind(id).first<OwnerRow>();
  }
  #transfer(id: string) {
    return this.db.prepare(`select * from capsule_ownership_transfers where id=?`).bind(id).first<TransferRow>();
  }
  #ownerGuard(id: string, ownerId: string, epoch: number, state = "active") {
    return this.#guard(
      `exists(select 1 from capsules where id=? and owner_account_id=? and ownership_epoch=? and management_state=?)`,
      [id, ownerId, epoch, state],
    );
  }
  #transferGuard(transfer: TransferRow) {
    return this.#guard(
      `exists(select 1 from capsule_ownership_transfers where id=? and capsule_id=? and
       from_account_id=? and to_account_id=? and ownership_epoch=? and drain_management_epoch is ? and state='pending')`,
      [transfer.id, transfer.capsule_id, transfer.from_account_id, transfer.to_account_id, transfer.ownership_epoch, transfer.drain_management_epoch],
    );
  }
  async #safe<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) {
      if (error instanceof AppAuthorizationError) throw error;
      if (schemaError(error)) throw unavailable();
      const message = error instanceof Error ? error.message : String(error);
      if (/CHECK constraint failed.*(state|capsule_ownership_transfers)|constraint failed.*invalid/i.test(message)) {
        throw conflict("App ownership changed during the write.");
      }
      throw unavailable();
    }
  }
  async listMembers(capsuleId: string) {
    return this.#safe(async () => {
      const [owners, memberRows] = await this.#batch([
        this.db.prepare(`select owner_account_id,ownership_epoch from capsules where id=?`).bind(capsuleId),
        this.db.prepare(`select account_id,status from capsule_members where capsule_id=? order by account_id`).bind(capsuleId),
      ]);
      const owner = owners?.results?.[0] as Pick<OwnerRow, "owner_account_id" | "ownership_epoch"> | undefined;
      if (!owner?.owner_account_id) throw unavailable();
      const members = (memberRows?.results ?? []) as readonly MemberRow[];
      return {
        ownerAccountId: owner.owner_account_id,
        ownershipEpoch: owner.ownership_epoch,
        members: members.map((row) => ({ accountId: row.account_id, status: memberStatus(row.status) })),
      };
    });
  }
  async addMember(input: MemberMutationInput): Promise<AppAuthorizationMember> {
    return this.#safe(async () => {
      requireOwner((await this.#owner(input.capsuleId)) ?? undefined, input);
      if (input.accountId === input.actorAccountId) throw conflict("Owner cannot be a member.");
      const now = new Date().toISOString();
      await this.#batch([
        this.#ownerGuard(input.capsuleId, input.actorAccountId, input.expectedOwnershipEpoch),
        this.db.prepare(
          `insert into capsule_members (capsule_id,account_id,status,added_by,created_at,updated_at)
           values (?,?,'active',?,?,?)
           on conflict(capsule_id,account_id) do update set status='active',added_by=excluded.added_by,updated_at=excluded.updated_at`,
        ).bind(input.capsuleId, input.accountId, input.actorAccountId, now, now),
      ]);
      return { accountId: input.accountId, status: "active" };
    });
  }
  async removeMember(input: MemberMutationInput): Promise<void> {
    return this.#safe(async () => {
      const owner = await this.#owner(input.capsuleId);
      if (!owner?.owner_account_id) throw unavailable();
      if (owner.ownership_epoch !== input.expectedOwnershipEpoch || owner.management_state !== "active") throw conflict("App ownership or management state changed.");
      if (input.accountId === owner.owner_account_id || (input.actorAccountId !== owner.owner_account_id && input.actorAccountId !== input.accountId)) {
        throw new AppAuthorizationError("app_owner_only", "Only the owner or departing member may remove membership.");
      }
      const member = await this.db.prepare(
        `select account_id,status from capsule_members where capsule_id=? and account_id=?`,
      ).bind(input.capsuleId, input.accountId).first<MemberRow>();
      if (!member) throw new AppAuthorizationError("not_found", "Member was not found.");
      const result = await this.db.prepare(
        `select id,type as kind,status,lease_token,run_json from runs
         where installation_id=? and status in ('queued','waiting_approval','running') limit 81`,
      ).bind(input.capsuleId).all<RunRow>();
      const activeRows = result.results ?? [];
      if (activeRows.length > 80) throw conflict("Too many active Runs for atomic member removal.");
      const planIds = activeRows.flatMap((row) => {
        const planId = parseRunJson(row).planRunId;
        return typeof planId === "string" ? [planId] : [];
      });
      const plans: RunRow[] = [];
      for (const id of new Set(planIds)) {
        const plan = await this.db.prepare(`select id,type as kind,status,lease_token,run_json from runs where id=?`).bind(id).first<RunRow>();
        if (!plan) throw conflict("Apply Run has no Plan authority.");
        plans.push(plan);
      }
      const ambiguousSource = await this.db.prepare(
        `select r.id from runs r
         join capsules c on c.id=? and c.source_id=r.source_id
         join sources s on s.id=r.source_id
         where r.type='source_sync' and r.status in ('queued','running')
           and json_extract(r.run_json,'$.actorAccountId')=?
           and json_extract(s.record_json,'$.ownerCapsuleId') is not ?
         limit 1`,
      ).bind(input.capsuleId, input.accountId, input.capsuleId).first<{ id: string }>();
      if (ambiguousSource) throw conflict("Source sync cannot be attributed to this app safely.");
      const sourceResult = await this.db.prepare(
        `select r.id,r.type as kind,r.status,r.lease_token,r.run_json,r.source_id
         from runs r join sources s on s.id=r.source_id
         where r.type='source_sync' and r.status in ('queued','running')
           and json_extract(r.run_json,'$.actorAccountId')=?
           and json_extract(s.record_json,'$.ownerCapsuleId')=?
         limit 81`,
      ).bind(input.accountId, input.capsuleId).all<RunRow>();
      const sourceRows = sourceResult.results ?? [];
      if (sourceRows.length > 80) throw conflict("Too many active Source sync Runs for atomic member removal.");
      if (sourceRows.some((row) => row.status === "running" || row.lease_token !== null)) {
        throw conflict("Member has an active Source sync Run; removal must wait for it to settle.");
      }
      const all = [...activeRows, ...plans];
      const byId = new Map(all.map((row) => [row.id, row]));
      const owned = (row: RunRow): boolean => {
        const run = parseRunJson(row);
        const plan = typeof run.planRunId === "string" ? byId.get(run.planRunId) : undefined;
        return run.createdBy === input.accountId || (plan && parseRunJson(plan).createdBy === input.accountId) === true;
      };
      if (all.some((row) => row.status === "running" && owned(row))) throw conflict("Member has an active Run; removal must wait for it to settle.");
      const cancels = targetRuns(all, input.accountId);
      const statements: D1LikePreparedStatement[] = [
        this.#ownerGuard(input.capsuleId, owner.owner_account_id, input.expectedOwnershipEpoch),
        this.#guard(`exists(select 1 from capsule_members where capsule_id=? and account_id=?)`, [input.capsuleId, input.accountId]),
        // No new queued/running rows may appear after the read. Every observed
        // row is fenced exactly below, including unrelated actors' rows.
        this.#guard(
          `not exists(select 1 from runs where installation_id=? and status in ('queued','waiting_approval','running') and id not in (${activeRows.map(() => "?").join(",") || "''"}))`,
          [input.capsuleId, ...activeRows.map((row) => row.id)],
        ),
        this.#guard(
          `not exists(select 1 from runs r join sources s on s.id=r.source_id
           where r.type='source_sync' and r.status in ('queued','running')
             and json_extract(r.run_json,'$.actorAccountId')=?
             and json_extract(s.record_json,'$.ownerCapsuleId')=?
             and r.id not in (${sourceRows.map(() => "?").join(",") || "''"}))`,
          [input.accountId, input.capsuleId, ...sourceRows.map((row) => row.id)],
        ),
        this.#guard(
          `not exists(select 1 from runs r join sources s on s.id=r.source_id
           join capsules c on c.id=? and c.source_id=r.source_id
           where r.type='source_sync' and r.status in ('queued','running')
             and json_extract(r.run_json,'$.actorAccountId')=?
             and json_extract(s.record_json,'$.ownerCapsuleId') is not ?)`,
          [input.capsuleId, input.accountId, input.capsuleId],
        ),
      ];
      for (const row of all) {
        statements.push(this.#guard(
          `exists(select 1 from runs where id=? and status=? and run_json=? and lease_token is ?)`,
          [row.id, row.status, row.run_json, row.lease_token],
        ));
      }
      for (const row of sourceRows) {
        statements.push(this.#guard(
          `exists(select 1 from runs r join sources s on s.id=r.source_id
           where r.id=? and r.status=? and r.run_json=? and r.lease_token is ?
             and r.source_id=? and json_extract(s.record_json,'$.ownerCapsuleId')=?)`,
          [row.id, row.status, row.run_json, row.lease_token, row.source_id, input.capsuleId],
        ));
      }
      for (const { row, cancelled } of cancels) {
        statements.push(this.db.prepare(
          `update runs set status='cancelled',lease_token=null,heartbeat_at=null,run_json=? where id=?`,
        ).bind(JSON.stringify(cancelled), row.id));
        if (row.kind === "plan" || row.kind === "destroy_plan") {
          statements.push(this.db.prepare(`delete from runs_inputs where plan_run_id=?`).bind(row.id));
        }
      }
      const now = Date.now();
      for (const row of sourceRows) {
        statements.push(this.db.prepare(
          `update runs set status='failed',lease_token=null,heartbeat_at=null,run_json=? where id=?`,
        ).bind(JSON.stringify(revokedSourceSync(row, input.accountId, now)), row.id));
      }
      statements.push(this.db.prepare(`delete from capsule_members where capsule_id=? and account_id=?`).bind(input.capsuleId, input.accountId));
      await this.#batch(statements);
    });
  }
  async createTransfer(input: TransferCreationInput) {
    return this.#safe(async () => {
      requireOwner((await this.#owner(input.capsuleId)) ?? undefined, input);
      if (input.actorAccountId === input.toAccountId) throw conflict("Owner cannot transfer to self.");
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        await this.#batch([
          this.#ownerGuard(input.capsuleId, input.actorAccountId, input.expectedOwnershipEpoch),
          this.db.prepare(
            `insert into capsule_ownership_transfers
             (id,capsule_id,from_account_id,to_account_id,ownership_epoch,state,created_at,updated_at)
             values (?,?,?,?,?,'pending',?,?)`,
          ).bind(id, input.capsuleId, input.actorAccountId, input.toAccountId, input.expectedOwnershipEpoch, now, now),
        ]);
      } catch (error) {
        if (/capsule_ownership_transfers_one_pending|UNIQUE constraint failed: capsule_ownership_transfers.capsule_id/i.test(String(error))) throw pending();
        throw error;
      }
      return { transferId: id, state: "pending" as const };
    });
  }
  async getTransfer(id: string) {
    return this.#safe(async () => transferRecord((await this.#transfer(id)) ?? undefined));
  }
  async cancelTransfer(input: { transferId: string; actorAccountId: string }): Promise<void> {
    return this.#safe(async () => {
      const transfer = requireTransfer((await this.#transfer(input.transferId)) ?? undefined, input.actorAccountId, "cancel");
      const owner = await this.#owner(transfer.capsule_id);
      if (owner?.owner_account_id !== transfer.from_account_id || owner.ownership_epoch !== transfer.ownership_epoch) throw conflict("App ownership changed.");
      if (owner.management_state === "draining" && transfer.drain_management_epoch !== owner.management_epoch) throw conflict("Another app management drain is active.");
      const now = new Date().toISOString();
      const statements = [
        this.#transferGuard(transfer),
        this.#ownerGuard(transfer.capsule_id, transfer.from_account_id, transfer.ownership_epoch, owner.management_state),
        this.db.prepare(`update capsule_ownership_transfers set state='cancelled',updated_at=? where id=?`).bind(now, input.transferId),
      ];
      if (owner.management_state === "draining") {
        statements.push(this.db.prepare(
          `update capsules set management_state='active',management_epoch=management_epoch+1,
           record_json=json_set(record_json,'$.managementState','active','$.managementEpoch',management_epoch+1)
           where id=?`,
        ).bind(transfer.capsule_id));
      }
      await this.#batch(statements);
    });
  }
  async acceptTransfer(input: { transferId: string; actorAccountId: string }) {
    return this.#safe(async () => {
      const transfer = requireTransfer((await this.#transfer(input.transferId)) ?? undefined, input.actorAccountId, "accept");
      const owner = await this.#owner(transfer.capsule_id);
      if (owner?.owner_account_id !== transfer.from_account_id || owner.ownership_epoch !== transfer.ownership_epoch ||
        (owner.management_state !== "active" && owner.management_state !== "draining")) throw conflict("App ownership changed.");
      if (owner.management_state === "draining" && transfer.drain_management_epoch !== owner.management_epoch) throw conflict("Another app management drain is active.");
      if (owner.management_state === "active") {
        await this.#batch([
          this.#transferGuard(transfer),
          this.#ownerGuard(transfer.capsule_id, transfer.from_account_id, transfer.ownership_epoch),
          this.db.prepare(`update capsule_ownership_transfers set drain_management_epoch=? where id=?`).bind(owner.management_epoch + 1, transfer.id),
          this.db.prepare(
            `update capsules set management_state='draining',management_epoch=management_epoch+1,
             record_json=json_set(record_json,'$.managementState','draining','$.managementEpoch',management_epoch+1)
             where id=?`,
          ).bind(transfer.capsule_id),
        ]);
        transfer.drain_management_epoch = owner.management_epoch + 1;
      }
      const queuedResult = await this.db.prepare(
        `select id,type as kind,status,lease_token,run_json from runs
         where installation_id=? and status in ('queued','waiting_approval') limit 81`,
      ).bind(transfer.capsule_id).all<RunRow>();
      const queuedRows = queuedResult.results ?? [];
      const ambiguousSource = await this.db.prepare(
        `select r.id from runs r
         join capsules c on c.id=? and c.source_id=r.source_id
         join sources s on s.id=r.source_id
         where r.type='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
           and json_extract(s.record_json,'$.ownerCapsuleId') is not ? limit 1`,
      ).bind(transfer.capsule_id, transfer.capsule_id).first<{ id: string }>();
      if (ambiguousSource) throw conflict("Source sync cannot be attributed to this app safely.");
      const sourceResult = await this.db.prepare(
        `select r.id,r.type as kind,r.status,r.lease_token,r.run_json,r.source_id
         from runs r join sources s on s.id=r.source_id
         where r.type='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
           and json_extract(s.record_json,'$.ownerCapsuleId')=? limit 81`,
      ).bind(transfer.capsule_id).all<RunRow>();
      const sourceRows = sourceResult.results ?? [];
      if (sourceRows.length > 80) throw conflict("Too many active Source sync Runs for atomic transfer drain.");
      const nowMs = Date.now();
      const settleStatements: D1LikePreparedStatement[] = [
        this.#transferGuard(transfer),
        this.#ownerGuard(transfer.capsule_id, transfer.from_account_id, transfer.ownership_epoch, "draining"),
        this.#guard(
          `not exists(select 1 from runs where installation_id=? and status in ('queued','waiting_approval')
           and id not in (${queuedRows.map(() => "?").join(",") || "''"}))`,
          [transfer.capsule_id, ...queuedRows.map((row) => row.id)],
        ),
        this.#guard(
          `not exists(select 1 from runs r join sources s on s.id=r.source_id
           where r.type='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
             and json_extract(s.record_json,'$.ownerCapsuleId')=?
             and r.id not in (${sourceRows.map(() => "?").join(",") || "''"}))`,
          [transfer.capsule_id, ...sourceRows.map((row) => row.id)],
        ),
        this.#guard(
          `not exists(select 1 from runs r join sources s on s.id=r.source_id
           join capsules c on c.id=? and c.source_id=r.source_id
           where r.type='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
             and json_extract(s.record_json,'$.ownerCapsuleId') is not ?)`,
          [transfer.capsule_id, transfer.capsule_id],
        ),
      ];
      for (const row of queuedRows) {
        settleStatements.push(this.#guard(
          `exists(select 1 from runs where id=? and status=? and run_json=? and lease_token is ?)`,
          [row.id, row.status, row.run_json, row.lease_token],
        ));
      }
      for (const row of sourceRows) {
        settleStatements.push(this.#guard(
          `exists(select 1 from runs r join sources s on s.id=r.source_id
           where r.id=? and r.status=? and r.run_json=? and r.lease_token is ?
             and r.source_id=? and json_extract(s.record_json,'$.ownerCapsuleId')=?)`,
          [row.id, row.status, row.run_json, row.lease_token, row.source_id, transfer.capsule_id],
        ));
      }
      for (const row of queuedRows.slice(0, 80)) {
        const settled = transferDrainRun(row, nowMs);
        if (!settled) continue;
        settleStatements.push(this.db.prepare(
          `update runs set status=?,lease_token=null,heartbeat_at=null,run_json=? where id=?`,
        ).bind(settled.status, JSON.stringify(settled.run), row.id));
        if (row.kind === "plan" || row.kind === "destroy_plan") {
          settleStatements.push(this.db.prepare(`delete from runs_inputs where plan_run_id=?`).bind(row.id));
        }
      }
      for (const row of sourceRows) {
        if (row.status !== "queued") continue;
        settleStatements.push(this.db.prepare(
          `update runs set status='failed',lease_token=null,heartbeat_at=null,run_json=? where id=?`,
        ).bind(JSON.stringify(failedSourceSync(row, nowMs, "app_ownership_transfer_draining",
          "App ownership transfer stopped this source sync before it started.")), row.id));
      }
      await this.#batch(settleStatements);
      const active = await this.db.prepare(
        `select r.id from runs r left join sources s on s.id=r.source_id
         where (r.installation_id=? or (r.type='source_sync' and json_extract(s.record_json,'$.ownerCapsuleId')=?))
           and (r.status in ('queued','running','waiting_approval') or r.lease_token is not null) limit 1`,
      ).bind(transfer.capsule_id, transfer.capsule_id).first<{ id: string }>();
      if (active) return { transferId: input.transferId, state: "pending" as const };
      const now = new Date().toISOString();
      await this.#batch([
        this.#transferGuard(transfer),
        this.#ownerGuard(transfer.capsule_id, transfer.from_account_id, transfer.ownership_epoch, "draining"),
        this.#guard(
          `not exists(select 1 from runs r left join sources s on s.id=r.source_id
           where (r.installation_id=? or (r.type='source_sync' and json_extract(s.record_json,'$.ownerCapsuleId')=?))
             and (r.status in ('queued','running','waiting_approval') or r.lease_token is not null))`,
          [transfer.capsule_id, transfer.capsule_id],
        ),
        this.#guard(
          `not exists(select 1 from runs r join sources s on s.id=r.source_id
           join capsules c on c.id=? and c.source_id=r.source_id
           where r.type='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
             and json_extract(s.record_json,'$.ownerCapsuleId') is not ?)`,
          [transfer.capsule_id, transfer.capsule_id],
        ),
        this.db.prepare(`delete from provider_env_binding_sets where installation_id=?`).bind(transfer.capsule_id),
        this.db.prepare(`delete from capsule_members where capsule_id=? and account_id=?`).bind(transfer.capsule_id, transfer.to_account_id),
        this.db.prepare(
          `update capsules set owner_account_id=?,ownership_epoch=ownership_epoch+1,
           management_state='active',management_epoch=management_epoch+1,
           record_json=json_set(record_json,'$.ownerAccountId',?,'$.ownershipEpoch',ownership_epoch+1,
             '$.managementState','active','$.managementEpoch',management_epoch+1)
           where id=?`,
        ).bind(transfer.to_account_id, transfer.to_account_id, transfer.capsule_id),
        this.db.prepare(`update capsule_ownership_transfers set state='accepted',updated_at=? where id=?`).bind(now, input.transferId),
      ]);
      return { transferId: input.transferId, state: "accepted" as const };
    });
  }
}
