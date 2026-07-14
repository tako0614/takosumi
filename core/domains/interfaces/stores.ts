import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
import { freezeClone } from "../../shared/freeze.ts";

export interface InterfaceListFilter {
  readonly workspaceId: string;
  readonly type?: string;
  readonly phase?: Interface["status"]["phase"];
  readonly ownerKind?: Interface["metadata"]["ownerRef"]["kind"];
  readonly ownerId?: string;
  readonly includeRetired?: boolean;
}

export interface InterfaceWriteGuard {
  readonly generation: number;
  readonly resolvedRevision: number;
  /** Exact prior row prevents lost condition-only lifecycle updates. */
  readonly record: Interface;
}

export interface InterfaceStore {
  create(record: Interface): Promise<boolean>;
  get(id: string): Promise<Interface | undefined>;
  getByName(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly name: string;
  }): Promise<Interface | undefined>;
  list(filter: InterfaceListFilter): Promise<readonly Interface[]>;
  /** Internal global keyset scan used only for bounded host projection repair. */
  listProjectionPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<readonly Interface[]>;
  compareAndSet(
    record: Interface,
    expected: InterfaceWriteGuard,
  ): Promise<boolean>;
}

export interface InterfaceBindingStore {
  create(record: InterfaceBinding): Promise<boolean>;
  get(id: string): Promise<InterfaceBinding | undefined>;
  listByInterface(interfaceId: string): Promise<readonly InterfaceBinding[]>;
  compareAndSet(
    record: InterfaceBinding,
    expectedGeneration: number,
  ): Promise<boolean>;
}

export interface InterfaceStores {
  /** Composition-time persistence assertion used by strict runtime gates. */
  readonly persistence: "durable" | "ephemeral";
  readonly interfaces: InterfaceStore;
  readonly bindings: InterfaceBindingStore;
}

export class InMemoryInterfaceStore implements InterfaceStore {
  readonly #records = new Map<string, Interface>();

  create(record: Interface): Promise<boolean> {
    if (this.#records.has(record.metadata.id)) return Promise.resolve(false);
    for (const existing of this.#records.values()) {
      if (sameName(existing, record) && existing.status.phase !== "Retired") {
        return Promise.resolve(false);
      }
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    return Promise.resolve(true);
  }

  get(id: string): Promise<Interface | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  getByName(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly name: string;
  }): Promise<Interface | undefined> {
    for (const record of this.#records.values()) {
      if (
        record.metadata.workspaceId === input.workspaceId &&
        record.metadata.ownerRef.kind === input.ownerKind &&
        record.metadata.ownerRef.id === input.ownerId &&
        record.metadata.name === input.name &&
        record.status.phase !== "Retired"
      )
        return Promise.resolve(record);
    }
    return Promise.resolve(undefined);
  }

  list(filter: InterfaceListFilter): Promise<readonly Interface[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter((record) => matches(record, filter))
        .sort(
          (left, right) =>
            left.metadata.name.localeCompare(right.metadata.name) ||
            left.metadata.id.localeCompare(right.metadata.id),
        ),
    );
  }

  listProjectionPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<readonly Interface[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter(
          (record) =>
            !input.cursor || record.metadata.id.localeCompare(input.cursor) > 0,
        )
        .sort((left, right) =>
          left.metadata.id.localeCompare(right.metadata.id),
        )
        .slice(0, input.limit)
        .map(freezeClone),
    );
  }

  compareAndSet(
    record: Interface,
    expected: InterfaceWriteGuard,
  ): Promise<boolean> {
    const current = this.#records.get(record.metadata.id);
    if (
      !current ||
      current.metadata.generation !== expected.generation ||
      current.status.resolvedRevision !== expected.resolvedRevision ||
      JSON.stringify(current) !== JSON.stringify(expected.record)
    )
      return Promise.resolve(false);
    for (const existing of this.#records.values()) {
      if (
        existing.metadata.id !== record.metadata.id &&
        sameName(existing, record) &&
        existing.status.phase !== "Retired"
      )
        return Promise.resolve(false);
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    return Promise.resolve(true);
  }
}

export class InMemoryInterfaceBindingStore implements InterfaceBindingStore {
  readonly #records = new Map<string, InterfaceBinding>();

  create(record: InterfaceBinding): Promise<boolean> {
    if (this.#records.has(record.metadata.id)) return Promise.resolve(false);
    for (const existing of this.#records.values()) {
      if (
        existing.spec.interfaceId === record.spec.interfaceId &&
        existing.spec.subjectRef.kind === record.spec.subjectRef.kind &&
        existing.spec.subjectRef.id === record.spec.subjectRef.id &&
        existing.status.phase !== "Revoked"
      )
        return Promise.resolve(false);
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    return Promise.resolve(true);
  }

  get(id: string): Promise<InterfaceBinding | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  listByInterface(interfaceId: string): Promise<readonly InterfaceBinding[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter((record) => record.spec.interfaceId === interfaceId)
        .sort(
          (left, right) =>
            left.metadata.createdAt.localeCompare(right.metadata.createdAt) ||
            left.metadata.id.localeCompare(right.metadata.id),
        ),
    );
  }

  compareAndSet(
    record: InterfaceBinding,
    expectedGeneration: number,
  ): Promise<boolean> {
    const current = this.#records.get(record.metadata.id);
    if (!current || current.metadata.generation !== expectedGeneration) {
      return Promise.resolve(false);
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    return Promise.resolve(true);
  }
}

export function createInMemoryInterfaceStores(): InterfaceStores {
  return {
    persistence: "ephemeral",
    interfaces: new InMemoryInterfaceStore(),
    bindings: new InMemoryInterfaceBindingStore(),
  };
}

function sameName(left: Interface, right: Interface): boolean {
  return (
    left.metadata.workspaceId === right.metadata.workspaceId &&
    left.metadata.ownerRef.kind === right.metadata.ownerRef.kind &&
    left.metadata.ownerRef.id === right.metadata.ownerRef.id &&
    left.metadata.name === right.metadata.name
  );
}

function matches(record: Interface, filter: InterfaceListFilter): boolean {
  return (
    record.metadata.workspaceId === filter.workspaceId &&
    (filter.type === undefined || record.spec.type === filter.type) &&
    (filter.phase === undefined || record.status.phase === filter.phase) &&
    (filter.ownerKind === undefined ||
      record.metadata.ownerRef.kind === filter.ownerKind) &&
    (filter.ownerId === undefined ||
      record.metadata.ownerRef.id === filter.ownerId) &&
    (filter.includeRetired === true || record.status.phase !== "Retired")
  );
}
