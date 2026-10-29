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
  listTransfers(input: { readonly capsuleId?: string; readonly toAccountId?: string; readonly state: "pending" }): Promise<readonly AppAuthorizationTransfer[]>;
  acceptTransfer(input: { readonly transferId: string; readonly actorAccountId: string }): Promise<{ readonly transferId: string; readonly state: "pending" | "accepted" }>;
  cancelTransfer(input: { readonly transferId: string; readonly actorAccountId: string }): Promise<void>;
}

export interface MemberMutationInput {
  readonly capsuleId: string;
  readonly actorAccountId: string;
  readonly accountId: string;
  readonly expectedOwnershipEpoch: number;
  readonly consent: "connections_and_code";
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
  space_id: string;
  source_id: string | null;
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
type RunRow = { id: string; kind: string; status: string; lease_token: string | null; run_json: unknown;
  source_id?: string | null; space_id?: string | null; source_space_id?: string | null; source_json?: unknown };

function ownershipEvent(input: { spaceId: string; capsuleId: string; actorId: string; action: string;
  targetId: string; consent?: "connections_and_code"; recipientAccountId?: string }) {
  const createdAt = new Date().toISOString();
  return { id: crypto.randomUUID(), workspaceId: input.spaceId, actorId: input.actorId,
    action: input.action, targetType: "capsule", targetId: input.capsuleId,
    memberAccountId: input.targetId, ...(input.consent ? { consent: input.consent } : {}),
    ...(input.recipientAccountId ? { recipientAccountId: input.recipientAccountId } : {}), createdAt };
}

async function sqlOwnershipEvent(tx: SqlClient, event: ReturnType<typeof ownershipEvent>): Promise<void> {
  await tx.query(`insert into takosumi_audit_events
    (id,space_id,actor_id,action,target_type,target_id,run_id,event_json,created_at)
    values ($1,$2,$3,$4,$5,$6,null,$7::jsonb,$8)`,
    [event.id, event.workspaceId, event.actorId, event.action, event.targetType,
      event.targetId, JSON.stringify(event), event.createdAt]);
}

const unavailable = () => new AppAuthorizationError("feature_unavailable", "App ownership storage is unavailable.");
const conflict = (message: string) => new AppAuthorizationError("conflict", message);
const pending = () => new AppAuthorizationError("ownership_transfer_pending", "App management is draining; retry after active Runs settle.");
const MAX_RECIPIENT_PENDING_TRANSFERS = 50;
const MAX_OWNER_TRANSFERS_PER_HOUR = 10;
const transferLimit = () => new AppAuthorizationError("conflict", "Ownership transfer limit reached; retry later.");

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

function assertSourceRunScope(row: RunRow, owner: OwnerRow, capsuleId: string): void {
  let source: Record<string, unknown> | undefined;
  try {
    source = typeof row.source_json === "string" ? JSON.parse(row.source_json) as Record<string, unknown>
      : row.source_json as Record<string, unknown> | undefined;
  } catch { throw conflict("Source sync app or Workspace linkage is inconsistent."); }
  const run = parseRunJson(row);
  if (row.kind !== "source_sync" || !owner.source_id || row.source_id !== owner.source_id ||
    row.space_id !== owner.space_id || row.source_space_id !== owner.space_id ||
    !source || typeof source !== "object" || Array.isArray(source) ||
    source.id !== row.source_id || source.workspaceId !== owner.space_id ||
    source.ownerCapsuleId !== capsuleId || run.kind !== "source_sync" ||
    run.workspaceId !== owner.space_id || run.sourceId !== row.source_id) {
    throw conflict("Source sync app or Workspace linkage is inconsistent.");
  }
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
    const approval = run.approval && typeof run.approval === "object" && !Array.isArray(run.approval)
      ? run.approval as Record<string, unknown> : undefined;
    const requesters = [run.createdBy, planCreator(run.planRunId), approval?.approvedBy];
    if (!requesters.includes(actor)) return [];
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
      `select owner_account_id, ownership_epoch, management_state, management_epoch,space_id,source_id
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
    if (input.consent !== "connections_and_code") throw new TypeError("Explicit member consent is required.");
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
        await sqlOwnershipEvent(tx, ownershipEvent({ spaceId: owner.space_id, capsuleId: input.capsuleId,
          actorId: input.actorAccountId, action: "app.member_added", targetId: input.accountId,
          consent: input.consent }));
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
        const member = await tx.query<{ account_id: string }>(
          `select account_id from takosumi_capsule_members where capsule_id=$1 and account_id=$2 for update`,
          [input.capsuleId, input.accountId],
        );
        if (member.rows.length !== 1) throw new AppAuthorizationError("not_found", "Member was not found.");
        // Source sync admission takes the Source lock and checks live membership.
        // Plan/Apply admission takes the Capsule lock. Keep Capsule -> Source ->
        // relevant Run rows, without locking every tenant's Runs table.
        if (owner.source_id) await tx.query(`select id from takosumi_sources where id=$1 for update`, [owner.source_id]);
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
           left join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and r.status in ('queued','running')
             and r.run_json->>'actorAccountId'=$2
             and s.source_json->>'ownerCapsuleId' is distinct from $1
           limit 1`,
          [input.capsuleId, input.accountId],
        );
        if (ambiguousSource.rows.length > 0) throw conflict("Source sync cannot be attributed to this app safely.");
        const sourceRows = await tx.query<RunRow>(
          `select r.id,r.kind,r.status,r.lease_token,r.run_json,r.source_id,r.space_id,
             s.space_id as source_space_id,s.source_json
           from takosumi_runs r join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and r.status in ('queued','running')
             and r.run_json->>'actorAccountId'=$2
             and s.source_json->>'ownerCapsuleId'=$1
           limit 81 for update of r,s`,
          [input.capsuleId, input.accountId],
        );
        if (sourceRows.rows.length > 80) throw conflict("Too many active Source sync Runs for atomic member removal.");
        for (const row of sourceRows.rows) assertSourceRunScope(row, owner, input.capsuleId);
        if (sourceRows.rows.some((row) => row.status === "queued" && row.lease_token !== null)) {
          throw conflict("A queued Source sync Run has a lease and cannot be revoked safely.");
        }
        const cancels = targetRuns([...rows.rows, ...plans], input.accountId).filter(({ row }) =>
          row.status === "queued" || row.status === "waiting_approval"
        );
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
          if (row.status !== "queued") continue;
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
        await sqlOwnershipEvent(tx, ownershipEvent({ spaceId: owner.space_id, capsuleId: input.capsuleId,
          actorId: input.actorAccountId, action: "app.member_removed", targetId: input.accountId,
          recipientAccountId: input.accountId }));
      });
    } catch (error) { withSchemaError(error); }
  }
  async createTransfer(input: TransferCreationInput) {
    try {
      return await this.client.transaction(async (tx) => {
        const owner = requireOwner(await this.#owner(tx, input.capsuleId, true), input);
        if (input.toAccountId === input.actorAccountId) throw conflict("Owner cannot transfer to self.");
        // Serialize limits across different Capsules and recipients.
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`transfer-sender:${input.actorAccountId}`]);
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`transfer-recipient:${input.toAccountId}`]);
        const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const limits = await tx.query<{ pending_count: string | number; recent_count: string | number }>(
          `select
             (select count(*) from takosumi_capsule_ownership_transfers where to_account_id=$1 and state='pending') as pending_count,
             (select count(*) from takosumi_capsule_ownership_transfers where from_account_id=$2 and created_at >= $3) as recent_count`,
          [input.toAccountId, input.actorAccountId, cutoff],
        );
        if (!limits.rows[0]) throw unavailable();
        if (Number(limits.rows[0].pending_count) >= MAX_RECIPIENT_PENDING_TRANSFERS ||
          Number(limits.rows[0].recent_count) >= MAX_OWNER_TRANSFERS_PER_HOUR) throw transferLimit();
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
        await sqlOwnershipEvent(tx, ownershipEvent({ spaceId: owner.space_id, capsuleId: input.capsuleId,
          actorId: input.actorAccountId, action: "app.ownership_transfer_created", targetId: input.toAccountId,
          recipientAccountId: input.toAccountId }));
        return { transferId, state: "pending" as const };
      });
    } catch (error) { withSchemaError(error); }
  }
  async getTransfer(id: string) {
    try { return transferRecord(await this.#transfer(this.client, id, false)); }
    catch (error) { withSchemaError(error); }
  }
  async listTransfers(input: { capsuleId?: string; toAccountId?: string; state: "pending" }) {
    if (input.state !== "pending" || Boolean(input.capsuleId) === Boolean(input.toAccountId)) throw new TypeError("Exactly one transfer scope is required.");
    const scope = input.capsuleId ?? input.toAccountId;
    if (!scope) throw new TypeError("Transfer scope is required.");
    try {
      const field = input.capsuleId ? "capsule_id" : "to_account_id";
      const rows = await this.client.query<TransferRow>(
        `select * from takosumi_capsule_ownership_transfers where ${field}=$1 and state='pending' order by created_at,id limit ${MAX_RECIPIENT_PENDING_TRANSFERS}`,
        [scope],
      );
      return rows.rows.map((row) => transferRecord(row)!);
    } catch (error) { withSchemaError(error); }
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
        await sqlOwnershipEvent(tx, ownershipEvent({ spaceId: owner.space_id, capsuleId: transfer.capsule_id,
          actorId: input.actorAccountId, action: "app.ownership_transfer_cancelled", targetId: transfer.to_account_id,
          recipientAccountId: transfer.to_account_id }));
        if (owner.management_state === "draining") {
          if (transfer.drain_management_epoch !== owner.management_epoch) throw conflict("Another app management drain is active.");
          await tx.query(
            `update takosumi_capsules set management_state='active',management_epoch=management_epoch+1
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
        // #lockedTransfer took Capsule then transfer; Source sync admission
        // takes the Source lock and fences management before inserting Runs.
        if (owner.source_id) await tx.query(`select id from takosumi_sources where id=$1 for update`, [owner.source_id]);
        // Persist drain on the first call; a caller retries after in-flight Runs settle.
        if (owner.management_state === "active") {
          await tx.query(
            `update takosumi_capsules set management_state='draining',management_epoch=management_epoch+1
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
           left join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
             and s.source_json->>'ownerCapsuleId' is distinct from $1 limit 1`,
          [transfer.capsule_id],
        );
        if (ambiguousSource.rows.length > 0) throw conflict("Source sync cannot be attributed to this app safely.");
        const sourceRows = await tx.query<RunRow>(
          `select r.id,r.kind,r.status,r.lease_token,r.run_json,r.source_id,r.space_id,
             s.space_id as source_space_id,s.source_json
           from takosumi_runs r join takosumi_sources s on s.id=r.source_id
           where r.kind='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
             and s.source_json->>'ownerCapsuleId'=$1
           limit 81 for update of r,s`,
          [transfer.capsule_id],
        );
        if (sourceRows.rows.length > 80) throw conflict("Too many active Source sync Runs for atomic transfer drain.");
        for (const row of sourceRows.rows) assertSourceRunScope(row, owner, transfer.capsule_id);
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
        const minting = await tx.query<{ id: string }>(
          `select id from takosumi_app_credential_mint_leases where capsule_id=$1 and expires_at>$2 limit 1`,
          [transfer.capsule_id, Date.now()],
        );
        if (minting.rows.length > 0) return { transferId: input.transferId, state: "pending" as const };
        const now = new Date().toISOString();
        await tx.query(`delete from takosumi_provider_env_binding_sets where installation_id=$1`, [transfer.capsule_id]);
        // The recipient did not consent to retaining the previous owner's
        // delegates. Capture every recipient before removing all memberships.
        const notify = await tx.query<{ account_id: string }>(
          `select account_id from takosumi_capsule_members where capsule_id=$1 order by account_id for update`,
          [transfer.capsule_id]);
        await tx.query(`delete from takosumi_capsule_members where capsule_id=$1`, [transfer.capsule_id]);
        await tx.query(
          `update takosumi_capsules set owner_account_id=$2,ownership_epoch=ownership_epoch+1,
           management_state='active',management_epoch=management_epoch+1
           where id=$1`,
          [transfer.capsule_id, transfer.to_account_id],
        );
        await tx.query(`update takosumi_capsule_ownership_transfers set state='accepted',updated_at=$2 where id=$1`, [input.transferId, now]);
        for (const accountId of new Set([transfer.from_account_id, ...notify.rows.map((row) => row.account_id)])) {
          await sqlOwnershipEvent(tx, ownershipEvent({ spaceId: owner.space_id, capsuleId: transfer.capsule_id,
            actorId: input.actorAccountId, action: "app.ownership_transferred", targetId: accountId,
            recipientAccountId: accountId }));
        }
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
  #event(event: ReturnType<typeof ownershipEvent>): D1LikePreparedStatement {
    return this.db.prepare(`insert into audit_events
      (id,space_id,actor_id,action,target_type,target_id,run_id,created_at,record_json)
      values (?,?,?,?,?,?,null,?,?)`).bind(event.id, event.workspaceId, event.actorId,
        event.action, event.targetType, event.targetId, event.createdAt, JSON.stringify(event));
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
      `select owner_account_id,ownership_epoch,management_state,management_epoch,space_id,source_id from capsules where id=?`,
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
      // #guard deliberately inserts state='invalid'. Match only the transfer
      // ledger's exact CHECK expression; unrelated SQL constraints remain
      // visible as storage errors rather than being misreported as a race.
      if (/(?:^|:\s)CHECK constraint failed: (?:capsule_ownership_transfers_state_check|state in \('pending','accepted','cancelled'\))$/.test(message)) {
        throw conflict("App ownership changed during the write.");
      }
      throw error;
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
    if (input.consent !== "connections_and_code") throw new TypeError("Explicit member consent is required.");
    return this.#safe(async () => {
      const owner = requireOwner((await this.#owner(input.capsuleId)) ?? undefined, input);
      if (input.accountId === input.actorAccountId) throw conflict("Owner cannot be a member.");
      const now = new Date().toISOString();
      await this.#batch([
        this.#ownerGuard(input.capsuleId, input.actorAccountId, input.expectedOwnershipEpoch),
        this.db.prepare(
          `insert into capsule_members (capsule_id,account_id,status,added_by,created_at,updated_at)
           values (?,?,'active',?,?,?)
           on conflict(capsule_id,account_id) do update set status='active',added_by=excluded.added_by,updated_at=excluded.updated_at`,
        ).bind(input.capsuleId, input.accountId, input.actorAccountId, now, now),
        this.#event(ownershipEvent({ spaceId: owner.space_id,
          capsuleId: input.capsuleId, actorId: input.actorAccountId, action: "app.member_added",
          targetId: input.accountId, consent: input.consent })),
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
         left join sources s on s.id=r.source_id
         where r.type='source_sync' and r.status in ('queued','running')
           and json_extract(r.run_json,'$.actorAccountId')=?
           and json_extract(s.record_json,'$.ownerCapsuleId') is not ?
         limit 1`,
      ).bind(input.capsuleId, input.accountId, input.capsuleId).first<{ id: string }>();
      if (ambiguousSource) throw conflict("Source sync cannot be attributed to this app safely.");
      const sourceResult = await this.db.prepare(
        `select r.id,r.type as kind,r.status,r.lease_token,r.run_json,r.source_id,r.space_id,
           s.space_id as source_space_id,s.record_json as source_json
         from runs r join sources s on s.id=r.source_id
         where r.type='source_sync' and r.status in ('queued','running')
           and json_extract(r.run_json,'$.actorAccountId')=?
           and json_extract(s.record_json,'$.ownerCapsuleId')=?
         limit 81`,
      ).bind(input.accountId, input.capsuleId).all<RunRow>();
      const sourceRows = sourceResult.results ?? [];
      if (sourceRows.length > 80) throw conflict("Too many active Source sync Runs for atomic member removal.");
      for (const row of sourceRows) assertSourceRunScope(row, owner, input.capsuleId);
      if (sourceRows.some((row) => row.status === "queued" && row.lease_token !== null)) {
        throw conflict("A queued Source sync Run has a lease and cannot be revoked safely.");
      }
      const all = [...activeRows, ...plans];
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
      // Group exact row CAS predicates into bounded statements. D1 executes
      // the entire batch transactionally; splitting into multiple batches
      // would allow membership to disappear after only some Runs settled.
      for (let offset = 0; offset < all.length; offset += 20) {
        const group = all.slice(offset, offset + 20);
        statements.push(this.#guard(
          group.map(() => `exists(select 1 from runs where id=? and status=? and run_json=? and lease_token is ?)`)
            .join(" and "),
          group.flatMap((row) => [row.id, row.status, row.run_json, row.lease_token]),
        ));
      }
      for (let offset = 0; offset < sourceRows.length; offset += 8) {
        const group = sourceRows.slice(offset, offset + 8);
        statements.push(this.#guard(
          group.map(() => `exists(select 1 from runs r join sources s on s.id=r.source_id
           where r.id=? and r.status=? and r.run_json=? and r.lease_token is ?
             and r.source_id=? and r.space_id=? and s.space_id=? and s.record_json=?
             and exists(select 1 from capsules c where c.id=? and c.space_id=? and c.source_id=?))`)
            .join(" and "),
          group.flatMap((row) => [row.id, row.status, row.run_json, row.lease_token,
            row.source_id, row.space_id, row.source_space_id, row.source_json,
            input.capsuleId, owner.space_id, owner.source_id]),
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
        if (row.status !== "queued") continue;
        statements.push(this.db.prepare(
          `update runs set status='failed',lease_token=null,heartbeat_at=null,run_json=? where id=?`,
        ).bind(JSON.stringify(revokedSourceSync(row, input.accountId, now)), row.id));
      }
      statements.push(this.db.prepare(`delete from capsule_members where capsule_id=? and account_id=?`).bind(input.capsuleId, input.accountId));
      statements.push(this.#event(ownershipEvent({ spaceId: owner.space_id, capsuleId: input.capsuleId,
        actorId: input.actorAccountId, action: "app.member_removed", targetId: input.accountId,
        recipientAccountId: input.accountId })));
      if (statements.length > 480) throw conflict("Too many active Runs for atomic member removal.");
      await this.#batch(statements);
    });
  }
  async createTransfer(input: TransferCreationInput) {
    return this.#safe(async () => {
      const owner = requireOwner((await this.#owner(input.capsuleId)) ?? undefined, input);
      if (input.actorAccountId === input.toAccountId) throw conflict("Owner cannot transfer to self.");
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      try {
        await this.#batch([
          this.#ownerGuard(input.capsuleId, input.actorAccountId, input.expectedOwnershipEpoch),
          this.#guard(`(select count(*) from capsule_ownership_transfers where to_account_id=? and state='pending')<?`,
            [input.toAccountId, MAX_RECIPIENT_PENDING_TRANSFERS]),
          this.#guard(`(select count(*) from capsule_ownership_transfers where from_account_id=? and created_at>=?)<?`,
            [input.actorAccountId, cutoff, MAX_OWNER_TRANSFERS_PER_HOUR]),
          this.db.prepare(
            `insert into capsule_ownership_transfers
             (id,capsule_id,from_account_id,to_account_id,ownership_epoch,state,created_at,updated_at)
             values (?,?,?,?,?,'pending',?,?)`,
          ).bind(id, input.capsuleId, input.actorAccountId, input.toAccountId, input.expectedOwnershipEpoch, now, now),
          this.#event(ownershipEvent({ spaceId: owner.space_id, capsuleId: input.capsuleId,
            actorId: input.actorAccountId, action: "app.ownership_transfer_created", targetId: input.toAccountId,
            recipientAccountId: input.toAccountId })),
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
  async listTransfers(input: { capsuleId?: string; toAccountId?: string; state: "pending" }) {
    if (input.state !== "pending" || Boolean(input.capsuleId) === Boolean(input.toAccountId)) throw new TypeError("Exactly one transfer scope is required.");
    return this.#safe(async () => {
      const field = input.capsuleId ? "capsule_id" : "to_account_id";
      const rows = await this.db.prepare(
        `select * from capsule_ownership_transfers where ${field}=? and state='pending' order by created_at,id limit ${MAX_RECIPIENT_PENDING_TRANSFERS}`,
      ).bind(input.capsuleId ?? input.toAccountId).all<TransferRow>();
      return (rows.results ?? []).map((row) => transferRecord(row)!);
    });
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
        this.#event(ownershipEvent({ spaceId: owner.space_id, capsuleId: transfer.capsule_id,
          actorId: input.actorAccountId, action: "app.ownership_transfer_cancelled", targetId: transfer.to_account_id,
          recipientAccountId: transfer.to_account_id })),
      ];
      if (owner.management_state === "draining") {
        statements.push(this.db.prepare(
          `update capsules set management_state='active',management_epoch=management_epoch+1
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
      const queuedResult = await this.db.prepare(
        `select id,type as kind,status,lease_token,run_json from runs
         where installation_id=? and status in ('queued','waiting_approval') limit 81`,
      ).bind(transfer.capsule_id).all<RunRow>();
      const queuedRows = queuedResult.results ?? [];
      const ambiguousSource = await this.db.prepare(
        `select r.id from runs r
         join capsules c on c.id=? and c.source_id=r.source_id
         left join sources s on s.id=r.source_id
         where r.type='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
           and json_extract(s.record_json,'$.ownerCapsuleId') is not ? limit 1`,
      ).bind(transfer.capsule_id, transfer.capsule_id).first<{ id: string }>();
      if (ambiguousSource) throw conflict("Source sync cannot be attributed to this app safely.");
      const sourceResult = await this.db.prepare(
        `select r.id,r.type as kind,r.status,r.lease_token,r.run_json,r.source_id,r.space_id,
           s.space_id as source_space_id,s.record_json as source_json
         from runs r join sources s on s.id=r.source_id
         where r.type='source_sync' and (r.status in ('queued','running') or r.lease_token is not null)
           and json_extract(s.record_json,'$.ownerCapsuleId')=? limit 81`,
      ).bind(transfer.capsule_id).all<RunRow>();
      const sourceRows = sourceResult.results ?? [];
      if (sourceRows.length > 80) throw conflict("Too many active Source sync Runs for atomic transfer drain.");
      for (const row of sourceRows) assertSourceRunScope(row, owner, transfer.capsule_id);
      const nowMs = Date.now();
      const settleStatements: D1LikePreparedStatement[] = [
        this.#transferGuard(transfer),
        this.#ownerGuard(transfer.capsule_id, transfer.from_account_id, transfer.ownership_epoch, owner.management_state),
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
             and r.source_id=? and r.space_id=? and s.space_id=? and s.record_json=?
             and exists(select 1 from capsules c where c.id=? and c.space_id=? and c.source_id=?))`,
          [row.id, row.status, row.run_json, row.lease_token, row.source_id, row.space_id,
            row.source_space_id, row.source_json, transfer.capsule_id, owner.space_id, owner.source_id],
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
      if (owner.management_state === "active") {
        settleStatements.push(
          this.db.prepare(`update capsule_ownership_transfers set drain_management_epoch=? where id=?`)
            .bind(owner.management_epoch + 1, transfer.id),
          this.db.prepare(
            `update capsules set management_state='draining',management_epoch=management_epoch+1
             where id=?`,
          ).bind(transfer.capsule_id),
        );
      }
      if (settleStatements.length > 480) throw conflict("Too many active Runs for atomic transfer drain.");
      await this.#batch(settleStatements);
      if (owner.management_state === "active") transfer.drain_management_epoch = owner.management_epoch + 1;
      const active = await this.db.prepare(
        `select r.id from runs r left join sources s on s.id=r.source_id
         where (r.installation_id=? or (r.type='source_sync' and json_extract(s.record_json,'$.ownerCapsuleId')=?))
           and (r.status in ('queued','running','waiting_approval') or r.lease_token is not null) limit 1`,
      ).bind(transfer.capsule_id, transfer.capsule_id).first<{ id: string }>();
      if (active) return { transferId: input.transferId, state: "pending" as const };
      const minting = await this.db.prepare(
        `select id from app_credential_mint_leases where capsule_id=? and expires_at>? limit 1`,
      ).bind(transfer.capsule_id, Date.now()).first<{ id: string }>();
      if (minting) return { transferId: input.transferId, state: "pending" as const };
      const now = new Date().toISOString();
      const members = await this.db.prepare(`select account_id from capsule_members where capsule_id=?`)
        .bind(transfer.capsule_id).all<{ account_id: string }>();
      const memberIds = (members.results ?? []).map((row) => row.account_id);
      const notifications = [...new Set([transfer.from_account_id, ...memberIds])];
      const finalStatements: D1LikePreparedStatement[] = [
        this.#transferGuard(transfer),
        this.#ownerGuard(transfer.capsule_id, transfer.from_account_id, transfer.ownership_epoch, "draining"),
        this.#guard(
          `not exists(select 1 from capsule_members where capsule_id=? and account_id not in (select value from json_each(?)))
           and (select count(*) from capsule_members where capsule_id=?)=?`,
          [transfer.capsule_id, JSON.stringify(memberIds), transfer.capsule_id, memberIds.length],
        ),
        this.#guard(`not exists(select 1 from app_credential_mint_leases where capsule_id=? and expires_at>?)`,
          [transfer.capsule_id, Date.now()]),
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
        this.db.prepare(`delete from capsule_members where capsule_id=?`).bind(transfer.capsule_id),
        this.db.prepare(
          `update capsules set owner_account_id=?,ownership_epoch=ownership_epoch+1,
           management_state='active',management_epoch=management_epoch+1
           where id=?`,
        ).bind(transfer.to_account_id, transfer.capsule_id),
        this.db.prepare(`update capsule_ownership_transfers set state='accepted',updated_at=? where id=?`).bind(now, input.transferId),
        ...notifications.map((accountId) => this.#event(ownershipEvent({ spaceId: owner.space_id,
          capsuleId: transfer.capsule_id, actorId: input.actorAccountId,
          action: "app.ownership_transferred", targetId: accountId,
          recipientAccountId: accountId }))),
      ];
      if (finalStatements.length > 480) throw conflict("Too many members for atomic ownership transfer.");
      await this.#batch(finalStatements);
      return { transferId: input.transferId, state: "accepted" as const };
    });
  }
}
