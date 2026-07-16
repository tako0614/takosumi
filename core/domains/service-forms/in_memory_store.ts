import {
  formRefKey,
  pageSortedBy,
  type FormPackageLifecycleStatus,
  type FormRef,
  type Page,
  type PageParams,
} from "takosumi-contract";
import type {
  FormActivationRecord,
  FormDefinitionRecord,
  FormPackageRecord,
} from "./records.ts";
import type {
  CreateFormActivationResult,
  FormRegistryStore,
  InstallFormPackageResult,
  UpdateFormPackageStatusResult,
  UpdateFormActivationResult,
} from "./stores.ts";

export class InMemoryFormRegistryStore implements FormRegistryStore {
  readonly #packages = new Map<string, FormPackageRecord>();
  readonly #definitions = new Map<string, FormDefinitionRecord>();
  readonly #activations = new Map<string, FormActivationRecord>();

  async installPackage(
    packageRecord: FormPackageRecord,
    definitions: readonly FormDefinitionRecord[],
  ): Promise<InstallFormPackageResult> {
    const existingPackage = this.#packages.get(packageRecord.packageDigest);
    if (existingPackage !== undefined) {
      return packageEquivalent(existingPackage, packageRecord) &&
        definitionsEquivalent(existingPackage, definitions, this.#definitions)
        ? { status: "already_installed", package: clone(existingPackage) }
        : { status: "conflict", reason: "package_digest_conflict" };
    }

    for (const definition of definitions) {
      const existingDefinition = this.#definitions.get(
        formRefKey(definition.identity.formRef),
      );
      if (
        existingDefinition !== undefined &&
        existingDefinition.identity.packageDigest !==
          packageRecord.packageDigest
      ) {
        return { status: "conflict", reason: "form_ref_conflict" };
      }
    }

    this.#packages.set(packageRecord.packageDigest, clone(packageRecord));
    for (const definition of definitions) {
      this.#definitions.set(
        formRefKey(definition.identity.formRef),
        clone(definition),
      );
    }
    return { status: "installed", package: clone(packageRecord) };
  }

  async getPackage(
    packageDigest: string,
  ): Promise<FormPackageRecord | undefined> {
    return cloneOptional(this.#packages.get(packageDigest));
  }

  async listPackages(params: PageParams): Promise<Page<FormPackageRecord>> {
    return clonePage(
      pageSortedBy(
        [...this.#packages.values()].sort(compareUpdatedId),
        params,
        (record) => ({ createdAt: record.updatedAt, id: record.packageDigest }),
      ),
    );
  }

  async updatePackageStatus(
    packageDigest: string,
    status: FormPackageLifecycleStatus,
    updatedAt: string,
  ): Promise<UpdateFormPackageStatusResult> {
    const current = this.#packages.get(packageDigest);
    if (current === undefined) return { status: "not_found" };
    if (current.status === "revoked" && status !== "revoked") {
      return { status: "invalid_transition", package: clone(current) };
    }
    const next: FormPackageRecord = {
      ...current,
      status,
      updatedAt,
      ...(status === "deprecated" ? { deprecatedAt: updatedAt } : {}),
      ...(status === "revoked" ? { revokedAt: updatedAt } : {}),
    };
    this.#packages.set(packageDigest, clone(next));
    return { status: "updated", package: clone(next) };
  }

  async getDefinition(ref: FormRef): Promise<FormDefinitionRecord | undefined> {
    return cloneOptional(this.#definitions.get(formRefKey(ref)));
  }

  async listDefinitions(
    params: PageParams,
  ): Promise<Page<FormDefinitionRecord>> {
    return clonePage(
      pageSortedBy(
        [...this.#definitions.values()].sort((left, right) => {
          const byTime = left.installedAt.localeCompare(right.installedAt);
          return byTime !== 0
            ? byTime
            : formRefKey(left.identity.formRef).localeCompare(
                formRefKey(right.identity.formRef),
              );
        }),
        params,
        (record) => ({
          createdAt: record.installedAt,
          id: formRefKey(record.identity.formRef),
        }),
      ),
    );
  }

  async createActivation(
    activation: FormActivationRecord,
  ): Promise<CreateFormActivationResult> {
    const existing = this.#activations.get(activation.id);
    if (existing !== undefined) {
      return { status: "conflict", activation: clone(existing) };
    }
    this.#activations.set(activation.id, clone(activation));
    return { status: "created", activation: clone(activation) };
  }

  async getActivation(id: string): Promise<FormActivationRecord | undefined> {
    return cloneOptional(this.#activations.get(id));
  }

  async listActivations(
    params: PageParams,
  ): Promise<Page<FormActivationRecord>> {
    return clonePage(
      pageSortedBy(
        [...this.#activations.values()].sort(compareUpdatedId),
        params,
        (record) => ({ createdAt: record.updatedAt, id: record.id }),
      ),
    );
  }

  async updateActivation(
    activation: FormActivationRecord,
    expectedRevision: number,
  ): Promise<UpdateFormActivationResult> {
    const current = this.#activations.get(activation.id);
    if (current === undefined) return { status: "not_found" };
    if (current.revision !== expectedRevision) {
      return { status: "conflict", activation: clone(current) };
    }
    this.#activations.set(activation.id, clone(activation));
    return { status: "updated", activation: clone(activation) };
  }
}

function compareUpdatedId(
  left: {
    readonly updatedAt: string;
    readonly id?: string;
    readonly packageDigest?: string;
  },
  right: {
    readonly updatedAt: string;
    readonly id?: string;
    readonly packageDigest?: string;
  },
): number {
  const byTime = left.updatedAt.localeCompare(right.updatedAt);
  return byTime !== 0
    ? byTime
    : (left.id ?? left.packageDigest ?? "").localeCompare(
        right.id ?? right.packageDigest ?? "",
      );
}

function packageEquivalent(
  left: FormPackageRecord,
  right: FormPackageRecord,
): boolean {
  return (
    left.artifactRef === right.artifactRef &&
    left.verifierId === right.verifierId &&
    JSON.stringify(left.definitionRefs) === JSON.stringify(right.definitionRefs)
  );
}

function definitionsEquivalent(
  existingPackage: FormPackageRecord,
  incoming: readonly FormDefinitionRecord[],
  existingDefinitions: ReadonlyMap<string, FormDefinitionRecord>,
): boolean {
  if (existingPackage.definitionRefs.length !== incoming.length) return false;
  const incomingByKey = new Map(
    incoming.map((definition) => [
      formRefKey(definition.identity.formRef),
      definition,
    ]),
  );
  if (incomingByKey.size !== incoming.length) return false;
  for (const ref of existingPackage.definitionRefs) {
    const key = formRefKey(ref);
    const left = existingDefinitions.get(key);
    const right = incomingByKey.get(key);
    if (
      left === undefined ||
      right === undefined ||
      left.identity.packageDigest !== right.identity.packageDigest ||
      left.displayName !== right.displayName ||
      left.description !== right.description ||
      canonicalJson(left.operations) !== canonicalJson(right.operations) ||
      canonicalJson(left.metadata ?? null) !==
        canonicalJson(right.metadata ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}

function clonePage<T>(page: Page<T>): Page<T> {
  return {
    items: page.items.map(clone),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}
