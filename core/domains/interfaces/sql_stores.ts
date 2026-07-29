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
import type { SqlClient, SqlValue } from "../../adapters/storage/sql.ts";
import { deployControlPostgresTableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
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

type InterfaceRow = { readonly record_json: unknown };
type InterfaceBindingRow = { readonly record_json: unknown };

function decode<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

class SqlInterfaceStore implements InterfaceStore {
  readonly #table = names.interfaces;

  constructor(readonly client: SqlClient) {}

  async create(record: Interface): Promise<boolean> {
    const result = await this.client.query(
      `insert into ${this.#table} (
        id, workspace_id, owner_kind, owner_id, name, interface_type,
        phase, generation, resolved_revision, oauth_resource_uri,
        form_ref_key, form_schema_digest, descriptor_name, descriptor_version,
        record_json, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)
      on conflict do nothing`,
      interfaceParameters(record, false),
    );
    return result.rowCount > 0;
  }

  async get(id: string): Promise<Interface | undefined> {
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0]
      ? decode<Interface>(result.rows[0].record_json)
      : undefined;
  }

  async getByName(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly name: string;
  }): Promise<Interface | undefined> {
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table}
       where workspace_id = $1 and owner_kind = $2 and owner_id = $3
         and name = $4 and phase <> 'Retired' limit 1`,
      [input.workspaceId, input.ownerKind, input.ownerId, input.name],
    );
    return result.rows[0]
      ? decode<Interface>(result.rows[0].record_json)
      : undefined;
  }

  async list(filter: InterfaceListFilter): Promise<readonly Interface[]> {
    if (filter.ownerIds?.length === 0) return [];
    const clauses = ["workspace_id = $1"];
    const parameters: SqlValue[] = [filter.workspaceId];
    const add = (sql: string, value: SqlValue): void => {
      parameters.push(value);
      clauses.push(sql.replace("?", `$${parameters.length}`));
    };
    if (filter.type !== undefined) add("interface_type = ?", filter.type);
    if (filter.phase !== undefined) add("phase = ?", filter.phase);
    if (filter.ownerKind !== undefined) add("owner_kind = ?", filter.ownerKind);
    if (filter.ownerId !== undefined) add("owner_id = ?", filter.ownerId);
    if (filter.ownerIds !== undefined) {
      const placeholders = filter.ownerIds.map((ownerId) => {
        parameters.push(ownerId);
        return `$${parameters.length}`;
      });
      clauses.push(`owner_id in (${placeholders.join(",")})`);
    }
    if (filter.includeRetired !== true) clauses.push("phase <> 'Retired'");
    if (filter.limit !== undefined) parameters.push(filter.limit);
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table}
       where ${clauses.join(" and ")} order by name asc, id asc${
         filter.limit === undefined ? "" : ` limit $${parameters.length}`
       }`,
      parameters,
    );
    return result.rows.map((row) => decode<Interface>(row.record_json));
  }

  async listProjectionPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<readonly Interface[]> {
    const parameters: SqlValue[] = input.cursor
      ? [input.cursor, input.limit]
      : [input.limit];
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table}
       ${input.cursor ? "where id > $1" : ""}
       order by id asc limit $${parameters.length}`,
      parameters,
    );
    return result.rows.map((row) => decode<Interface>(row.record_json));
  }

  async compareAndSet(
    record: Interface,
    expected: InterfaceWriteGuard,
  ): Promise<boolean> {
    const p = interfaceParameters(record, true);
    try {
      const result = await this.client.query(
        `update ${this.#table} set
          workspace_id=$2, owner_kind=$3, owner_id=$4, name=$5,
          interface_type=$6, phase=$7, generation=$8, resolved_revision=$9,
          oauth_resource_uri=case
            when oauth_resource_uri=$10 then oauth_resource_uri else null end,
          form_ref_key=$11, form_schema_digest=$12,
          descriptor_name=$13, descriptor_version=$14,
          record_json=$15::jsonb, created_at=$16, updated_at=$17
         where id=$1 and generation=$18 and resolved_revision=$19
           and record_json=$20::jsonb`,
        [
          ...p,
          expected.generation,
          expected.resolvedRevision,
          JSON.stringify(expected.record),
        ],
      );
      return result.rowCount > 0;
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
      const result = await this.client.query(
        `update ${this.#table} set oauth_resource_uri=$1
         where id=$2 and workspace_id=$3 and owner_kind=$4 and owner_id=$5
           and phase='Resolved' and generation=$6 and resolved_revision=$7
           and record_json=$8::jsonb`,
        [
          input.resource,
          input.record.metadata.id,
          input.record.metadata.workspaceId,
          input.record.metadata.ownerRef.kind,
          input.record.metadata.ownerRef.id,
          input.record.metadata.generation,
          input.record.status.resolvedRevision,
          JSON.stringify(input.record),
        ],
      );
      return result.rowCount > 0;
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
    const result = await this.client.query<{ readonly id: string }>(
      `select id from ${this.#table}
       where workspace_id=$1 and owner_kind=$2 and owner_id=$3
         and oauth_resource_uri=$4 limit 1`,
      [input.workspaceId, input.ownerKind, input.ownerId, input.resource],
    );
    return result.rows[0]?.id;
  }
}

class SqlInterfaceBindingStore implements InterfaceBindingStore {
  readonly #table = names.interfaceBindings;

  constructor(readonly client: SqlClient) {}

  async create(record: InterfaceBinding): Promise<boolean> {
    const result = await this.client.query(
      `insert into ${this.#table} (
        id, workspace_id, interface_id, subject_kind, subject_id,
        phase, generation, record_json, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
      on conflict do nothing`,
      bindingParameters(record),
    );
    return result.rowCount > 0;
  }

  async get(id: string): Promise<InterfaceBinding | undefined> {
    const result = await this.client.query<InterfaceBindingRow>(
      `select record_json from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0]
      ? decode<InterfaceBinding>(result.rows[0].record_json)
      : undefined;
  }

  async listByInterface(
    interfaceId: string,
  ): Promise<readonly InterfaceBinding[]> {
    const result = await this.client.query<InterfaceBindingRow>(
      `select record_json from ${this.#table}
       where interface_id = $1 order by created_at asc, id asc`,
      [interfaceId],
    );
    return result.rows.map((row) => decode<InterfaceBinding>(row.record_json));
  }

  async compareAndSet(
    record: InterfaceBinding,
    expectedGeneration: number,
  ): Promise<boolean> {
    const p = bindingParameters(record);
    const result = await this.client.query(
      `update ${this.#table} set
        workspace_id=$2, interface_id=$3, subject_kind=$4, subject_id=$5,
        phase=$6, generation=$7, record_json=$8::jsonb,
        created_at=$9, updated_at=$10
       where id=$1 and generation=$11`,
      [...p, expectedGeneration],
    );
    return result.rowCount > 0;
  }
}

class SqlInterfaceAuthorizationQuery implements InterfaceAuthorizationQuery {
  readonly #interfaces = names.interfaces;
  readonly #bindings = names.interfaceBindings;

  constructor(readonly client: SqlClient) {}

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
    const parameters: SqlValue[] = [input.filter.workspaceId];
    const clauses = ["i.workspace_id = $1", "i.phase = 'Resolved'"];
    const placeholder = (value: SqlValue): string => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    const add = (column: string, value: SqlValue): void => {
      clauses.push(`${column} = ${placeholder(value)}`);
    };
    if (input.uiSurfaceCandidates) {
      const type = placeholder(UI_SURFACE_INTERFACE_TYPE);
      const version = placeholder(UI_SURFACE_INTERFACE_VERSION);
      const capsuleOwnerClause = input.capsuleId
        ? `and i.owner_id = ${placeholder(input.capsuleId)}`
        : "";
      clauses.push(
        `(
          (
            i.owner_kind = 'Capsule' and i.interface_type = ${type}
            and i.record_json->'spec'->>'version' = ${version}
            ${capsuleOwnerClause}
          )
          or (
            i.owner_kind = 'Resource'
            and i.record_json->'spec'->'document'->>'launcher' = 'true'
          )
        )`,
      );
    } else {
      if (input.filter.type !== undefined)
        add("i.interface_type", input.filter.type);
      if (input.filter.ownerKind !== undefined)
        add("i.owner_kind", input.filter.ownerKind);
      if (input.filter.ownerId !== undefined)
        add("i.owner_id", input.filter.ownerId);
      if (input.filter.ownerIds !== undefined) {
        clauses.push(
          `i.owner_id in (${input.filter.ownerIds
            .map((ownerId) => placeholder(ownerId))
            .join(",")})`,
        );
      }
    }
    if (input.filter.includeRetired !== true)
      clauses.push("i.phase <> 'Retired'");
    const subject = placeholder(input.subjectId);
    const permission = placeholder(JSON.stringify([input.permission]));
    clauses.push(
      `exists (
        select 1 from ${this.#bindings} b
        where b.interface_id = i.id
          and b.workspace_id = i.workspace_id
          and b.subject_kind = 'Principal'
          and b.subject_id = ${subject}
          and b.phase = 'Ready'
          and b.record_json->'status'->>'observedInterfaceRevision'
              = i.resolved_revision::text
          and b.record_json->'spec'->'permissions' @> ${permission}::jsonb
      )`,
    );
    const cursor = decodeCursor(input.params.cursor);
    if (cursor) {
      const createdAfter = placeholder(cursor.createdAt);
      const createdEqual = placeholder(cursor.createdAt);
      const idAfter = placeholder(cursor.id);
      clauses.push(
        `(i.created_at > ${createdAfter} or
          (i.created_at = ${createdEqual} and i.id > ${idAfter}))`,
      );
    }
    const limit = clampPageLimit(input.params.limit);
    const probe = placeholder(limit + 1);
    const result = await this.client.query<InterfaceRow>(
      `select i.record_json from ${this.#interfaces} i
       where ${clauses.join(" and ")}
       order by i.created_at asc, i.id asc
       limit ${probe}`,
      parameters,
    );
    return pageFromProbeBy(
      result.rows.map((row) => decode<Interface>(row.record_json)),
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
): readonly SqlValue[] {
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

function bindingParameters(record: InterfaceBinding): readonly SqlValue[] {
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

export function createSqlInterfaceStores(client: SqlClient): InterfaceStores {
  return {
    persistence: "durable",
    interfaces: new SqlInterfaceStore(client),
    bindings: new SqlInterfaceBindingStore(client),
    authorized: new SqlInterfaceAuthorizationQuery(client),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "23505" || /duplicate key|unique constraint/iu.test(message);
}
