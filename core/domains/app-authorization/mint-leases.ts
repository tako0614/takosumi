import type { SqlClient, SqlTransaction } from "../../adapters/storage/sql.ts";
import type { D1Like } from "../../adapters/storage/d1.ts";
import { InMemoryOpenTofuControlStore } from "../deploy-control/store.ts";
import { stableStringify } from "../../adapters/source/digest.ts";

/** A value-free, short-lived fence around an external credential driver call. */
export interface AppMintLease {
  readonly id: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly ownerAccountId: string;
  readonly ownershipEpoch: number;
  readonly managementEpoch: number;
  readonly actorAccountIds: readonly string[];
  /** Private, value-free connection row snapshots captured at begin. */
  readonly connections: readonly AppMintConnectionSnapshot[];
  readonly expiresAt: number;
  readonly createdAt: string;
}

export interface AppMintConnectionBinding {
  readonly id: string;
  /** Only Vault's immutable operator descriptor map may assert release-owned. */
  readonly authority: "stored" | "release-owned";
  /** Vault's exact observed descriptor before the lease begins. */
  readonly expectedConnection: unknown;
}

export interface AppMintConnectionSnapshot extends Omit<AppMintConnectionBinding, "expectedConnection"> {
  readonly status?: string;
  readonly ownerAccountId?: string | null;
  readonly connectionJson?: string;
}

export interface AppMintLeaseBeginInput {
  readonly capsuleId: string;
  readonly runId: string;
  readonly expectedOwnerAccountId: string;
  readonly expectedOwnershipEpoch: number;
  readonly expectedManagementEpoch: number;
  /** Must equal the actors derived from the persisted Run, not caller authority. */
  readonly expectedActorAccountIds: readonly string[];
  readonly connections: readonly AppMintConnectionBinding[];
}

export interface AppMintLeaseStore {
  /** Undefined means authority changed. Storage/schema errors fail closed by throwing. */
  begin(input: AppMintLeaseBeginInput): Promise<AppMintLease | undefined>;
  /** Only true permits releasing a credential. Every result consumes the lease. */
  finish(lease: AppMintLease, disposition: "issued" | "discarded"): Promise<boolean>;
}

const MAX_TTL_MS = 120_000;
type ClockOptions = { readonly now?: () => number; readonly ttlMs?: number };
type CapsuleRow = { owner_account_id: string | null; ownership_epoch: number; management_state: string;
  management_epoch: number; space_id: string; source_id: string | null };
type RunRow = { id: string; kind: string; status: string; lease_token: string | null; space_id: string;
  installation_id: string | null; source_id: string | null; run_json: unknown };
type SourceRow = { id: string; space_id: string; source_json: unknown };
type ConnectionRow = { id: string; status: string; owner_account_id: string | null; connection_json: unknown };
type Snapshot = { capsule: CapsuleRow; run: RunRow; plan?: RunRow; source?: SourceRow;
  connections: readonly AppMintConnectionSnapshot[] };

function connectionBindings(value: readonly AppMintConnectionBinding[]): boolean {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => item && typeof item.id === "string" && item.id.trim() &&
      (item.authority === "stored" || item.authority === "release-owned") &&
      object(item.expectedConnection)?.id === item.id) &&
    new Set(value.map((item) => item.id)).size === value.length;
}

function connectionSnapshots(input: AppMintLeaseBeginInput,
  rows: readonly (ConnectionRow | undefined)[]): readonly AppMintConnectionSnapshot[] | undefined {
  if (!connectionBindings(input.connections) || rows.length !== input.connections.length) return undefined;
  const snapshots: AppMintConnectionSnapshot[] = [];
  for (const [index, binding] of input.connections.entries()) {
    const row = rows[index];
    if (binding.authority === "release-owned") {
      const descriptor = object(binding.expectedConnection);
      if (row || descriptor?.scope !== "operator" || descriptor.status !== "verified" ||
        descriptor.workspaceId !== undefined) return undefined;
      snapshots.push({ id: binding.id, authority: "release-owned" });
    } else {
      const record = row && object(row.connection_json);
      if (!row || row.id !== binding.id || row.status !== "verified" ||
        record?.id !== binding.id || record.status !== "verified") return undefined;
      const { ownerAccountId: _ignored, ...body } = record;
      void _ignored;
      const projected = row.owner_account_id ? { ...body, ownerAccountId: row.owner_account_id } : body;
      if (stableStringify(projected) !== stableStringify(binding.expectedConnection)) return undefined;
      snapshots.push({ id: binding.id, authority: "stored", status: row.status,
        ownerAccountId: row.owner_account_id,
        connectionJson: typeof row.connection_json === "string" ? row.connection_json
          : JSON.stringify(row.connection_json) });
    }
  }
  return snapshots;
}

function clock(options: ClockOptions): { now: () => number; ttlMs: number } {
  const ttlMs = options.ttlMs ?? MAX_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new Error("App mint lease TTL must be between 1 and 120000 milliseconds");
  }
  return { now: options.now ?? Date.now, ttlMs };
}

function validNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("App mint lease clock is invalid");
  return value;
}

function object(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
function jsonString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function actors(value: readonly string[]): string[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 2 ||
    value.some((actor) => typeof actor !== "string" || !actor.trim())) return undefined;
  return [...new Set(value)].sort();
}

/** Resolve actors exclusively from the canonical persisted Run rows. */
function canonicalActors(snapshot: Snapshot, input: AppMintLeaseBeginInput): string[] | undefined {
  const { capsule, run, plan, source } = snapshot;
  if (!input.capsuleId || !input.runId || !input.expectedOwnerAccountId?.trim() ||
    !connectionBindings(input.connections) ||
    !Number.isSafeInteger(input.expectedOwnershipEpoch) || input.expectedOwnershipEpoch < 0 ||
    !Number.isSafeInteger(input.expectedManagementEpoch) || input.expectedManagementEpoch < 0 ||
    capsule.owner_account_id !== input.expectedOwnerAccountId ||
    capsule.ownership_epoch !== input.expectedOwnershipEpoch ||
    capsule.management_epoch !== input.expectedManagementEpoch ||
    capsule.management_state !== "active" || run.id !== input.runId ||
    run.status !== "running" || !run.lease_token?.trim() || run.space_id !== capsule.space_id) return undefined;
  const record = object(run.run_json);
  if (!record || record.id !== run.id || record.status !== run.status || record.workspaceId !== capsule.space_id) return undefined;
  let ids: string[] | undefined;
  if (run.kind === "source_sync") {
    const sourceRecord = object(source?.source_json);
    if (run.installation_id !== null || input.connections.length !== 1 || !source || !sourceRecord ||
      !capsule.source_id || run.source_id !== capsule.source_id || source.id !== capsule.source_id ||
      source.space_id !== capsule.space_id || sourceRecord.id !== source.id ||
      sourceRecord.workspaceId !== capsule.space_id || sourceRecord.ownerCapsuleId !== input.capsuleId ||
      sourceRecord.authConnectionId !== input.connections[0]?.id ||
      record.kind !== "source_sync" || record.sourceId !== source.id ||
      record.ownershipEpoch !== capsule.ownership_epoch || record.url !== sourceRecord.url) return undefined;
    ids = actors([record.actorAccountId as string]);
  } else if (run.kind === "plan" || run.kind === "destroy_plan" || run.kind === "drift_check") {
    if (run.installation_id !== input.capsuleId || record.capsuleId !== input.capsuleId ||
      record.ownershipEpoch !== capsule.ownership_epoch ||
      record.appManagementEpoch !== capsule.management_epoch) return undefined;
    ids = actors([record.createdBy as string]);
  } else if (run.kind === "apply" || run.kind === "destroy_apply") {
    const planRecord = object(plan?.run_json);
    if (run.installation_id !== input.capsuleId || record.capsuleId !== input.capsuleId ||
      !plan || !planRecord || plan.id !== record.planRunId ||
      plan.installation_id !== input.capsuleId || plan.space_id !== capsule.space_id ||
      !["plan", "destroy_plan", "drift_check"].includes(plan.kind) ||
      planRecord.id !== plan.id || planRecord.status !== plan.status ||
      planRecord.capsuleId !== input.capsuleId || planRecord.workspaceId !== capsule.space_id ||
      planRecord.ownershipEpoch !== capsule.ownership_epoch ||
      planRecord.appManagementEpoch !== capsule.management_epoch) return undefined;
    const approval = object(record.approval);
    const approvalRequired = record.approval !== undefined || planRecord.approval !== undefined ||
      planRecord.requiresApproval === true || planRecord.operation === "destroy";
    if (approvalRequired && !approval?.approvedBy) return undefined;
    ids = actors(approval ? [planRecord.createdBy as string, approval.approvedBy as string]
      : [planRecord.createdBy as string]);
  } else return undefined;
  const expected = actors(input.expectedActorAccountIds);
  return ids && expected && ids.length === expected.length && ids.every((id, index) => id === expected[index])
    ? ids : undefined;
}

function newLease(input: AppMintLeaseBeginInput, actorAccountIds: readonly string[],
  connections: readonly AppMintConnectionSnapshot[], now: number, ttlMs: number): AppMintLease {
  return { id: crypto.randomUUID(), capsuleId: input.capsuleId, runId: input.runId,
    ownerAccountId: input.expectedOwnerAccountId, ownershipEpoch: input.expectedOwnershipEpoch,
    managementEpoch: input.expectedManagementEpoch, actorAccountIds, connections, expiresAt: now + ttlMs,
    createdAt: new Date(now).toISOString() };
}

function sameLease(row: Record<string, unknown> | undefined, lease: AppMintLease): boolean {
  if (!row) return false;
  return row.id === lease.id && row.capsule_id === lease.capsuleId && row.run_id === lease.runId &&
    row.owner_account_id === lease.ownerAccountId && Number(row.ownership_epoch) === lease.ownershipEpoch &&
    Number(row.management_epoch) === lease.managementEpoch && Number(row.expires_at) === lease.expiresAt &&
    row.actor_account_ids_json === JSON.stringify(lease.actorAccountIds) && row.created_at === lease.createdAt;
}

function leaseInput(lease: AppMintLease): AppMintLeaseBeginInput {
  return { capsuleId: lease.capsuleId, runId: lease.runId,
    expectedOwnerAccountId: lease.ownerAccountId, expectedOwnershipEpoch: lease.ownershipEpoch,
    expectedManagementEpoch: lease.managementEpoch, expectedActorAccountIds: lease.actorAccountIds,
    connections: lease.connections.map(({ id, authority, connectionJson, ownerAccountId }) => ({
      id, authority,
      expectedConnection: authority === "release-owned"
        ? { id, scope: "operator", status: "verified" }
        : { ...object(connectionJson), ...(ownerAccountId ? { ownerAccountId } : {}) },
    })) };
}

function pgGuard(snapshot: Snapshot, input: AppMintLeaseBeginInput, ids: readonly string[],
  pinned: readonly AppMintConnectionSnapshot[], offset: number): { sql: string; params: (string | number | null)[] } {
  const params: (string | number | null)[] = [];
  const bind = (value: string | number | null): string => { params.push(value); return `$${offset + params.length}`; };
  const cap = snapshot.capsule;
  const run = snapshot.run;
  const conditions = [
    `exists(select 1 from takosumi_capsules c where c.id=${bind(input.capsuleId)}
      and c.owner_account_id=${bind(input.expectedOwnerAccountId)}
      and c.ownership_epoch=${bind(input.expectedOwnershipEpoch)} and c.management_state='active'
      and c.management_epoch=${bind(input.expectedManagementEpoch)} and c.space_id=${bind(cap.space_id)}
      and c.source_id is not distinct from ${bind(cap.source_id)})`,
    `exists(select 1 from takosumi_runs r where r.id=${bind(run.id)} and r.kind=${bind(run.kind)}
      and r.status='running' and r.lease_token=${bind(run.lease_token)}
      and r.space_id=${bind(run.space_id)} and r.installation_id is not distinct from ${bind(run.installation_id)}
      and r.source_id is not distinct from ${bind(run.source_id)}
      and r.run_json::jsonb=${bind(jsonString(run.run_json))}::jsonb)`,
  ];
  if (snapshot.plan) {
    const plan = snapshot.plan;
    conditions.push(`exists(select 1 from takosumi_runs p where p.id=${bind(plan.id)}
      and p.kind=${bind(plan.kind)} and p.status=${bind(plan.status)} and p.space_id=${bind(plan.space_id)}
      and p.installation_id is not distinct from ${bind(plan.installation_id)}
      and p.run_json::jsonb=${bind(jsonString(plan.run_json))}::jsonb)`);
  }
  if (snapshot.source) {
    const source = snapshot.source;
    conditions.push(`exists(select 1 from takosumi_sources s where s.id=${bind(source.id)}
      and s.space_id=${bind(source.space_id)}
      and s.source_json::jsonb=${bind(jsonString(source.source_json))}::jsonb)`);
  }
  for (const id of ids) {
    if (id === input.expectedOwnerAccountId) continue;
    conditions.push(`exists(select 1 from takosumi_capsule_members m where m.capsule_id=${bind(input.capsuleId)}
      and m.account_id=${bind(id)} and m.status='active')`);
  }
  for (const connection of pinned) {
    if (connection.authority === "release-owned") {
      conditions.push(`not exists(select 1 from takosumi_connections c where c.id=${bind(connection.id)})`);
    } else {
      conditions.push(`exists(select 1 from takosumi_connections c where c.id=${bind(connection.id)}
        and c.status='verified' and c.owner_account_id is not distinct from ${bind(connection.ownerAccountId ?? null)}
        and c.connection_json::jsonb=${bind(connection.connectionJson ?? null)}::jsonb)`);
    }
  }
  return { sql: conditions.join(" and "), params };
}

export class SqlAppMintLeaseStore implements AppMintLeaseStore {
  readonly #client: SqlClient;
  readonly #now: () => number;
  readonly #ttlMs: number;
  constructor(client: SqlClient, options: ClockOptions = {}) {
    this.#client = client; ({ now: this.#now, ttlMs: this.#ttlMs } = clock(options));
  }

  async #snapshot(tx: SqlTransaction, input: AppMintLeaseBeginInput): Promise<Snapshot | undefined> {
    // Only Capsule is locked. Source settlement takes Run before Capsule;
    // locking Run here would deadlock that path. The write guard below checks
    // every read-only row again in the INSERT/DELETE statement.
    const cap = (await tx.query<CapsuleRow>(
      `select owner_account_id,ownership_epoch,management_state,management_epoch,space_id,source_id
       from takosumi_capsules where id=$1 for update`, [input.capsuleId])).rows[0];
    if (!cap) return undefined;
    const run = (await tx.query<RunRow>(
      `select id,kind,status,lease_token,space_id,installation_id,source_id,run_json
       from takosumi_runs where id=$1`, [input.runId])).rows[0];
    if (!run) return undefined;
    const runRecord = object(run.run_json);
    const planId = typeof runRecord?.planRunId === "string" ? runRecord.planRunId : undefined;
    const plan = planId ? (await tx.query<RunRow>(
      `select id,kind,status,lease_token,space_id,installation_id,source_id,run_json
       from takosumi_runs where id=$1`, [planId])).rows[0] : undefined;
    const source = run.kind === "source_sync" && run.source_id
      ? (await tx.query<SourceRow>(`select id,space_id,source_json from takosumi_sources where id=$1`,
        [run.source_id])).rows[0] : undefined;
    const rows: (ConnectionRow | undefined)[] = [];
    for (const binding of input.connections) {
      rows.push((await tx.query<ConnectionRow>(`select id,status,owner_account_id,connection_json
        from takosumi_connections where id=$1`, [binding.id])).rows[0]);
    }
    const connections = connectionSnapshots(input, rows);
    return connections ? { capsule: cap, run, plan, source, connections } : undefined;
  }

  async #members(tx: SqlTransaction, capsule: CapsuleRow, capsuleId: string, ids: readonly string[]): Promise<boolean> {
    for (const id of ids) {
      if (id === capsule.owner_account_id) continue;
      const row = (await tx.query<{ status: string }>(
        `select status from takosumi_capsule_members where capsule_id=$1 and account_id=$2`,
        [capsuleId, id])).rows[0];
      if (row?.status !== "active") return false;
    }
    return true;
  }

  async begin(input: AppMintLeaseBeginInput): Promise<AppMintLease | undefined> {
    if (!connectionBindings(input.connections)) return undefined;
    return await this.#client.transaction(async (tx) => {
      const snapshot = await this.#snapshot(tx, input);
      const ids = snapshot && canonicalActors(snapshot, input);
      if (!snapshot || !ids || !await this.#members(tx, snapshot.capsule, input.capsuleId, ids)) return undefined;
      const lease = newLease(input, ids, snapshot.connections, validNow(this.#now), this.#ttlMs);
      const guard = pgGuard(snapshot, input, ids, lease.connections, 9);
      await tx.query(`insert into takosumi_app_credential_mint_leases
        (id,capsule_id,run_id,owner_account_id,ownership_epoch,management_epoch,actor_account_ids_json,expires_at,created_at)
        select $1,$2,$3,$4,$5,$6,$7,$8,$9 where ${guard.sql}`, [lease.id, lease.capsuleId, lease.runId,
        lease.ownerAccountId, lease.ownershipEpoch, lease.managementEpoch,
        JSON.stringify(lease.actorAccountIds), lease.expiresAt, lease.createdAt, ...guard.params]);
      const persisted = (await tx.query<{ id: string }>(
        `select id from takosumi_app_credential_mint_leases where id=$1`, [lease.id])).rows[0];
      return persisted ? lease : undefined;
    });
  }

  async finish(lease: AppMintLease, disposition: "issued" | "discarded"): Promise<boolean> {
    return await this.#client.transaction(async (tx) => {
      const input = leaseInput(lease);
      const snapshot = await this.#snapshot(tx, input);
      const row = (await tx.query<Record<string, unknown>>(
        `select * from takosumi_app_credential_mint_leases where id=$1 for update`, [lease.id])).rows[0];
      if (!sameLease(row, lease)) return false;
      const ids = disposition === "issued" && snapshot && lease.expiresAt > validNow(this.#now)
        ? canonicalActors(snapshot, input) : undefined;
      if (ids && snapshot && await this.#members(tx, snapshot.capsule, lease.capsuleId, ids)) {
        const guard = pgGuard(snapshot, input, ids, lease.connections, 10);
        const deleted = await tx.query<{ id: string }>(`delete from takosumi_app_credential_mint_leases
          where id=$1 and capsule_id=$2 and run_id=$3 and owner_account_id=$4
            and ownership_epoch=$5 and management_epoch=$6 and actor_account_ids_json=$7
            and expires_at=$8 and created_at=$9 and expires_at>$10 and ${guard.sql}
          returning id`, [lease.id, lease.capsuleId, lease.runId, lease.ownerAccountId,
          lease.ownershipEpoch, lease.managementEpoch, JSON.stringify(lease.actorAccountIds),
          lease.expiresAt, lease.createdAt, validNow(this.#now), ...guard.params]);
        if (deleted.rows.length === 1) return true;
      }
      await tx.query(`delete from takosumi_app_credential_mint_leases where id=$1`, [lease.id]);
      return false;
    });
  }
}

export class D1AppMintLeaseStore implements AppMintLeaseStore {
  readonly #db: D1Like;
  readonly #now: () => number;
  readonly #ttlMs: number;
  constructor(db: D1Like, options: ClockOptions = {}) {
    if (!db.batch) throw new Error("D1 app mint leases require atomic batch support");
    this.#db = db; ({ now: this.#now, ttlMs: this.#ttlMs } = clock(options));
  }

  async #snapshot(input: AppMintLeaseBeginInput): Promise<Snapshot | undefined> {
    const cap = await this.#db.prepare(`select owner_account_id,ownership_epoch,management_state,management_epoch,space_id,source_id
      from capsules where id=?`).bind(input.capsuleId).first<CapsuleRow>();
    if (!cap) return undefined;
    const run = await this.#db.prepare(`select id,type as kind,status,lease_token,space_id,installation_id,source_id,run_json
      from runs where id=?`).bind(input.runId).first<RunRow>();
    if (!run) return undefined;
    const record = object(run.run_json);
    const plan = typeof record?.planRunId === "string" ? await this.#db.prepare(
      `select id,type as kind,status,lease_token,space_id,installation_id,source_id,run_json from runs where id=?`,
    ).bind(record.planRunId).first<RunRow>() ?? undefined : undefined;
    const source = run.kind === "source_sync" && run.source_id ? await this.#db.prepare(
      `select id,space_id,record_json as source_json from sources where id=?`,
    ).bind(run.source_id).first<SourceRow>() ?? undefined : undefined;
    const rows: (ConnectionRow | undefined)[] = [];
    for (const binding of input.connections) {
      rows.push(await this.#db.prepare(`select id,status,owner_account_id,connection_json
        from connections where id=?`).bind(binding.id).first<ConnectionRow>() ?? undefined);
    }
    const connections = connectionSnapshots(input, rows);
    return connections ? { capsule: cap, run, plan, source, connections } : undefined;
  }

  #guard(snapshot: Snapshot, input: AppMintLeaseBeginInput, ids: readonly string[],
    pinned: readonly AppMintConnectionSnapshot[]):
    { sql: string; params: unknown[] } {
    const conditions = [
      `exists(select 1 from capsules c where c.id=? and c.owner_account_id=? and c.ownership_epoch=?
        and c.management_state='active' and c.management_epoch=? and c.space_id=? and c.source_id is ?)`,
      `exists(select 1 from runs r where r.id=? and r.type=? and r.status='running' and r.lease_token=?
        and r.space_id=? and r.installation_id is ? and r.source_id is ? and r.run_json=?)`,
    ];
    const params: unknown[] = [input.capsuleId, input.expectedOwnerAccountId, input.expectedOwnershipEpoch,
      input.expectedManagementEpoch, snapshot.capsule.space_id, snapshot.capsule.source_id,
      snapshot.run.id, snapshot.run.kind, snapshot.run.lease_token, snapshot.run.space_id,
      snapshot.run.installation_id, snapshot.run.source_id, snapshot.run.run_json];
    if (snapshot.plan) {
      conditions.push(`exists(select 1 from runs p where p.id=? and p.type=? and p.status=? and p.space_id=?
        and p.installation_id is ? and p.run_json=?)`);
      params.push(snapshot.plan.id, snapshot.plan.kind, snapshot.plan.status, snapshot.plan.space_id,
        snapshot.plan.installation_id, snapshot.plan.run_json);
    }
    if (snapshot.source) {
      conditions.push(`exists(select 1 from sources s where s.id=? and s.space_id=? and s.record_json=?)`);
      params.push(snapshot.source.id, snapshot.source.space_id, snapshot.source.source_json);
    }
    for (const id of ids) {
      if (id === input.expectedOwnerAccountId) continue;
      conditions.push(`exists(select 1 from capsule_members m where m.capsule_id=? and m.account_id=? and m.status='active')`);
      params.push(input.capsuleId, id);
    }
    conditions.push(`not exists(select 1 from json_each(?) j where
      (json_extract(j.value,'$.authority')='release-owned' and
        exists(select 1 from connections c where c.id=json_extract(j.value,'$.id')))
      or (json_extract(j.value,'$.authority')='stored' and not exists(
        select 1 from connections c where c.id=json_extract(j.value,'$.id') and c.status='verified'
          and c.owner_account_id is json_extract(j.value,'$.ownerAccountId')
          and c.connection_json=json_extract(j.value,'$.connectionJson'))))`);
    params.push(JSON.stringify(pinned));
    return { sql: conditions.join(" and "), params };
  }

  async begin(input: AppMintLeaseBeginInput): Promise<AppMintLease | undefined> {
    if (!connectionBindings(input.connections)) return undefined;
    const snapshot = await this.#snapshot(input);
    const ids = snapshot && canonicalActors(snapshot, input);
    if (!snapshot || !ids) return undefined;
    const lease = newLease(input, ids, snapshot.connections, validNow(this.#now), this.#ttlMs);
    const guard = this.#guard(snapshot, input, ids, lease.connections);
    const result = await this.#db.prepare(`insert into app_credential_mint_leases
      (id,capsule_id,run_id,owner_account_id,ownership_epoch,management_epoch,actor_account_ids_json,expires_at,created_at)
      select ?,?,?,?,?,?,?,?,? where ${guard.sql}`)
      .bind(lease.id, lease.capsuleId, lease.runId, lease.ownerAccountId, lease.ownershipEpoch,
        lease.managementEpoch, JSON.stringify(lease.actorAccountIds), lease.expiresAt, lease.createdAt,
        ...guard.params).run();
    return result.meta?.changes === 1 ? lease : undefined;
  }

  async finish(lease: AppMintLease, disposition: "issued" | "discarded"): Promise<boolean> {
    const input = leaseInput(lease);
    const snapshot = disposition === "issued" ? await this.#snapshot(input) : undefined;
    const ids = snapshot && canonicalActors(snapshot, input);
    const authorized = !!(ids && snapshot && lease.expiresAt > validNow(this.#now));
    const guard = authorized ? this.#guard(snapshot!, input, ids!, lease.connections) : undefined;
    const first = this.#db.prepare(`delete from app_credential_mint_leases where id=? and capsule_id=?
      and run_id=? and owner_account_id=? and ownership_epoch=? and management_epoch=?
      and actor_account_ids_json=? and expires_at=? and created_at=? and expires_at>?
      ${guard ? `and ${guard.sql}` : "and 0"}`)
      .bind(lease.id, lease.capsuleId, lease.runId, lease.ownerAccountId, lease.ownershipEpoch,
        lease.managementEpoch, JSON.stringify(lease.actorAccountIds), lease.expiresAt, lease.createdAt,
        validNow(this.#now), ...(guard?.params ?? []));
    const cleanup = this.#db.prepare(`delete from app_credential_mint_leases where id=? and capsule_id=?
      and run_id=? and owner_account_id=? and ownership_epoch=? and management_epoch=?
      and actor_account_ids_json=? and expires_at=? and created_at=?`)
      .bind(lease.id, lease.capsuleId, lease.runId, lease.ownerAccountId, lease.ownershipEpoch,
        lease.managementEpoch, JSON.stringify(lease.actorAccountIds), lease.expiresAt, lease.createdAt);
    const results = await this.#db.batch!([first, cleanup]);
    return authorized && results[0]?.meta?.changes === 1;
  }
}

/** Portable test/dev adapter. Durable deployments must inject SQL or D1. */
export class InMemoryAppMintLeaseStore implements AppMintLeaseStore {
  readonly #store: InMemoryOpenTofuControlStore;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #leases = new Map<string, AppMintLease>();
  constructor(store: InMemoryOpenTofuControlStore, options: ClockOptions = {}) {
    this.#store = store; ({ now: this.#now, ttlMs: this.#ttlMs } = clock(options));
  }
  async #snapshot(input: AppMintLeaseBeginInput): Promise<Snapshot | undefined> {
    const cap = await this.#store.getCapsule(input.capsuleId);
    const plan = await this.#store.getPlanRun(input.runId);
    const apply = plan ? undefined : await this.#store.getApplyRun(input.runId);
    const sourceRun = !plan && !apply ? await this.#store.getSourceSyncRun(input.runId) : undefined;
    const run = plan ?? apply ?? sourceRun;
    if (!cap || !run) return undefined;
    const source = sourceRun ? await this.#store.getSource(sourceRun.sourceId) : undefined;
    const parentPlan = apply ? await this.#store.getPlanRun(apply.planRunId) : undefined;
    const rows: (ConnectionRow | undefined)[] = [];
    for (const binding of input.connections) {
      const connection = await this.#store.getConnection(binding.id);
      rows.push(connection ? { id: connection.id, status: connection.status,
        owner_account_id: connection.ownerAccountId ?? null, connection_json: connection } : undefined);
    }
    const connections = connectionSnapshots(input, rows);
    if (!connections) return undefined;
    const capsule: CapsuleRow = { owner_account_id: cap.ownerAccountId ?? null,
      ownership_epoch: cap.ownershipEpoch ?? 0, management_state: cap.managementState ?? "active",
      management_epoch: cap.managementEpoch ?? 0, space_id: cap.workspaceId, source_id: cap.sourceId ?? null };
    const row = (value: typeof run, kind: string): RunRow => ({ id: value.id, kind, status: value.status,
      lease_token: value.status === "running" ? "in-memory" : null, space_id: value.workspaceId,
      installation_id: "capsuleId" in value ? value.capsuleId ?? null : null,
      source_id: "sourceId" in value ? value.sourceId ?? null : null, run_json: value });
    return { capsule, run: row(run, sourceRun ? "source_sync" : apply ? "apply" : "plan"), connections,
      ...(parentPlan ? { plan: row(parentPlan, "plan") } : {}),
      ...(source ? { source: { id: source.id, space_id: source.workspaceId, source_json: source } } : {}) };
  }
  #members(capsuleId: string, owner: string, ids: readonly string[]): boolean {
    const members = this.#store.listCapsuleMembers(capsuleId);
    return ids.every((id) => id === owner || members.some((row) => row.accountId === id && row.status === "active"));
  }
  async begin(input: AppMintLeaseBeginInput): Promise<AppMintLease | undefined> {
    if (!connectionBindings(input.connections)) return undefined;
    const snapshot = await this.#snapshot(input);
    const ids = snapshot && canonicalActors(snapshot, input);
    if (!snapshot || !ids || !this.#members(input.capsuleId, input.expectedOwnerAccountId, ids)) return undefined;
    const lease = newLease(input, ids, snapshot.connections, validNow(this.#now), this.#ttlMs);
    this.#leases.set(lease.id, lease);
    return lease;
  }
  async finish(lease: AppMintLease, disposition: "issued" | "discarded"): Promise<boolean> {
    const stored = this.#leases.get(lease.id);
    if (!stored || stored !== lease) return false;
    this.#leases.delete(lease.id);
    if (disposition !== "issued" || lease.expiresAt <= validNow(this.#now)) return false;
    const snapshot = await this.#snapshot(leaseInput(lease));
    const ids = snapshot && canonicalActors(snapshot, leaseInput(lease));
    return !!(ids && snapshot &&
      JSON.stringify(snapshot.connections) === JSON.stringify(lease.connections) &&
      this.#members(lease.capsuleId, lease.ownerAccountId, ids));
  }
}
