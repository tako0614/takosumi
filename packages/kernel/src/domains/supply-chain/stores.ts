import { conflict } from "../../shared/errors.ts";
import type {
  PreparedArtifact,
  PreparedArtifactId,
  ProtectedReference,
  ProtectedReferenceId,
  SupplyChainRecord,
  SupplyChainRecordId,
} from "./types.ts";

export interface SupplyChainRecordStore {
  put(record: SupplyChainRecord): Promise<SupplyChainRecord>;
  get(id: SupplyChainRecordId): Promise<SupplyChainRecord | undefined>;
  list(): Promise<readonly SupplyChainRecord[]>;
}

export interface PreparedArtifactStore {
  put(artifact: PreparedArtifact): Promise<PreparedArtifact>;
  get(id: PreparedArtifactId): Promise<PreparedArtifact | undefined>;
  findByDigest(digest: string): Promise<PreparedArtifact | undefined>;
  list(): Promise<readonly PreparedArtifact[]>;
  deleteIfUnprotected(
    id: PreparedArtifactId,
    references: ProtectedReferenceStore,
    now: string,
  ): Promise<boolean>;
}

export interface ProtectedReferenceStore {
  put(reference: ProtectedReference): Promise<ProtectedReference>;
  get(id: ProtectedReferenceId): Promise<ProtectedReference | undefined>;
  listForRef(
    refType: string,
    refId: string,
  ): Promise<readonly ProtectedReference[]>;
  hasActiveReference(
    refType: string,
    refId: string,
    now: string,
  ): Promise<boolean>;
}

export class InMemorySupplyChainRecordStore implements SupplyChainRecordStore {
  readonly #records = new Map<SupplyChainRecordId, SupplyChainRecord>();

  put(record: SupplyChainRecord): Promise<SupplyChainRecord> {
    const existing = this.#records.get(record.id);
    if (existing) return Promise.resolve(existing);
    const frozen = deepFreeze(structuredClone(record));
    this.#records.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: SupplyChainRecordId): Promise<SupplyChainRecord | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  list(): Promise<readonly SupplyChainRecord[]> {
    return Promise.resolve([...this.#records.values()]);
  }
}

export class InMemoryPreparedArtifactStore implements PreparedArtifactStore {
  readonly #artifacts = new Map<PreparedArtifactId, PreparedArtifact>();

  put(artifact: PreparedArtifact): Promise<PreparedArtifact> {
    const existing = this.#artifacts.get(artifact.id);
    if (existing) return Promise.resolve(existing);
    const byDigest = [...this.#artifacts.values()].find((candidate) =>
      candidate.digest === artifact.digest
    );
    if (byDigest && byDigest.id !== artifact.id) {
      throw conflict("PreparedArtifact digest already exists", {
        artifactId: byDigest.id,
        digest: artifact.digest,
      });
    }
    const frozen = deepFreeze(structuredClone(artifact));
    this.#artifacts.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: PreparedArtifactId): Promise<PreparedArtifact | undefined> {
    return Promise.resolve(this.#artifacts.get(id));
  }

  findByDigest(digest: string): Promise<PreparedArtifact | undefined> {
    return Promise.resolve(
      [...this.#artifacts.values()].find((artifact) =>
        artifact.digest === digest
      ),
    );
  }

  list(): Promise<readonly PreparedArtifact[]> {
    return Promise.resolve([...this.#artifacts.values()]);
  }

  async deleteIfUnprotected(
    id: PreparedArtifactId,
    references: ProtectedReferenceStore,
    now: string,
  ): Promise<boolean> {
    const artifact = this.#artifacts.get(id);
    if (!artifact) return false;
    if (await references.hasActiveReference("PreparedArtifact", id, now)) {
      return false;
    }
    return this.#artifacts.delete(id);
  }
}

export class InMemoryProtectedReferenceStore
  implements ProtectedReferenceStore {
  readonly #references = new Map<ProtectedReferenceId, ProtectedReference>();

  put(reference: ProtectedReference): Promise<ProtectedReference> {
    const existing = this.#references.get(reference.id);
    if (existing) return Promise.resolve(existing);
    const frozen = deepFreeze(structuredClone(reference));
    this.#references.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: ProtectedReferenceId): Promise<ProtectedReference | undefined> {
    return Promise.resolve(this.#references.get(id));
  }

  listForRef(
    refType: string,
    refId: string,
  ): Promise<readonly ProtectedReference[]> {
    return Promise.resolve(
      [...this.#references.values()].filter((reference) =>
        reference.refType === refType && reference.refId === refId
      ),
    );
  }

  async hasActiveReference(
    refType: string,
    refId: string,
    now: string,
  ): Promise<boolean> {
    const references = await this.listForRef(refType, refId);
    return references.some((reference) =>
      reference.expiresAt === undefined || reference.expiresAt > now
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
