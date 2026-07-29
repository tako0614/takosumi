import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
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
import type { D1Like } from "../resource-shape/d1_stores.ts";
import type {
  InterfaceAuthorizationPageInput,
  InterfaceAuthorizationQuery,
  InterfaceBindingStore,
  InterfaceListFilter,
  InterfaceStore,
  InterfaceStores,
  InterfaceWriteGuard,
} from "./stores.ts";
import { interfaceFormLineage } from "./stores.ts";
import { interfaceOAuth2ResourceUri } from "./oauth_resource.ts";

interface JsonRow {
  readonly record_json: string;
}

class D1InterfaceStore implements InterfaceStore {
  readonly #table = names.interfaces;

  constructor(readonly db: D1Like) {}

  async create(record: Interface): Promise<boolean> {
    const result = await this.db
      .prepare(
        `insert or ignore into ${this.#table} (
        id, workspace_id, owner_kind, owner_id, name, interface_type,
        phase, generation, resolved_revision, oauth_resource_uri,
        form_ref_key, form_schema_digest, descriptor_name, descriptor_version,
        record_json, created_at, updated_at
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(...interfaceParameters(record, false))
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
  ): Promise<boolean> {
    try {
      const result = await this.db
        .prepare(
          `update ${this.#table} set
          workspace_id=?, owner_kind=?, owner_id=?, name=?, interface_type=?,
          phase=?, generation=?, resolved_revision=?,
          oauth_resource_uri=case
            when oauth_resource_uri=? then oauth_resource_uri else null end,
          form_ref_key=?, form_schema_digest=?, descriptor_name=?, descriptor_version=?,
          record_json=?,
          created_at=?, updated_at=?
         where id=? and generation=? and resolved_revision=? and record_json=?`,
        )
        .bind(
          ...interfaceParameters(record, true).slice(1),
          record.metadata.id,
          expected.generation,
          expected.resolvedRevision,
          JSON.stringify(expected.record),
        )
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
  }): Promise<boolean> {
    if (interfaceOAuth2ResourceUri(input.record) !== input.resource) {
      return false;
    }
    try {
      const result = await this.db
        .prepare(
          `update ${this.#table} set oauth_resource_uri=?
           where id=? and workspace_id=? and owner_kind=? and owner_id=?
             and phase='Resolved' and generation=? and resolved_revision=?
             and record_json=?`,
        )
        .bind(
          input.resource,
          input.record.metadata.id,
          input.record.metadata.workspaceId,
          input.record.metadata.ownerRef.kind,
          input.record.metadata.ownerRef.id,
          input.record.metadata.generation,
          input.record.status.resolvedRevision,
          JSON.stringify(input.record),
        )
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

  constructor(readonly db: D1Like) {}

  async create(record: InterfaceBinding): Promise<boolean> {
    const result = await this.db
      .prepare(
        `insert or ignore into ${this.#table} (
        id, workspace_id, interface_id, subject_kind, subject_id,
        phase, generation, record_json, created_at, updated_at
      ) values (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(...bindingParameters(record))
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
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `update ${this.#table} set workspace_id=?, interface_id=?,
        subject_kind=?, subject_id=?, phase=?, generation=?, record_json=?,
        created_at=?, updated_at=? where id=? and generation=?`,
      )
      .bind(
        ...bindingParameters(record).slice(1),
        record.metadata.id,
        expectedGeneration,
      )
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}

class D1InterfaceAuthorizationQuery implements InterfaceAuthorizationQuery {
  readonly #interfaces = names.interfaces;
  readonly #bindings = names.interfaceBindings;

  constructor(readonly db: D1Like) {}

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
    const clauses = ["i.workspace_id = ?", "i.phase = 'Resolved'"];
    const parameters: unknown[] = [input.filter.workspaceId];
    const add = (sql: string, value: unknown): void => {
      clauses.push(sql);
      parameters.push(value);
    };
    if (input.uiSurfaceCandidates) {
      const capsuleOwnerClause = input.capsuleId
        ? "and i.owner_id = ?"
        : "";
      clauses.push(
        `(
          (
            i.owner_kind = 'Capsule' and i.interface_type = ?
            and json_extract(i.record_json, '$.spec.version') = ?
            ${capsuleOwnerClause}
          )
          or (
            i.owner_kind = 'Resource'
            and json_extract(i.record_json, '$.spec.document.launcher') = 1
          )
        )`,
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
  const form = interfaceFormLineage(record);
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
    form?.formRefKey ?? null,
    form?.formSchemaDigest ?? null,
    form?.descriptorName ?? null,
    form?.descriptorVersion ?? null,
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

export function createD1InterfaceStores(db: D1Like): InterfaceStores {
  return {
    persistence: "durable",
    interfaces: new D1InterfaceStore(db),
    bindings: new D1InterfaceBindingStore(db),
    authorized: new D1InterfaceAuthorizationQuery(db),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed/iu.test(message);
}
