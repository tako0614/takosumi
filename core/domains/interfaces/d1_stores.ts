import type { Interface, InterfaceBinding, InterfaceLink } from "takosumi-contract/interfaces";
import {
  clampPageLimit,
  decodeCursor,
  pageFromProbeBy,
} from "takosumi-contract/pagination";
import {
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
} from "takosumi-contract";
import { deployControlD1TableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { D1Like } from "../../adapters/storage/d1.ts";
import type { InterfaceMaterializationWriteAuthority } from "../deploy-control/interface_materialization_intent.ts";
import { WorkspaceManagementAdmissionConflictError, assertWorkspaceManagementAuthorityInput, type WorkspaceManagementAuthority } from "../deploy-control/store.ts";
import type {
  InterfaceAuthorizationPageInput,
  InterfaceAuthorizationQuery,
  InterfaceBindingStore,
  InterfaceLinkKey,
  InterfaceLinkReplacement,
  InterfaceLinkStore,
  InterfaceListFilter,
  InterfaceStore,
  InterfaceStores,
  InterfaceWriteGuard,
} from "./stores.ts";
import { isCurrentInterfaceLink, isValidInterfaceLinkReplacement, isValidInterfaceLinkUpdate } from "./stores.ts";
import { interfaceOAuth2ResourceUri } from "./oauth_resource.ts";
import { registerIdentityPrincipalStorage } from "../identity-reconciliation/storage-identity.ts";
import { InterfaceServiceError } from "./service.ts";

interface JsonRow {
  readonly record_json: string;
}

interface GuardedInterfaceReadbackRow {
  readonly workspace_id: string | null;
  readonly management_workspace_id: string | null;
  readonly management_state: string | null;
}

class D1InterfaceStore implements InterfaceStore {
  readonly #table = names.interfaces;

  constructor(readonly db: D1Like) {}

  async create(
    record: Interface,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && !interfaceMatchesAuthority(record, authority)) return false;
    const parameters = [...interfaceParameters(record, false)];
    const authorityClause = d1MaterializationAuthorityClause(
      parameters,
      authority,
    );
    const result = await this.db
      .prepare(
        `insert or ignore into ${this.#table} (
        id, workspace_id, owner_kind, owner_id, name, interface_type,
        phase, generation, resolved_revision, oauth_resource_uri,
        record_json, created_at, updated_at
      ) select ?,?,?,?,?,?,?,?,?,?,?,?,?
      where ${authorityClause}`,
      )
      .bind(...parameters)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async get(id: string): Promise<Interface | undefined> {
    const row = await this.db
      .prepare(`select record_json from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<JsonRow>();
    return row ? (JSON.parse(row.record_json) as Interface) : undefined;
  }

  async getByName(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly name: string;
  }): Promise<Interface | undefined> {
    const row = await this.db
      .prepare(
        `select record_json from ${this.#table}
       where workspace_id = ? and owner_kind = ? and owner_id = ?
         and name = ? and phase <> 'Retired' limit 1`,
      )
      .bind(input.workspaceId, input.ownerKind, input.ownerId, input.name)
      .first<JsonRow>();
    return row ? (JSON.parse(row.record_json) as Interface) : undefined;
  }

  async list(filter: InterfaceListFilter): Promise<readonly Interface[]> {
    if (filter.ownerIds?.length === 0) return [];
    const clauses = ["workspace_id = ?"];
    const parameters: unknown[] = [filter.workspaceId];
    const add = (sql: string, value: unknown): void => {
      clauses.push(sql);
      parameters.push(value);
    };
    if (filter.type !== undefined) add("interface_type = ?", filter.type);
    if (filter.phase !== undefined) add("phase = ?", filter.phase);
    if (filter.ownerKind !== undefined) add("owner_kind = ?", filter.ownerKind);
    if (filter.ownerId !== undefined) add("owner_id = ?", filter.ownerId);
    if (filter.ownerIds !== undefined) {
      clauses.push(`owner_id in (${filter.ownerIds.map(() => "?").join(",")})`);
      parameters.push(...filter.ownerIds);
    }
    if (filter.includeRetired !== true) clauses.push("phase <> 'Retired'");
    if (filter.limit !== undefined) parameters.push(filter.limit);
    const rows = await this.db
      .prepare(
        `select record_json from ${this.#table}
       where ${clauses.join(" and ")} order by name asc, id asc${
         filter.limit === undefined ? "" : " limit ?"
       }`,
      )
      .bind(...parameters)
      .all<JsonRow>();
    return (rows.results ?? []).map(
      (row) => JSON.parse(row.record_json) as Interface,
    );
  }

  async listProjectionPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<readonly Interface[]> {
    const rows = await this.db
      .prepare(
        `select record_json from ${this.#table}
         ${input.cursor ? "where id > ?" : ""}
         order by id asc limit ?`,
      )
      .bind(...(input.cursor ? [input.cursor, input.limit] : [input.limit]))
      .all<JsonRow>();
    return (rows.results ?? []).map(
      (row) => JSON.parse(row.record_json) as Interface,
    );
  }

  async compareAndSet(
    record: Interface,
    expected: InterfaceWriteGuard,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && !interfaceMatchesAuthority(record, authority)) return false;
    if (
      expected.requireActiveWorkspace === true &&
      record.metadata.workspaceId !== expected.record.metadata.workspaceId
    ) {
      return false;
    }
    const parameters = [
      ...interfaceParameters(record, true).slice(1),
      record.metadata.id,
      expected.generation,
      expected.resolvedRevision,
      JSON.stringify(expected.record),
    ];
    if (expected.requireActiveWorkspace === true) {
      // A single correlated EXISTS keeps the Workspace fence and Interface CAS
      // atomic on D1. The workspace id is read from the persisted Interface row
      // by the UPDATE predicate, never selected from a replacement payload.
      const guardedParameters = [
        ...interfaceParameters(record, true).slice(1),
        record.metadata.id,
        expected.record.metadata.workspaceId,
        expected.generation,
        expected.resolvedRevision,
        JSON.stringify(expected.record),
      ];
      const authorityClause = d1MaterializationAuthorityClause(
        guardedParameters,
        authority,
      );
      try {
        const result = await this.db
          .prepare(
            `update ${this.#table} set
          workspace_id=?, owner_kind=?, owner_id=?, name=?, interface_type=?,
          phase=?, generation=?, resolved_revision=?,
          oauth_resource_uri=case
            when oauth_resource_uri=? then oauth_resource_uri else null end,
          record_json=?, created_at=?, updated_at=?
         where id=? and workspace_id=? and generation=? and resolved_revision=?
           and record_json=?
           and exists (
             select 1 from ${names.workspaces} management_workspace
              where management_workspace.id = ${this.#table}.workspace_id
                and management_workspace.management_state = 'active'
           )
           and ${authorityClause}`,
          )
          .bind(...guardedParameters)
          .run();
        if ((result.meta?.changes ?? 0) > 0) return true;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        return false;
      }

      // A failed UPDATE is either an ordinary CAS loss or a management
      // admission refusal. Readback classifies the persisted row after the
      // atomic attempt; this SELECT is intentionally not authority.
      const row = await this.db
        .prepare(
          `select i.workspace_id,
                  w.id as management_workspace_id,
                  w.management_state
             from ${this.#table} i
             left join ${names.workspaces} w on w.id = i.workspace_id
            where i.id = ?
            limit 1`,
        )
        .bind(record.metadata.id)
        .first<GuardedInterfaceReadbackRow>();
      if (!row) return false;
      if (
        row.management_workspace_id === null ||
        row.management_state !== "active"
      ) {
        throw new WorkspaceManagementAdmissionConflictError(
          row.workspace_id ?? expected.record.metadata.workspaceId,
        );
      }
      return false;
    }
    const authorityClause = d1MaterializationAuthorityClause(
      parameters,
      authority,
    );
    try {
      const result = await this.db
        .prepare(
          `update ${this.#table} set
          workspace_id=?, owner_kind=?, owner_id=?, name=?, interface_type=?,
          phase=?, generation=?, resolved_revision=?,
          oauth_resource_uri=case
            when oauth_resource_uri=? then oauth_resource_uri else null end,
          record_json=?,
          created_at=?, updated_at=?
         where id=? and generation=? and resolved_revision=? and record_json=?
           and ${authorityClause}`,
        )
        .bind(...parameters)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async claimOAuth2Resource(input: {
    readonly record: Interface;
    readonly resource: string;
  }, authority?: InterfaceMaterializationWriteAuthority): Promise<boolean> {
    if (interfaceOAuth2ResourceUri(input.record) !== input.resource) {
      return false;
    }
    if (authority && !interfaceMatchesAuthority(input.record, authority)) {
      return false;
    }
    const parameters = [
      input.resource,
      input.record.metadata.id,
      input.record.metadata.workspaceId,
      input.record.metadata.ownerRef.kind,
      input.record.metadata.ownerRef.id,
      input.record.metadata.generation,
      input.record.status.resolvedRevision,
      JSON.stringify(input.record),
    ];
    const authorityClause = d1MaterializationAuthorityClause(
      parameters,
      authority,
    );
    try {
      const result = await this.db
        .prepare(
          `update ${this.#table} set oauth_resource_uri=?
           where id=? and workspace_id=? and owner_kind=? and owner_id=?
             and phase='Resolved' and generation=? and resolved_revision=?
             and record_json=? and ${authorityClause}`,
        )
        .bind(...parameters)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async findOAuth2ResourceClaim(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly resource: string;
  }): Promise<string | undefined> {
    const row = await this.db
      .prepare(
        `select id from ${this.#table}
         where workspace_id=? and owner_kind=? and owner_id=?
           and oauth_resource_uri=? limit 1`,
      )
      .bind(input.workspaceId, input.ownerKind, input.ownerId, input.resource)
      .first<{ readonly id: string }>();
    return row?.id;
  }
}

class D1InterfaceBindingStore implements InterfaceBindingStore {
  readonly #table = names.interfaceBindings;

  constructor(readonly db: D1Like) { registerIdentityPrincipalStorage(this, db); }

  async create(
    record: InterfaceBinding,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && record.metadata.workspaceId !== authority.workspaceId) {
      return false;
    }
    const parameters = [...bindingParameters(record)];
    const authorityClause = d1MaterializationAuthorityClause(
      parameters,
      authority,
      record.spec.interfaceId,
    );
    const result = await this.db
      .prepare(
        `insert or ignore into ${this.#table} (
        id, workspace_id, interface_id, subject_kind, subject_id,
        phase, generation, record_json, created_at, updated_at
      ) select ?,?,?,?,?,?,?,?,?,?
      where ${authorityClause}`,
      )
      .bind(...parameters)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async get(id: string): Promise<InterfaceBinding | undefined> {
    const row = await this.db
      .prepare(`select record_json from ${this.#table} where id = ? limit 1`)
      .bind(id)
      .first<JsonRow>();
    return row ? (JSON.parse(row.record_json) as InterfaceBinding) : undefined;
  }

  async listByInterface(
    interfaceId: string,
  ): Promise<readonly InterfaceBinding[]> {
    const rows = await this.db
      .prepare(
        `select record_json from ${this.#table}
       where interface_id = ? order by created_at asc, id asc`,
      )
      .bind(interfaceId)
      .all<JsonRow>();
    return (rows.results ?? []).map(
      (row) => JSON.parse(row.record_json) as InterfaceBinding,
    );
  }

  async compareAndSet(
    record: InterfaceBinding,
    expectedGeneration: number,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && record.metadata.workspaceId !== authority.workspaceId) {
      return false;
    }
    const parameters = [
      ...bindingParameters(record).slice(1),
      record.metadata.id,
      expectedGeneration,
    ];
    const authorityClause = d1MaterializationAuthorityClause(
      parameters,
      authority,
      record.spec.interfaceId,
    );
    const result = await this.db
      .prepare(
        `update ${this.#table} set workspace_id=?, interface_id=?,
        subject_kind=?, subject_id=?, phase=?, generation=?, record_json=?,
        created_at=?, updated_at=? where id=? and generation=?
          and ${authorityClause}`,
      )
      .bind(...parameters)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}

// The additive table is unavailable until the operator applies v76. Share one
// probe across both readers, coalesce concurrent probes, and retry absence after
// a short interval so a warm isolate can observe the fenced schema rollout.
class D1InterfaceLinkSchema {
  #available = false;
  #retryAfter = 0;
  #pending: Promise<boolean> | undefined;

  constructor(readonly db: D1Like) {}

  async available(): Promise<boolean> {
    if (this.#available) return true;
    if (Date.now() < this.#retryAfter) return false;
    this.#pending ??= Promise.resolve().then(async () => {
      const row = await this.db.prepare(
        `select 1 as available from schema_migrations
         where version=76 and name='d1_interface_links'
           and exists (select 1 from sqlite_master where type='table' and name='interface_links') limit 1`,
      ).first<{ readonly available: number }>();
      this.#available = row?.available === 1;
      this.#retryAfter = this.#available ? 0 : Date.now() + 1_000;
      return this.#available;
    }).finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async require(): Promise<void> {
    if (!await this.available()) {
      throw new InterfaceServiceError("failed_precondition", "Interface links require Control schema v76");
    }
  }
}

class D1InterfaceLinkStore implements InterfaceLinkStore {
  readonly #table = names.interfaceLinks;

  constructor(readonly db: D1Like, readonly schema: D1InterfaceLinkSchema) {}

  available(): Promise<boolean> { return this.schema.available(); }

  async create(record: InterfaceLink, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    await this.schema.require();
    if (record.generation !== 1 || !isCurrentInterfaceLink(record)) return false;
    const parameters = [...linkParameters(record), record.consumerCapsuleId, record.requirementKey];
    const managementClause = d1LinkManagementClause(parameters, guard);
    const result = await this.db.prepare(
      `insert or ignore into ${this.#table} (${LINK_COLUMNS})
       select ${LINK_PLACEHOLDERS} where not exists (
         select 1 from ${this.#table} where consumer_capsule_id=? and requirement_key=?
       ) and ${managementClause}`,
    ).bind(...parameters).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async get(id: string): Promise<InterfaceLink | undefined> {
    if (!await this.schema.available()) return undefined;
    const row = await this.db.prepare(`select record_json from ${this.#table} where id=? limit 1`).bind(id).first<JsonRow>();
    return row ? JSON.parse(row.record_json) as InterfaceLink : undefined;
  }

  async getCurrent(key: InterfaceLinkKey): Promise<InterfaceLink | undefined> {
    return await this.#find(key, true);
  }

  async getLatest(key: InterfaceLinkKey): Promise<InterfaceLink | undefined> {
    return await this.#find(key, false);
  }

  async #find(key: InterfaceLinkKey, current: boolean): Promise<InterfaceLink | undefined> {
    if (!await this.schema.available()) return undefined;
    const row = await this.db.prepare(
      `select record_json from ${this.#table} where consumer_capsule_id=? and requirement_key=?
       ${current ? "and state in ('pending_approval','active')" : ""} order by generation desc limit 1`,
    ).bind(key.consumerCapsuleId, key.requirementKey).first<JsonRow>();
    return row ? JSON.parse(row.record_json) as InterfaceLink : undefined;
  }

  listByConsumerCapsule(id: string): Promise<readonly InterfaceLink[]> { return this.#list("consumer_capsule_id", id); }
  listByProviderInterface(id: string): Promise<readonly InterfaceLink[]> { return this.#list("provider_interface_id", id); }
  listByProviderCapsule(id: string): Promise<readonly InterfaceLink[]> { return this.#list("provider_capsule_id", id); }

  async #list(column: string, id: string): Promise<readonly InterfaceLink[]> {
    if (!await this.schema.available()) return [];
    const rows = await this.db.prepare(`select record_json from ${this.#table} where ${column}=? order by created_at asc, id asc`).bind(id).all<JsonRow>();
    return (rows.results ?? []).map((row) => JSON.parse(row.record_json) as InterfaceLink);
  }

  async compareAndSet(record: InterfaceLink, expectedGeneration: number, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    await this.schema.require();
    const prior = await this.get(record.id);
    if (!prior || prior.generation !== expectedGeneration || !isValidInterfaceLinkUpdate(record, prior)) return false;
    const parameters: unknown[] = [record.generation, record.state, JSON.stringify(record), record.updatedAt,
      record.id, expectedGeneration, JSON.stringify(prior)];
    const managementClause = d1LinkManagementClause(parameters, guard);
    const result = await this.db.prepare(
      `update ${this.#table} set generation=?, state=?, record_json=?, updated_at=?
       where id=? and generation=? and record_json=? and ${managementClause}`,
    ).bind(...parameters).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async replace(input: InterfaceLinkReplacement, management?: WorkspaceManagementAuthority): Promise<boolean> {
    await this.schema.require();
    if (!isValidInterfaceLinkReplacement(input)) return false;
    const { record, expected, revoked } = input;
    const guard = `exists (select 1 from ${this.#table} where id=? and generation=? and record_json=?)
      and not exists (select 1 from ${this.#table} where consumer_capsule_id=? and requirement_key=? and generation>?)`;
    const guardParameters = [expected.id, expected.generation, JSON.stringify(expected), expected.consumerCapsuleId, expected.requirementKey, expected.generation];
    try {
      if (!revoked) {
        const parameters = [...linkParameters(record), ...guardParameters];
        const managementClause = d1LinkManagementClause(parameters, management);
        const result = await this.db.prepare(`insert into ${this.#table} (${LINK_COLUMNS})
          select ${LINK_PLACEHOLDERS} where ${guard} and ${managementClause}`).bind(...parameters).run();
        return (result.meta?.changes ?? 0) > 0;
      }
      // D1 batch is one transaction. A failed plain INSERT rolls the old-link
      // UPDATE back; a stale guard changes neither row. Never emulate it with
      // sequential writes on a port without atomic batch support.
      if (!this.db.batch) throw new Error("InterfaceLink replacement requires D1 atomic batch support");
      const parameters: unknown[] = [revoked.generation, revoked.state, JSON.stringify(revoked), revoked.updatedAt,
        expected.id, ...guardParameters, record.id];
      const managementClause = d1LinkManagementClause(parameters, management);
      const results = await this.db.batch([
        this.db.prepare(`update ${this.#table} set generation=?, state=?, record_json=?, updated_at=?
          where id=? and ${guard}
          and not exists (select 1 from ${this.#table} where id=?) and ${managementClause}`)
          .bind(...parameters),
        this.db.prepare(`insert into ${this.#table} (${LINK_COLUMNS})
          select ${LINK_PLACEHOLDERS} where changes()=1`).bind(...linkParameters(record)),
      ]);
      return (results[1]?.meta?.changes ?? 0) > 0;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }
}

const LINK_COLUMNS = "id, generation, consumer_capsule_id, requirement_key, provider_interface_id, provider_capsule_id, state, record_json, created_at, updated_at";
const LINK_PLACEHOLDERS = "?,?,?,?,?,?,?,?,?,?";
function linkParameters(record: InterfaceLink): readonly unknown[] {
  return [record.id, record.generation, record.consumerCapsuleId, record.requirementKey,
    record.providerInterfaceId, record.providerCapsuleId, record.state, JSON.stringify(record), record.createdAt, record.updatedAt];
}

function d1LinkManagementClause(parameters: unknown[], guard?: WorkspaceManagementAuthority): string {
  if (!guard) return "1";
  assertWorkspaceManagementAuthorityInput(guard, guard.workspaceId);
  parameters.push(guard.workspaceId, guard.managementEpoch);
  return `exists (select 1 from ${names.workspaces} management_workspace
    where management_workspace.id=? and management_workspace.management_state='active'
      and management_workspace.management_epoch=?)`;
}

class D1InterfaceAuthorizationQuery implements InterfaceAuthorizationQuery {
  readonly #interfaces = names.interfaces;
  readonly #bindings = names.interfaceBindings;
  constructor(readonly db: D1Like, readonly schema: D1InterfaceLinkSchema) {}

  async listPage(
    input: InterfaceAuthorizationPageInput,
  ): ReturnType<InterfaceAuthorizationQuery["listPage"]> {
    if (input.filter.ownerIds?.length === 0) return { items: [] };
    if (
      input.filter.phase !== undefined &&
      input.filter.phase !== "Resolved"
    ) {
      return { items: [] };
    }
    // The existing v71-v75 runtime bridge keeps ordinary grants available.
    // Only the v76 receipt enables SQL that references the additive link table.
    const linksAvailable = await this.schema.available();
    const clauses = [
      ...(input.filter.workspaceId !== undefined ? ["i.workspace_id = ?"] : []),
      "i.phase = 'Resolved'",
    ];
    clauses.push(
      `not exists (
        select 1
        from json_each(
          case
            when json_type(i.record_json, '$.spec.inputs') = 'object'
              then json_extract(i.record_json, '$.spec.inputs')
            else '{}'
          end
        ) as capsule_input
        where case when capsule_input.type = 'object'
          then json_extract(capsule_input.value, '$.source') end = 'capsule_output'
          and (
            i.owner_kind <> 'Capsule'
            or json_type(capsule_input.value, '$.capsuleId') <> 'text'
            or coalesce(
              case when capsule_input.type = 'object'
                then json_extract(capsule_input.value, '$.capsuleId') end,
              ''
            ) <> i.owner_id
          )
      )`,
    );
    const parameters: unknown[] = input.filter.workspaceId !== undefined
      ? [input.filter.workspaceId]
      : [];
    const add = (sql: string, value: unknown): void => {
      clauses.push(sql);
      parameters.push(value);
    };
    if (input.uiSurfaceCandidates) {
      const capsuleOwnerClause = input.capsuleId
        ? "and i.owner_id = ?"
        : "";
      clauses.push(
        `(i.owner_kind = 'Capsule' and i.interface_type = ?
          and json_extract(i.record_json, '$.spec.version') = ?
          ${capsuleOwnerClause})`,
      );
      parameters.push(
        UI_SURFACE_INTERFACE_TYPE,
        UI_SURFACE_INTERFACE_VERSION,
      );
      if (input.capsuleId) parameters.push(input.capsuleId);
    } else {
      if (input.filter.type !== undefined)
        add("i.interface_type = ?", input.filter.type);
      if (input.filter.ownerKind !== undefined)
        add("i.owner_kind = ?", input.filter.ownerKind);
      if (input.filter.ownerId !== undefined)
        add("i.owner_id = ?", input.filter.ownerId);
      if (input.filter.ownerIds !== undefined) {
        clauses.push(
          `i.owner_id in (${input.filter.ownerIds.map(() => "?").join(",")})`,
        );
        parameters.push(...input.filter.ownerIds);
      }
    }
    if (input.filter.includeRetired !== true)
      clauses.push("i.phase <> 'Retired'");
    clauses.push(
      `exists (
        select 1
        from ${this.#bindings} b,
             json_each(b.record_json, '$.spec.permissions') permission
        where b.interface_id = i.id
          and b.workspace_id = i.workspace_id
          and b.subject_kind = 'Principal'
          and b.subject_id = ?
          and b.phase = 'Ready'
          and json_extract(
                b.record_json,
                '$.status.observedInterfaceRevision'
              ) = i.resolved_revision
          and permission.value = ?
          and (
            coalesce(json_extract(b.record_json, '$.metadata.materializedFrom.source'), '') <> 'capsule_required_interface'
            or ${linksAvailable ? `exists (
              select 1 from ${names.interfaceLinks} consent
              where (json_extract(b.record_json, '$.metadata.materializedFrom.linkId') is null
                or consent.id = json_extract(b.record_json, '$.metadata.materializedFrom.linkId'))
                and consent.state = 'active'
                and consent.provider_interface_id = i.id
                and i.owner_kind = 'Capsule' and consent.provider_capsule_id = i.owner_id
                and json_extract(consent.record_json, '$.interface.type') = i.interface_type
                and json_extract(consent.record_json, '$.interface.version') = json_extract(i.record_json, '$.spec.version')
                and json_extract(consent.record_json, '$.deliveryType') = json_extract(b.record_json, '$.spec.delivery.type')
                and consent.consumer_capsule_id = json_extract(b.record_json, '$.metadata.materializedFrom.capsuleId')
                and consent.requirement_key = json_extract(b.record_json, '$.metadata.materializedFrom.requirementKey')
                and json_extract(consent.record_json, '$.interface.type') = json_extract(b.record_json, '$.metadata.materializedFrom.interfaceType')
                and json_extract(consent.record_json, '$.interface.version') = json_extract(b.record_json, '$.metadata.materializedFrom.interfaceVersion')
                and exists (select 1 from json_each(consent.record_json, '$.requestedPermissions') requested where requested.value = permission.value)
                and exists (select 1 from json_each(consent.record_json, '$.approvedPermissions') approved where approved.value = permission.value)
            )` : "0"}
          )
      )`,
    );
    parameters.push(input.subjectId, input.permission);
    const cursor = decodeCursor(input.params.cursor);
    if (cursor) {
      clauses.push("(i.created_at > ? or (i.created_at = ? and i.id > ?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const limit = clampPageLimit(input.params.limit);
    parameters.push(limit + 1);
    const rows = await this.db
      .prepare(
        `select i.record_json from ${this.#interfaces} i
         where ${clauses.join(" and ")}
         order by i.created_at asc, i.id asc
         limit ?`,
      )
      .bind(...parameters)
      .all<JsonRow>();
    return pageFromProbeBy(
      (rows.results ?? []).map(
        (row) => JSON.parse(row.record_json) as Interface,
      ),
      limit,
      (iface) => ({
        createdAt: iface.metadata.createdAt,
        id: iface.metadata.id,
      }),
    );
  }
}

function interfaceParameters(
  record: Interface,
  preserveClaim: boolean,
): readonly unknown[] {
  return [
    record.metadata.id,
    record.metadata.workspaceId,
    record.metadata.ownerRef.kind,
    record.metadata.ownerRef.id,
    record.metadata.name,
    record.spec.type,
    record.status.phase,
    record.metadata.generation,
    record.status.resolvedRevision,
    preserveClaim ? (interfaceOAuth2ResourceUri(record) ?? null) : null,
    JSON.stringify(record),
    record.metadata.createdAt,
    record.metadata.updatedAt,
  ];
}

function bindingParameters(record: InterfaceBinding): readonly unknown[] {
  return [
    record.metadata.id,
    record.metadata.workspaceId,
    record.spec.interfaceId,
    record.spec.subjectRef.kind,
    record.spec.subjectRef.id,
    record.status.phase,
    record.metadata.generation,
    JSON.stringify(record),
    record.metadata.createdAt,
    record.metadata.updatedAt,
  ];
}

function interfaceMatchesAuthority(
  record: Interface,
  authority: InterfaceMaterializationWriteAuthority,
): boolean {
  return (
    record.metadata.workspaceId === authority.workspaceId &&
    record.metadata.ownerRef.kind === "Capsule" &&
    record.metadata.ownerRef.id === authority.capsuleId
  );
}

function d1MaterializationAuthorityClause(
  parameters: unknown[],
  authority: InterfaceMaterializationWriteAuthority | undefined,
  interfaceId?: string,
): string {
  if (!authority) return "true";
  parameters.push(
    authority.intentId,
    authority.leaseToken,
    authority.expectedNextItemIndex,
    authority.workspaceId,
    authority.capsuleId,
    authority.installConfigId,
    authority.stateVersionId,
    authority.outputId,
    authority.stateGeneration,
  );
  const interfaceOwnership = interfaceId
    ? `and exists (
         select 1 from ${names.interfaces} authority_interface
         where authority_interface.id = ?
           and authority_interface.workspace_id = authority_intent.workspace_id
           and authority_interface.owner_kind = 'Capsule'
           and authority_interface.owner_id = authority_intent.capsule_id
       )`
    : "";
  if (interfaceId) parameters.push(interfaceId);
  return `exists (
    select 1
    from ${names.capsuleInterfaceMaterializationIntents} authority_intent
    join ${names.capsules} authority_capsule
      on authority_capsule.id = authority_intent.capsule_id
     and authority_capsule.space_id = authority_intent.workspace_id
    where authority_intent.id = ?
      and authority_intent.status = 'pending'
      and authority_intent.lease_token = ?
      and authority_intent.next_item_index = ?
      and authority_intent.lease_expires_at is not null
      and julianday(authority_intent.lease_expires_at) > julianday('now')
      and authority_intent.workspace_id = ?
      and authority_intent.capsule_id = ?
      and authority_intent.install_config_id = ?
      and authority_intent.state_version_id = ?
      and authority_intent.output_id = ?
      and authority_intent.state_generation = ?
      and authority_capsule.install_config_id = authority_intent.install_config_id
      and authority_capsule.status <> 'destroyed'
      and authority_capsule.current_state_version_id = authority_intent.state_version_id
      and authority_capsule.current_output_snapshot_id = authority_intent.output_id
      and authority_capsule.current_state_generation = authority_intent.state_generation
      ${interfaceOwnership}
  )`;
}

export function createD1InterfaceStores(db: D1Like): InterfaceStores {
  const schema = new D1InterfaceLinkSchema(db);
  return {
    persistence: "durable",
    interfaces: new D1InterfaceStore(db),
    bindings: new D1InterfaceBindingStore(db),
    links: new D1InterfaceLinkStore(db, schema),
    authorized: new D1InterfaceAuthorizationQuery(db, schema),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed/iu.test(message);
}
