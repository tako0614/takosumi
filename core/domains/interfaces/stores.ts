import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
import { freezeClone } from "../../shared/freeze.ts";
import { interfaceOAuth2ResourceUri } from "./oauth_resource.ts";

export interface InterfaceListFilter {
  readonly workspaceId: string;
  readonly type?: string;
  readonly phase?: Interface["status"]["phase"];
  readonly ownerKind?: Interface["metadata"]["ownerRef"]["kind"];
  readonly ownerId?: string;
  readonly includeRetired?: boolean;
}

/** Nullable query projection for exact portable Form descriptor lineage. */
export function interfaceFormLineage(record: Interface):
  | {
      readonly formRefKey: string;
      readonly formSchemaDigest: string;
      readonly descriptorName: string;
      readonly descriptorVersion: string;
    }
  | undefined {
  const source = record.metadata.materializedFrom;
  return source?.source === "form_descriptor"
    ? {
        formRefKey: source.formRefKey,
        formSchemaDigest: source.formSchemaDigest,
        descriptorName: source.descriptorName,
        descriptorVersion: source.descriptorVersion,
      }
    : undefined;
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
  /**
   * Atomically reserves one canonical OAuth resource for this exact current
   * Interface generation/revision. Durable implementations enforce uniqueness
   * for `(Workspace, ownerRef, resource)` in the database.
   */
  claimOAuth2Resource(input: {
    readonly record: Interface;
    readonly resource: string;
  }): Promise<boolean>;
  findOAuth2ResourceClaim(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly resource: string;
  }): Promise<string | undefined>;
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
  readonly #oauthResourceClaims = new Map<string, string>();
  readonly #oauthResourceClaimKeys = new Map<string, string>();

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
    const claimedKey = this.#oauthResourceClaimKeys.get(record.metadata.id);
    if (claimedKey) {
      const nextResource = interfaceOAuth2ResourceUri(record);
      const nextKey = nextResource
        ? oauthResourceClaimKey({
            workspaceId: record.metadata.workspaceId,
            ownerKind: record.metadata.ownerRef.kind,
            ownerId: record.metadata.ownerRef.id,
            resource: nextResource,
          })
        : undefined;
      if (claimedKey !== nextKey) {
        this.#oauthResourceClaims.delete(claimedKey);
        this.#oauthResourceClaimKeys.delete(record.metadata.id);
      }
    }
    return Promise.resolve(true);
  }

  claimOAuth2Resource(input: {
    readonly record: Interface;
    readonly resource: string;
  }): Promise<boolean> {
    const current = this.#records.get(input.record.metadata.id);
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(input.record) ||
      interfaceOAuth2ResourceUri(current) !== input.resource
    ) {
      return Promise.resolve(false);
    }
    const key = oauthResourceClaimKey({
      workspaceId: current.metadata.workspaceId,
      ownerKind: current.metadata.ownerRef.kind,
      ownerId: current.metadata.ownerRef.id,
      resource: input.resource,
    });
    const owner = this.#oauthResourceClaims.get(key);
    if (owner && owner !== current.metadata.id) return Promise.resolve(false);
    const prior = this.#oauthResourceClaimKeys.get(current.metadata.id);
    if (prior && prior !== key) this.#oauthResourceClaims.delete(prior);
    this.#oauthResourceClaims.set(key, current.metadata.id);
    this.#oauthResourceClaimKeys.set(current.metadata.id, key);
    return Promise.resolve(true);
  }

  findOAuth2ResourceClaim(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly resource: string;
  }): Promise<string | undefined> {
    return Promise.resolve(
      this.#oauthResourceClaims.get(oauthResourceClaimKey(input)),
    );
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

function oauthResourceClaimKey(input: {
  readonly workspaceId: string;
  readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
  readonly ownerId: string;
  readonly resource: string;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.ownerKind,
    input.ownerId,
    input.resource,
  ]);
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
