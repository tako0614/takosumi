import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
import { deployControlD1TableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { D1Like } from "../resource-shape/d1_stores.ts";
import type {
  InterfaceBindingStore,
  InterfaceListFilter,
  InterfaceStore,
  InterfaceStores,
  InterfaceWriteGuard,
} from "./stores.ts";

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
        phase, generation, resolved_revision, record_json, created_at, updated_at
      ) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(...interfaceParameters(record))
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
    if (filter.includeRetired !== true) clauses.push("phase <> 'Retired'");
    const rows = await this.db
      .prepare(
        `select record_json from ${this.#table}
       where ${clauses.join(" and ")} order by name asc, id asc`,
      )
      .bind(...parameters)
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
          phase=?, generation=?, resolved_revision=?, record_json=?,
          created_at=?, updated_at=?
         where id=? and generation=? and resolved_revision=? and record_json=?`,
        )
        .bind(
          ...interfaceParameters(record).slice(1),
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

function interfaceParameters(record: Interface): readonly unknown[] {
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
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed/iu.test(message);
}
