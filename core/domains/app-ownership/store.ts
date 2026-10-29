import type { AppAccess, AppAccessResolver } from "takosumi-contract/app-access";
import type { InMemoryOpenTofuControlStore, OpenTofuControlStore } from "../deploy-control/store.ts";
import type { SqlClient } from "../../adapters/storage/sql.ts";
import type { D1Like } from "../../adapters/storage/d1.ts";

export interface CapsuleOwnership {
  readonly capsuleId: string;
  readonly ownerAccountId: string;
  readonly ownershipEpoch: number;
  readonly managementState: "active" | "draining" | "frozen";
  readonly managementEpoch: number;
  readonly storageRoot: string;
}

export interface CapsuleMember {
  readonly capsuleId: string;
  readonly accountId: string;
  readonly status: "active" | "invited";
  readonly addedBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountBillingBinding {
  readonly accountId: string;
  readonly billingAuthority: string;
  readonly billingRef: string;
  readonly organizationRef?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One authorization fence read. `schemaAvailable: false` means the target
 * still runs a pre-v77 D1 / pre-v123 Postgres schema; it is not an error.
 */
export interface CapsuleOwnershipFence {
  readonly schemaAvailable: boolean;
  readonly ownership?: CapsuleOwnership;
}

export interface AppOwnershipStore extends AppAccessResolver {
  getOwnership(capsuleId: string): Promise<CapsuleOwnership | undefined>;
  /** Same single read as getOwnership, also reporting whether the schema exists. */
  readOwnershipFence?(capsuleId: string): Promise<CapsuleOwnershipFence>;
  /** Which of these Capsules have an ownership row; bounded batch read for list filtering. */
  listOwnedCapsuleIds?(capsuleIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** Returns false if the Capsule or ownership schema does not yet exist. */
  putOwnership(record: CapsuleOwnership, expectedOwnershipEpoch?: number): Promise<boolean>;
  /** Backfill CAS: never replaces an app owner established by creation or transfer. */
  initializeOwnershipIfMissing(record: CapsuleOwnership): Promise<boolean>;
  listMembers(capsuleId: string): Promise<readonly CapsuleMember[]>;
  putMember(record: CapsuleMember): Promise<boolean>;
  deleteMember(capsuleId: string, accountId: string): Promise<boolean>;
  getAccountBillingBinding(accountId: string): Promise<AccountBillingBinding | undefined>;
  putAccountBillingBinding(record: AccountBillingBinding): Promise<boolean>;
  setConnectionOwnerIfMissing(connectionId: string, ownerAccountId: string): Promise<boolean>;
  setUsagePayerIfMissing(eventId: string, payerAccountId: string): Promise<boolean>;
}

type OwnershipRow = {
  owner_account_id: string | null;
  ownership_epoch: number;
  management_state: string;
  management_epoch: number;
  storage_root: string | null;
};
type MemberRow = {
  capsule_id: string;
  account_id: string;
  status: string;
  added_by: string | null;
  created_at: string;
  updated_at: string;
};
type BillingRow = {
  account_id: string;
  billing_authority: string;
  billing_ref: string;
  organization_ref: string | null;
  created_at: string;
  updated_at: string;
};
type AccessListRow = {
  capsule_id: string;
  role: "owner" | "member";
  owner_account_id: string;
  ownership_epoch: number;
};

function appListLimit(page: { limit?: number }): number {
  const requested = page.limit ?? 50;
  if (!Number.isFinite(requested)) throw new TypeError("App page limit must be finite");
  return Math.max(1, Math.min(100, Math.floor(requested)));
}

function accessListPage(rows: readonly AccessListRow[], limit: number):
  { apps: readonly AppAccess[]; nextCursor?: string } {
  const apps = rows.slice(0, limit).map((row) => ({
    capsuleId: row.capsule_id,
    role: row.role,
    ownerAccountId: row.owner_account_id,
    ownershipEpoch: row.ownership_epoch,
  }));
  return rows.length > limit && apps.length
    ? { apps, nextCursor: apps[apps.length - 1]!.capsuleId }
    : { apps };
}

function ownerRow(capsuleId: string, row: OwnershipRow | undefined): CapsuleOwnership | undefined {
  if (!row?.owner_account_id) return undefined;
  if (row.management_state !== "active" && row.management_state !== "draining" && row.management_state !== "frozen") {
    throw new Error("Invalid persisted app management state");
  }
  return {
    capsuleId,
    ownerAccountId: row.owner_account_id,
    ownershipEpoch: row.ownership_epoch,
    managementState: row.management_state,
    managementEpoch: row.management_epoch,
    storageRoot: row.storage_root ?? "",
  };
}

function memberRow(row: MemberRow): CapsuleMember {
  if (row.status !== "active" && row.status !== "invited") throw new Error("Invalid persisted app member status");
  return {
    capsuleId: row.capsule_id,
    accountId: row.account_id,
    status: row.status,
    ...(row.added_by ? { addedBy: row.added_by } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function billingRow(row: BillingRow): AccountBillingBinding {
  return {
    accountId: row.account_id,
    billingAuthority: row.billing_authority,
    billingRef: row.billing_ref,
    ...(row.organization_ref ? { organizationRef: row.organization_ref } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Postgres/PGlite and SQLite wording for the pre-ownership capsule shape. */
export function isMissingOwnershipSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:column "?(?:[a-z_]+\.)?(?:owner_account_id|ownership_epoch|management_state|management_epoch|storage_root)"? does not exist|no such column:? *(?:[a-z_]+\.)?(?:owner_account_id|ownership_epoch|management_state|management_epoch|storage_root)|relation "?(?:takosumi_)?capsule_members"? does not exist|no such table:? *(?:takosumi_)?capsule_members)/iu
    .test(message);
}

function validOwnership(row: CapsuleOwnership): void {
  if (!row.capsuleId || !row.ownerAccountId || !row.storageRoot ||
      !Number.isSafeInteger(row.ownershipEpoch) || row.ownershipEpoch < 0 ||
      !Number.isSafeInteger(row.managementEpoch) || row.managementEpoch < 0 ||
      !["active", "draining", "frozen"].includes(row.managementState)) {
    throw new TypeError("Invalid Capsule ownership record");
  }
}

function validOwnershipEpochCas(record: CapsuleOwnership, expectedOwnershipEpoch: number): boolean {
  return Number.isSafeInteger(expectedOwnershipEpoch) && expectedOwnershipEpoch >= 0 &&
    (record.ownershipEpoch === expectedOwnershipEpoch || record.ownershipEpoch === expectedOwnershipEpoch + 1);
}

function validMember(row: CapsuleMember): void {
  if (!row.capsuleId || !row.accountId || !row.createdAt || !row.updatedAt ||
      (row.status !== "active" && row.status !== "invited")) {
    throw new TypeError("Invalid Capsule member record");
  }
}

function validBilling(row: AccountBillingBinding): void {
  if (!row.accountId || !row.billingAuthority || !row.billingRef || !row.createdAt || !row.updatedAt) {
    throw new TypeError("Invalid account billing binding");
  }
}

abstract class BaseAppOwnershipStore implements AppOwnershipStore {
  constructor(protected readonly control: OpenTofuControlStore) {}
  abstract getOwnership(capsuleId: string): Promise<CapsuleOwnership | undefined>;
  abstract putOwnership(record: CapsuleOwnership, expectedOwnershipEpoch?: number): Promise<boolean>;
  abstract initializeOwnershipIfMissing(record: CapsuleOwnership): Promise<boolean>;
  abstract listMembers(capsuleId: string): Promise<readonly CapsuleMember[]>;
  abstract putMember(record: CapsuleMember): Promise<boolean>;
  abstract deleteMember(capsuleId: string, accountId: string): Promise<boolean>;
  abstract getAccountBillingBinding(accountId: string): Promise<AccountBillingBinding | undefined>;
  abstract putAccountBillingBinding(record: AccountBillingBinding): Promise<boolean>;
  abstract setConnectionOwnerIfMissing(connectionId: string, ownerAccountId: string): Promise<boolean>;
  abstract setUsagePayerIfMissing(eventId: string, payerAccountId: string): Promise<boolean>;

  async readOwnershipFence(capsuleId: string): Promise<CapsuleOwnershipFence> {
    const ownership = await this.getOwnership(capsuleId);
    return ownership ? { schemaAvailable: true, ownership } : { schemaAvailable: true };
  }

  async listOwnedCapsuleIds(capsuleIds: readonly string[]): Promise<ReadonlySet<string>> {
    const owned = new Set<string>();
    for (const id of new Set(capsuleIds)) if ((await this.readOwnershipFence(id)).ownership) owned.add(id);
    return owned;
  }

  async resolveAppAccess(accountId: string, capsuleId: string): Promise<AppAccess | undefined> {
    if (!accountId || !capsuleId) return undefined;
    const capsule = await this.control.getCapsule(capsuleId);
    if (!capsule || capsule.status === "destroyed") return undefined;
    const ownership = await this.getOwnership(capsuleId);
    if (ownership) {
      const role = accountId === ownership.ownerAccountId ? "owner" :
        (await this.listMembers(capsuleId)).some((member) => member.accountId === accountId && member.status === "active")
          ? "member" : undefined;
      return role ? { capsuleId, role, ownerAccountId: ownership.ownerAccountId,
        ownershipEpoch: ownership.ownershipEpoch } : undefined;
    }
    // Pre-v77 rows only. The Workspace's ownerUserId is the sole owner truth;
    // ordinary Workspace member/viewer roles never gain app management access.
    const workspace = await this.control.getWorkspace(capsule.workspaceId);
    if (!workspace?.ownerUserId) return undefined;
    if (workspace.ownerUserId === accountId) {
      return { capsuleId, role: "owner", ownerAccountId: accountId, ownershipEpoch: 0 };
    }
    const member = await this.control.getWorkspaceMember(capsule.workspaceId, accountId);
    if (member?.status === "active" && member.roles.some((role) => role === "owner" || role === "admin")) {
      return { capsuleId, role: "member", ownerAccountId: workspace.ownerUserId, ownershipEpoch: 0 };
    }
    return undefined;
  }

  async listAccessibleApps(accountId: string, page: { cursor?: string; limit?: number } = {}):
    Promise<{ apps: readonly AppAccess[]; nextCursor?: string }> {
    const limit = appListLimit(page);
    const capsules = [...await this.control.listCapsules()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const apps: AppAccess[] = [];
    let nextCursor: string | undefined;
    for (const capsule of capsules) {
      if (page.cursor && capsule.id <= page.cursor) continue;
      const access = await this.resolveAppAccess(accountId, capsule.id);
      if (!access) continue;
      if (apps.length === limit) { nextCursor = apps[apps.length - 1]!.capsuleId; break; }
      apps.push(access);
    }
    return { apps, ...(nextCursor ? { nextCursor } : {}) };
  }
}

export class InMemoryAppOwnershipStore extends BaseAppOwnershipStore {
  readonly #members = new Map<string, CapsuleMember>();
  readonly #billing = new Map<string, AccountBillingBinding>();
  constructor(control: OpenTofuControlStore) {
    super(control);
    const memory = control as InMemoryOpenTofuControlStore;
    if (typeof memory.getCapsuleOwnership !== "function" || typeof memory.setCapsuleOwnership !== "function") {
      throw new TypeError("InMemoryAppOwnershipStore requires in-memory ownership storage");
    }
  }
  async getOwnership(id: string): Promise<CapsuleOwnership | undefined> {
    const control = this.control as import("../deploy-control/store.ts").InMemoryOpenTofuControlStore;
    return typeof control.getCapsuleOwnership === "function"
      ? control.getCapsuleOwnership(id)
      : undefined;
  }
  async putOwnership(record: CapsuleOwnership, expectedOwnershipEpoch = record.ownershipEpoch): Promise<boolean> {
    validOwnership(record);
    if (!validOwnershipEpochCas(record, expectedOwnershipEpoch)) return false;
    const [capsule, current] = await Promise.all([
      this.control.getCapsule(record.capsuleId), this.getOwnership(record.capsuleId),
    ]);
    if (!capsule || (current?.ownershipEpoch ?? 0) !== expectedOwnershipEpoch ||
      (current != null && current.ownerAccountId !== record.ownerAccountId &&
        record.ownershipEpoch !== expectedOwnershipEpoch + 1)) return false;
    const control = this.control as import("../deploy-control/store.ts").InMemoryOpenTofuControlStore;
    const changed = typeof control.setCapsuleOwnership === "function" &&
      control.setCapsuleOwnership(record, false, expectedOwnershipEpoch);
    if (!changed) return false;
    this.#members.delete(`${record.capsuleId}\0${record.ownerAccountId}`);
    control.deleteCapsuleMember?.(record.capsuleId, record.ownerAccountId);
    return true;
  }
  async initializeOwnershipIfMissing(record: CapsuleOwnership): Promise<boolean> {
    validOwnership(record);
    if (await this.getOwnership(record.capsuleId)) return false;
    const capsule = await this.control.getCapsule(record.capsuleId);
    if (!capsule) return false;
    const control = this.control as import("../deploy-control/store.ts").InMemoryOpenTofuControlStore;
    const changed = typeof control.setCapsuleOwnership === "function" &&
      control.setCapsuleOwnership(record, true);
    if (!changed) return false;
    this.#members.delete(`${record.capsuleId}\0${record.ownerAccountId}`);
    control.deleteCapsuleMember?.(record.capsuleId, record.ownerAccountId);
    return true;
  }
  async listMembers(id: string): Promise<readonly CapsuleMember[]> {
    const control = this.control as import("../deploy-control/store.ts").InMemoryOpenTofuControlStore;
    if (typeof control.listCapsuleMembers === "function") return control.listCapsuleMembers(id);
    return [...this.#members.values()].filter((row) => row.capsuleId === id).map((row) => structuredClone(row));
  }
  async putMember(record: CapsuleMember): Promise<boolean> {
    validMember(record);
    const owner = await this.getOwnership(record.capsuleId);
    if (!owner || owner.ownerAccountId === record.accountId) return false;
    const control = this.control as import("../deploy-control/store.ts").InMemoryOpenTofuControlStore;
    if (typeof control.putCapsuleMember === "function") return control.putCapsuleMember(record);
    this.#members.set(`${record.capsuleId}\0${record.accountId}`, structuredClone(record));
    return true;
  }
  async deleteMember(id: string, accountId: string): Promise<boolean> {
    const control = this.control as import("../deploy-control/store.ts").InMemoryOpenTofuControlStore;
    if (typeof control.deleteCapsuleMember === "function") return control.deleteCapsuleMember(id, accountId);
    return this.#members.delete(`${id}\0${accountId}`);
  }
  async getAccountBillingBinding(id: string): Promise<AccountBillingBinding | undefined> {
    return this.#billing.get(id);
  }
  async putAccountBillingBinding(record: AccountBillingBinding): Promise<boolean> {
    validBilling(record);
    this.#billing.set(record.accountId, structuredClone(record));
    return true;
  }
  async setConnectionOwnerIfMissing(id: string, owner: string): Promise<boolean> {
    const current = await this.control.getConnection(id);
    if (!id || !owner || !current || current.ownerAccountId || current.scope === "operator") return false;
    await this.control.putConnection({ ...current, ownerAccountId: owner });
    return true;
  }
  async setUsagePayerIfMissing(id: string, payer: string): Promise<boolean> {
    if (!id || !payer) return false;
    const control = this.control as import("../deploy-control/store.ts").InMemoryOpenTofuControlStore;
    if (typeof control.setUsagePayerIfMissing === "function") return control.setUsagePayerIfMissing(id, payer);
    // Structural test/control adapters can replace a row directly. Read back
    // verifies that the adapter actually persisted the new payer.
    for (const workspace of await this.control.listWorkspaces()) {
      const current = (await this.control.listUsageEvents(workspace.id)).find((row) => row.id === id) as
        (import("takosumi-contract/billing").UsageEvent & { payerAccountId?: string }) | undefined;
      if (!current || current.payerAccountId) continue;
      await this.control.putUsageEvent({ ...current, payerAccountId: payer });
      return (await this.control.listUsageEvents(workspace.id)).some((row) =>
        row.id === id && (row as typeof current).payerAccountId === payer);
    }
    return false;
  }
}

export class SqlAppOwnershipStore extends BaseAppOwnershipStore {
  constructor(readonly client: SqlClient, control: OpenTofuControlStore) { super(control); }
  override async listAccessibleApps(accountId: string, page: { cursor?: string; limit?: number } = {}):
    Promise<{ apps: readonly AppAccess[]; nextCursor?: string }> {
    const limit = appListLimit(page);
    if (!accountId) return { apps: [] };
    const rows = await this.client.query<AccessListRow>(`
      select c.id as capsule_id,
        case when c.owner_account_id=$1 or (c.owner_account_id is null and w.space_json->>'ownerUserId'=$1)
          then 'owner' else 'member' end as role,
        coalesce(c.owner_account_id, w.space_json->>'ownerUserId') as owner_account_id,
        case when c.owner_account_id is null then 0 else c.ownership_epoch end as ownership_epoch
      from takosumi_capsules c
      left join takosumi_workspaces w on w.id=c.space_id
      where c.status <> 'destroyed' and c.id collate "C" > $2
        and (c.owner_account_id=$1
          or (c.owner_account_id is not null and exists (
            select 1 from takosumi_capsule_members m
            where m.capsule_id=c.id and m.account_id=$1 and m.status='active'))
          or (c.owner_account_id is null and w.id is not null
            and coalesce(w.space_json->>'ownerUserId', '')<>'' and (
            w.space_json->>'ownerUserId'=$1
            or exists (select 1 from takosumi_workspace_members wm
              where wm.workspace_id=c.space_id and wm.account_id=$1 and wm.status='active'
                and wm.member_json->>'workspaceId'=wm.workspace_id
                and wm.member_json->>'accountId'=wm.account_id
                and wm.member_json->>'status'='active'
                and jsonb_typeof(wm.member_json->'roles')='array'
                and (wm.member_json->'roles' ? 'owner' or wm.member_json->'roles' ? 'admin')))))
      order by c.id collate "C" asc limit $3`, [accountId, page.cursor ?? "", limit + 1]);
    return accessListPage(rows.rows, limit);
  }
  async getOwnership(id: string): Promise<CapsuleOwnership | undefined> {
    const rows = await this.client.query<OwnershipRow>(
      `select owner_account_id, ownership_epoch, management_state, management_epoch, storage_root from takosumi_capsules where id=$1`, [id]);
    return ownerRow(id, rows.rows[0]);
  }
  override async readOwnershipFence(id: string): Promise<CapsuleOwnershipFence> {
    try {
      return await super.readOwnershipFence(id);
    } catch (error) {
      // Only the pre-v123 shape is a rollout state; other failures stay errors.
      if (isMissingOwnershipSchemaError(error)) return { schemaAvailable: false };
      throw error;
    }
  }
  override async listOwnedCapsuleIds(capsuleIds: readonly string[]): Promise<ReadonlySet<string>> {
    const ids = [...new Set(capsuleIds)];
    if (!ids.length) return new Set();
    try {
      const rows = await this.client.query<{ id: string }>(
        `select id from takosumi_capsules where owner_account_id is not null and id = any($1::text[])`, [ids]);
      return new Set(rows.rows.map((row) => row.id));
    } catch (error) {
      if (isMissingOwnershipSchemaError(error)) return new Set();
      throw error;
    }
  }
  async putOwnership(record: CapsuleOwnership, expectedOwnershipEpoch = record.ownershipEpoch): Promise<boolean> {
    validOwnership(record);
    if (!validOwnershipEpochCas(record, expectedOwnershipEpoch)) return false;
    return await this.client.transaction(async (tx) => {
      const result = await tx.query(
        `update takosumi_capsules set owner_account_id=$2, ownership_epoch=$3, management_state=$4, management_epoch=$5, storage_root=$6, slug=coalesce(slug, installation_json->>'slug')
         where id=$1 and ownership_epoch=$7
           and (owner_account_id is null or owner_account_id=$2 or $3=$7+1)
         returning id`,
        [record.capsuleId, record.ownerAccountId, record.ownershipEpoch, record.managementState, record.managementEpoch, record.storageRoot, expectedOwnershipEpoch]);
      if (result.rowCount > 0) {
        await tx.query(`delete from takosumi_capsule_members where capsule_id=$1 and account_id=$2`, [record.capsuleId,record.ownerAccountId]);
      }
      return result.rowCount > 0;
    });
  }
  async initializeOwnershipIfMissing(record: CapsuleOwnership): Promise<boolean> {
    validOwnership(record);
    return await this.client.transaction(async (tx) => {
      const result = await tx.query(
        `update takosumi_capsules set owner_account_id=$2, ownership_epoch=$3, management_state=$4, management_epoch=$5, storage_root=$6, slug=coalesce(slug, installation_json->>'slug') where id=$1 and owner_account_id is null returning id`,
        [record.capsuleId, record.ownerAccountId, record.ownershipEpoch, record.managementState, record.managementEpoch, record.storageRoot]);
      if (result.rowCount > 0) {
        await tx.query(`delete from takosumi_capsule_members where capsule_id=$1 and account_id=$2`, [record.capsuleId,record.ownerAccountId]);
      }
      return result.rowCount > 0;
    });
  }
  async listMembers(id: string): Promise<readonly CapsuleMember[]> {
    const rows = await this.client.query<MemberRow>(`select * from takosumi_capsule_members where capsule_id=$1 order by account_id`, [id]);
    return rows.rows.map(memberRow);
  }
  async putMember(record: CapsuleMember): Promise<boolean> {
    validMember(record);
    const result = await this.client.query(
      `insert into takosumi_capsule_members (capsule_id,account_id,status,added_by,created_at,updated_at)
       select $1,$2,$3,$4,$5,$6 where exists(select 1 from takosumi_capsules where id=$1 and owner_account_id is not null and owner_account_id<>$2)
       on conflict (capsule_id,account_id) do update set status=excluded.status,added_by=excluded.added_by,updated_at=excluded.updated_at`,
      [record.capsuleId,record.accountId,record.status,record.addedBy ?? null,record.createdAt,record.updatedAt]);
    return result.rowCount > 0;
  }
  async deleteMember(id: string, accountId: string): Promise<boolean> {
    const result = await this.client.query(`delete from takosumi_capsule_members where capsule_id=$1 and account_id=$2`,[id,accountId]);
    return result.rowCount > 0;
  }
  async getAccountBillingBinding(id: string): Promise<AccountBillingBinding | undefined> {
    const rows = await this.client.query<BillingRow>(`select * from takosumi_account_billing_bindings where account_id=$1`,[id]);
    return rows.rows[0] ? billingRow(rows.rows[0]) : undefined;
  }
  async putAccountBillingBinding(record: AccountBillingBinding): Promise<boolean> {
    validBilling(record);
    const result = await this.client.query(
      `insert into takosumi_account_billing_bindings (account_id,billing_authority,billing_ref,organization_ref,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6) on conflict (account_id) do update set billing_authority=excluded.billing_authority,billing_ref=excluded.billing_ref,organization_ref=excluded.organization_ref,updated_at=excluded.updated_at`,
      [record.accountId,record.billingAuthority,record.billingRef,record.organizationRef ?? null,record.createdAt,record.updatedAt]);
    return result.rowCount > 0;
  }
  async setConnectionOwnerIfMissing(id: string, owner: string): Promise<boolean> {
    if (!id || !owner) return false;
    const result = await this.client.query(
      `update takosumi_connections set owner_account_id=$2 where id=$1 and owner_account_id is null and connection_json->>'scope'='workspace'`, [id,owner]);
    return result.rowCount > 0;
  }
  async setUsagePayerIfMissing(id: string, payer: string): Promise<boolean> {
    if (!id || !payer) return false;
    const result = await this.client.query(
      `update takosumi_usage_events set payer_account_id=$2 where id=$1 and payer_account_id is null`, [id,payer]);
    return result.rowCount > 0;
  }
}

/** How long the authorization fence trusts "no ownership schema" on D1. */
export const D1_OWNERSHIP_FENCE_ABSENT_TTL_MS = 60_000;

export class D1AppOwnershipStore extends BaseAppOwnershipStore {
  #presentColumns = new Set<string>();
  /** Fence-only negative cache; writes keep the uncached probe. */
  #fenceSchemaAbsentUntil = 0;
  constructor(readonly db: D1Like, control: OpenTofuControlStore, private readonly now: () => number = Date.now) { super(control); }
  async #column(table: string, column: string): Promise<boolean> {
    const key = `${table}.${column}`;
    if (this.#presentColumns.has(key)) return true;
    // Do not cache absence: the same instance may observe the additive v77 migration later.
    const rows = await this.db.prepare(`pragma table_info(${table})`).all<{ name: string }>();
    const present = (rows.results ?? []).some((row) => row.name === column);
    if (present) this.#presentColumns.add(key);
    return present;
  }
  override async listAccessibleApps(accountId: string, page: { cursor?: string; limit?: number } = {}):
    Promise<{ apps: readonly AppAccess[]; nextCursor?: string }> {
    const limit = appListLimit(page);
    if (!accountId) return { apps: [] };
    if (!await this.#column("capsules", "owner_account_id") ||
      !await this.#column("capsule_members", "capsule_id")) {
      const result = await this.db.prepare(`
        with input(account_id, cursor_id) as (values (?, ?))
        select c.id as capsule_id, case when json_extract(w.record_json, '$.ownerUserId')=i.account_id
          then 'owner' else 'member' end as role,
          json_extract(w.record_json, '$.ownerUserId') as owner_account_id, 0 as ownership_epoch
        from capsules c cross join input i
        join workspaces w on w.id=c.space_id
        where c.status<>'destroyed' and c.id collate binary>i.cursor_id collate binary
          and coalesce(json_extract(w.record_json, '$.ownerUserId'), '')<>''
          and (json_extract(w.record_json, '$.ownerUserId')=i.account_id or exists (
            select 1 from workspace_members wm
            where wm.workspace_id=c.space_id and wm.account_id=i.account_id and wm.status='active'
              and json_extract(wm.record_json, '$.workspaceId')=wm.workspace_id
              and json_extract(wm.record_json, '$.accountId')=wm.account_id
              and json_extract(wm.record_json, '$.status')='active'
              and json_type(wm.record_json, '$.roles')='array'
              and exists(select 1 from json_each(wm.record_json, '$.roles') where value in ('owner','admin'))))
        order by c.id collate binary asc limit ?`).bind(accountId, page.cursor ?? "", limit + 1).all<AccessListRow>();
      return accessListPage(result.results ?? [], limit);
    }
    const result = await this.db.prepare(`
      with input(account_id, cursor_id) as (values (?, ?))
      select c.id as capsule_id,
        case when c.owner_account_id=i.account_id or
          (c.owner_account_id is null and json_extract(w.record_json, '$.ownerUserId')=i.account_id)
          then 'owner' else 'member' end as role,
        coalesce(c.owner_account_id, json_extract(w.record_json, '$.ownerUserId')) as owner_account_id,
        case when c.owner_account_id is null then 0 else c.ownership_epoch end as ownership_epoch
      from capsules c cross join input i
      left join workspaces w on w.id=c.space_id
      where c.status<>'destroyed' and c.id collate binary > i.cursor_id collate binary
        and (c.owner_account_id=i.account_id
          or (c.owner_account_id is not null and exists (
            select 1 from capsule_members m
            where m.capsule_id=c.id and m.account_id=i.account_id and m.status='active'))
          or (c.owner_account_id is null and w.id is not null
            and coalesce(json_extract(w.record_json, '$.ownerUserId'), '')<>'' and (
            json_extract(w.record_json, '$.ownerUserId')=i.account_id
            or exists (select 1 from workspace_members wm
              where wm.workspace_id=c.space_id and wm.account_id=i.account_id and wm.status='active'
                and json_extract(wm.record_json, '$.workspaceId')=wm.workspace_id
                and json_extract(wm.record_json, '$.accountId')=wm.account_id
                and json_extract(wm.record_json, '$.status')='active'
                and json_type(wm.record_json, '$.roles')='array'
                and exists (select 1 from json_each(wm.record_json, '$.roles')
                  where value in ('owner', 'admin'))))))
      order by c.id collate binary asc limit ?`).bind(accountId, page.cursor ?? "", limit + 1).all<AccessListRow>();
    return accessListPage(result.results ?? [], limit);
  }
  async getOwnership(id: string): Promise<CapsuleOwnership | undefined> {
    if (!await this.#column("capsules", "owner_account_id")) return undefined;
    const row = await this.db.prepare(`select owner_account_id,ownership_epoch,management_state,management_epoch,storage_root from capsules where id=?`).bind(id).first<OwnershipRow>();
    return ownerRow(id, row ?? undefined);
  }
  override async readOwnershipFence(id: string): Promise<CapsuleOwnershipFence> {
    // Reuses the cached v77 column probe. On a pre-v77 schema the absence is
    // trusted for a short TTL so request paths (Run streams, link views) do
    // not probe on every decision; the additive migration is seen within it.
    if (this.now() < this.#fenceSchemaAbsentUntil) return { schemaAvailable: false };
    if (!await this.#column("capsules", "owner_account_id")) {
      this.#fenceSchemaAbsentUntil = this.now() + D1_OWNERSHIP_FENCE_ABSENT_TTL_MS;
      return { schemaAvailable: false };
    }
    const row = await this.db.prepare(`select owner_account_id,ownership_epoch,management_state,management_epoch,storage_root from capsules where id=?`).bind(id).first<OwnershipRow>();
    const ownership = ownerRow(id, row ?? undefined);
    return ownership ? { schemaAvailable: true, ownership } : { schemaAvailable: true };
  }
  override async listOwnedCapsuleIds(capsuleIds: readonly string[]): Promise<ReadonlySet<string>> {
    const ids = [...new Set(capsuleIds)];
    if (!ids.length || this.now() < this.#fenceSchemaAbsentUntil) return new Set();
    if (!await this.#column("capsules", "owner_account_id")) {
      this.#fenceSchemaAbsentUntil = this.now() + D1_OWNERSHIP_FENCE_ABSENT_TTL_MS;
      return new Set();
    }
    const owned = new Set<string>();
    // D1 binds at most 100 parameters per statement.
    for (let index = 0; index < ids.length; index += 90) {
      const chunk = ids.slice(index, index + 90);
      const rows = await this.db.prepare(
        `select id from capsules where owner_account_id is not null and id in (${chunk.map(() => "?").join(",")})`,
      ).bind(...chunk).all<{ id: string }>();
      for (const row of rows.results ?? []) owned.add(row.id);
    }
    return owned;
  }
  async putOwnership(record: CapsuleOwnership, expectedOwnershipEpoch = record.ownershipEpoch): Promise<boolean> {
    validOwnership(record);
    if (!validOwnershipEpochCas(record, expectedOwnershipEpoch)) return false;
    if (!await this.#column("capsules", "owner_account_id")) return false;
    if (!this.db.batch) throw new Error("D1 batch required for ownership mutation");
    const results = await this.db.batch([
      this.db.prepare(`update capsules set owner_account_id=?,ownership_epoch=?,management_state=?,management_epoch=?,storage_root=?
        where id=? and ownership_epoch=? and (owner_account_id is null or owner_account_id=? or ?=?)`)
        .bind(record.ownerAccountId,record.ownershipEpoch,record.managementState,record.managementEpoch,record.storageRoot,
          record.capsuleId,expectedOwnershipEpoch,record.ownerAccountId,record.ownershipEpoch,expectedOwnershipEpoch + 1),
      // changes() belongs to the immediately preceding UPDATE in this batch.
      this.db.prepare(`delete from capsule_members where capsule_id=? and account_id=? and changes()=1`)
        .bind(record.capsuleId,record.ownerAccountId),
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }
  async initializeOwnershipIfMissing(record: CapsuleOwnership): Promise<boolean> {
    validOwnership(record);
    if (!await this.#column("capsules", "owner_account_id")) return false;
    if (!this.db.batch) throw new Error("D1 batch required for ownership mutation");
    const results = await this.db.batch([
      this.db.prepare(`update capsules set owner_account_id=?,ownership_epoch=?,management_state=?,management_epoch=?,storage_root=?
        where id=? and owner_account_id is null`)
        .bind(record.ownerAccountId,record.ownershipEpoch,record.managementState,record.managementEpoch,record.storageRoot,record.capsuleId),
      this.db.prepare(`delete from capsule_members where capsule_id=? and account_id=? and changes()=1`)
        .bind(record.capsuleId,record.ownerAccountId),
    ]);
    return (results[0]?.meta?.changes ?? 0) > 0;
  }
  async listMembers(id: string): Promise<readonly CapsuleMember[]> {
    if (!await this.#column("capsule_members", "capsule_id")) return [];
    const rows = await this.db.prepare(`select * from capsule_members where capsule_id=? order by account_id`).bind(id).all<MemberRow>();
    return (rows.results ?? []).map(memberRow);
  }
  async putMember(record: CapsuleMember): Promise<boolean> {
    validMember(record);
    if (!await this.#column("capsule_members", "capsule_id")) return false;
    const result = await this.db.prepare(`insert into capsule_members (capsule_id,account_id,status,added_by,created_at,updated_at)
      select ?,?,?,?,?,? where exists(select 1 from capsules where id=? and owner_account_id is not null and owner_account_id<>?)
      on conflict (capsule_id,account_id) do update set status=excluded.status,added_by=excluded.added_by,updated_at=excluded.updated_at`)
      .bind(record.capsuleId,record.accountId,record.status,record.addedBy ?? null,record.createdAt,record.updatedAt,record.capsuleId,record.accountId).run();
    return (result.meta?.changes ?? 0) > 0;
  }
  async deleteMember(id: string, accountId: string): Promise<boolean> {
    if (!await this.#column("capsule_members", "capsule_id")) return false;
    const result = await this.db.prepare(`delete from capsule_members where capsule_id=? and account_id=?`).bind(id,accountId).run();
    return (result.meta?.changes ?? 0) > 0;
  }
  async getAccountBillingBinding(id: string): Promise<AccountBillingBinding | undefined> {
    if (!await this.#column("account_billing_bindings", "account_id")) return undefined;
    const row = await this.db.prepare(`select * from account_billing_bindings where account_id=?`).bind(id).first<BillingRow>();
    return row ? billingRow(row) : undefined;
  }
  async putAccountBillingBinding(record: AccountBillingBinding): Promise<boolean> {
    validBilling(record);
    if (!await this.#column("account_billing_bindings", "account_id")) return false;
    const result = await this.db.prepare(`insert into account_billing_bindings (account_id,billing_authority,billing_ref,organization_ref,created_at,updated_at)
      values (?,?,?,?,?,?) on conflict (account_id) do update set billing_authority=excluded.billing_authority,billing_ref=excluded.billing_ref,organization_ref=excluded.organization_ref,updated_at=excluded.updated_at`)
      .bind(record.accountId,record.billingAuthority,record.billingRef,record.organizationRef ?? null,record.createdAt,record.updatedAt).run();
    return (result.meta?.changes ?? 0) > 0;
  }
  async setConnectionOwnerIfMissing(id: string, owner: string): Promise<boolean> {
    if (!id || !owner || !await this.#column("connections", "owner_account_id")) return false;
    const result = await this.db.prepare(`update connections set owner_account_id=? where id=? and owner_account_id is null
      and json_extract(connection_json, '$.scope')='workspace'`).bind(owner,id).run();
    return (result.meta?.changes ?? 0) > 0;
  }
  async setUsagePayerIfMissing(id: string, payer: string): Promise<boolean> {
    if (!id || !payer || !await this.#column("usage_events", "payer_account_id")) return false;
    const result = await this.db.prepare(`update usage_events set payer_account_id=? where id=? and payer_account_id is null`).bind(payer,id).run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
