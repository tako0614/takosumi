import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
import type { SqlClient, SqlValue } from "../../adapters/storage/sql.ts";
import { deployControlPostgresTableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type {
  InterfaceBindingStore,
  InterfaceListFilter,
  InterfaceStore,
  InterfaceStores,
  InterfaceWriteGuard,
} from "./stores.ts";

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
        phase, generation, resolved_revision, record_json, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
      on conflict do nothing`,
      interfaceParameters(record),
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
    const clauses = ["workspace_id = $1"];
    const parameters: (string | boolean)[] = [filter.workspaceId];
    const add = (sql: string, value: string | boolean): void => {
      parameters.push(value);
      clauses.push(sql.replace("?", `$${parameters.length}`));
    };
    if (filter.type !== undefined) add("interface_type = ?", filter.type);
    if (filter.phase !== undefined) add("phase = ?", filter.phase);
    if (filter.ownerKind !== undefined) add("owner_kind = ?", filter.ownerKind);
    if (filter.ownerId !== undefined) add("owner_id = ?", filter.ownerId);
    if (filter.includeRetired !== true) clauses.push("phase <> 'Retired'");
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table}
       where ${clauses.join(" and ")} order by name asc, id asc`,
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
    const p = interfaceParameters(record);
    try {
      const result = await this.client.query(
        `update ${this.#table} set
          workspace_id=$2, owner_kind=$3, owner_id=$4, name=$5,
          interface_type=$6, phase=$7, generation=$8, resolved_revision=$9,
          record_json=$10::jsonb, created_at=$11, updated_at=$12
         where id=$1 and generation=$13 and resolved_revision=$14
           and record_json=$15::jsonb`,
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

function interfaceParameters(record: Interface): readonly SqlValue[] {
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
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "23505" || /duplicate key|unique constraint/iu.test(message);
}
