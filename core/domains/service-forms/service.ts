import {
  formRefKey,
  installedFormReferenceKey,
  isFormRef,
  isSha256Digest,
  type FormActivation,
  type FormPackageLifecycleStatus,
  type IsoTimestamp,
} from "takosumi-contract";
import type {
  CreateFormActivationRequest,
  FormPackageInstallRequest,
  UpdateFormActivationRequest,
} from "./records.ts";
import type {
  FormPackageArtifactReader,
  FormPackageVerifier,
  FormRegistryStore,
} from "./stores.ts";

export class FormRegistryError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "verification_failed"
      | "package_conflict"
      | "definition_not_installed"
      | "package_unavailable"
      | "activation_conflict"
      | "activation_not_found",
    message: string,
  ) {
    super(message);
    this.name = "FormRegistryError";
  }
}

export interface FormRegistryServiceOptions {
  readonly store: FormRegistryStore;
  readonly artifactReader: FormPackageArtifactReader;
  readonly verifier: FormPackageVerifier;
  readonly now?: () => IsoTimestamp;
}

export class FormRegistryService {
  readonly #store: FormRegistryStore;
  readonly #artifactReader: FormPackageArtifactReader;
  readonly #verifier: FormPackageVerifier;
  readonly #now: () => IsoTimestamp;

  constructor(options: FormRegistryServiceOptions) {
    this.#store = options.store;
    this.#artifactReader = options.artifactReader;
    this.#verifier = options.verifier;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async installPackage(request: FormPackageInstallRequest) {
    if (
      request.artifactRef.trim() === "" ||
      request.actorId.trim() === "" ||
      !isSha256Digest(request.expectedPackageDigest)
    ) {
      throw new FormRegistryError(
        "invalid_request",
        "artifactRef, actorId, and an exact sha256 package digest are required",
      );
    }

    const bytes = await this.#artifactReader.read(request.artifactRef);
    let verified;
    try {
      verified = await this.#verifier.verify(
        bytes,
        request.expectedPackageDigest,
      );
    } catch (error) {
      throw new FormRegistryError(
        "verification_failed",
        error instanceof Error ? error.message : "package verification failed",
      );
    }
    if (
      verified.packageDigest !== request.expectedPackageDigest ||
      verified.definitions.length === 0
    ) {
      throw new FormRegistryError(
        "verification_failed",
        "verifier returned a mismatched digest or an empty package",
      );
    }

    const seen = new Set<string>();
    for (const definition of verified.definitions) {
      if (!isFormRef(definition.formRef)) {
        throw new FormRegistryError(
          "verification_failed",
          "verifier returned an invalid or non-exact FormRef",
        );
      }
      const key = formRefKey(definition.formRef);
      if (seen.has(key)) {
        throw new FormRegistryError(
          "verification_failed",
          "package contains a duplicate exact FormRef",
        );
      }
      seen.add(key);
      if (
        definition.operations.length === 0 ||
        definition.operations.some(
          (operation) =>
            ![
              "create",
              "read",
              "update",
              "delete",
              "import",
              "refresh",
            ].includes(operation),
        ) ||
        new Set(definition.operations).size !== definition.operations.length
      ) {
        throw new FormRegistryError(
          "verification_failed",
          "definition operations must be a non-empty unique supported set",
        );
      }
    }

    const orderedDefinitions = [...verified.definitions].sort((left, right) =>
      formRefKey(left.formRef).localeCompare(formRefKey(right.formRef)),
    );
    const now = this.#now();
    const packageRecord = {
      packageDigest: request.expectedPackageDigest,
      artifactRef: request.artifactRef,
      verifierId: this.#verifier.id,
      status: "installed" as const,
      definitionRefs: orderedDefinitions.map((entry) => entry.formRef),
      installedAt: now,
      installedBy: request.actorId,
      updatedAt: now,
    };
    const definitions = orderedDefinitions.map((definition) => ({
      identity: {
        formRef: definition.formRef,
        packageDigest: request.expectedPackageDigest,
      },
      displayName: definition.displayName,
      description: definition.description,
      operations: definition.operations,
      metadata: definition.metadata,
      installedAt: now,
    }));
    const result = await this.#store.installPackage(packageRecord, definitions);
    if (result.status === "conflict") {
      throw new FormRegistryError("package_conflict", result.reason);
    }
    return result.package;
  }

  async setPackageStatus(
    packageDigest: string,
    status: Exclude<FormPackageLifecycleStatus, "installed">,
  ) {
    if (
      !isSha256Digest(packageDigest) ||
      (status !== "deprecated" && status !== "revoked")
    ) {
      throw new FormRegistryError("invalid_request", "invalid package digest");
    }
    const current = await this.#store.getPackage(packageDigest);
    if (current === undefined) return undefined;
    if (current.status === "revoked" && status !== "revoked") {
      throw new FormRegistryError(
        "package_unavailable",
        "a revoked package cannot return to a weaker lifecycle state",
      );
    }
    if (current.status === status) return current;
    const result = await this.#store.updatePackageStatus(
      packageDigest,
      status,
      this.#now(),
    );
    if (result.status === "not_found") return undefined;
    if (result.status === "invalid_transition") {
      throw new FormRegistryError(
        "package_unavailable",
        "a revoked package cannot return to a weaker lifecycle state",
      );
    }
    return result.package;
  }

  async createActivation(request: CreateFormActivationRequest) {
    validateActivationRequest(request);
    const definition = await this.#store.getDefinition(
      request.identity.formRef,
    );
    if (
      definition === undefined ||
      definition.identity.packageDigest !== request.identity.packageDigest
    ) {
      throw new FormRegistryError(
        "definition_not_installed",
        "the exact FormRef and packageDigest are not installed",
      );
    }
    const packageRecord = await this.#store.getPackage(
      request.identity.packageDigest,
    );
    if (packageRecord?.status !== "installed") {
      throw new FormRegistryError(
        "package_unavailable",
        "the exact package is not available for activation",
      );
    }

    const now = this.#now();
    const activation: FormActivation = {
      id: request.id,
      identity: request.identity,
      scope: request.scope,
      audience: request.audience ?? {},
      policy: request.policy ?? {},
      eligibleTargetPoolClasses: uniqueTokens(
        request.eligibleTargetPoolClasses ?? [],
      ),
      status: request.status ?? "inactive",
      revision: 1,
      createdAt: now,
      createdBy: request.actorId,
      updatedAt: now,
      updatedBy: request.actorId,
    };
    const result = await this.#store.createActivation(activation);
    if (result.status === "conflict") {
      throw new FormRegistryError(
        "activation_conflict",
        "activation id already exists",
      );
    }
    return result.activation;
  }

  async updateActivation(request: UpdateFormActivationRequest) {
    if (
      request.id.trim() === "" ||
      request.actorId.trim() === "" ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    ) {
      throw new FormRegistryError("invalid_request", "invalid activation CAS");
    }
    const current = await this.#store.getActivation(request.id);
    if (current === undefined) {
      throw new FormRegistryError(
        "activation_not_found",
        "activation was not found",
      );
    }
    validateAudience(request.audience ?? current.audience);
    if (
      request.status !== undefined &&
      request.status !== "active" &&
      request.status !== "inactive"
    ) {
      throw new FormRegistryError(
        "invalid_request",
        "invalid activation status",
      );
    }
    const next: FormActivation = {
      ...current,
      audience: request.audience ?? current.audience,
      policy: request.policy ?? current.policy,
      eligibleTargetPoolClasses:
        request.eligibleTargetPoolClasses === undefined
          ? current.eligibleTargetPoolClasses
          : uniqueTokens(request.eligibleTargetPoolClasses),
      status: request.status ?? current.status,
      revision: current.revision + 1,
      updatedAt: this.#now(),
      updatedBy: request.actorId,
    };
    if (next.status === "active") {
      const packageRecord = await this.#store.getPackage(
        next.identity.packageDigest,
      );
      if (packageRecord?.status !== "installed") {
        throw new FormRegistryError(
          "package_unavailable",
          "the exact package is not available for activation",
        );
      }
    }
    const result = await this.#store.updateActivation(
      next,
      request.expectedRevision,
    );
    if (result.status === "not_found") {
      throw new FormRegistryError(
        "activation_not_found",
        "activation was not found",
      );
    }
    if (result.status === "conflict") {
      throw new FormRegistryError(
        "activation_conflict",
        `activation revision is ${result.activation.revision}`,
      );
    }
    return result.activation;
  }
}

function validateActivationRequest(request: CreateFormActivationRequest): void {
  if (
    request.id.trim() === "" ||
    request.actorId.trim() === "" ||
    !isFormRef(request.identity.formRef) ||
    !isSha256Digest(request.identity.packageDigest)
  ) {
    throw new FormRegistryError(
      "invalid_request",
      "activation requires an id, actor, and exact installed identity",
    );
  }
  installedFormReferenceKey(request.identity);
  if (
    request.status !== undefined &&
    request.status !== "active" &&
    request.status !== "inactive"
  ) {
    throw new FormRegistryError("invalid_request", "invalid activation status");
  }
  validateAudience(request.audience ?? {});
  if (
    !(["operator", "workspace", "space"] as const).includes(request.scope.type)
  ) {
    throw new FormRegistryError("invalid_request", "invalid activation scope");
  }
  if (
    (request.scope.type === "workspace" || request.scope.type === "space") &&
    request.scope.id.trim() === ""
  ) {
    throw new FormRegistryError(
      "invalid_request",
      "activation scope id is empty",
    );
  }
}

function validateAudience(audience: FormActivation["audience"]): void {
  for (const value of [
    ...(audience.principalIds ?? []),
    ...(audience.roles ?? []),
  ]) {
    if (value.trim() === "" || value.length > 256) {
      throw new FormRegistryError(
        "invalid_request",
        "activation audience contains an invalid identifier",
      );
    }
  }
}

function uniqueTokens(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => value.trim());
  if (
    normalized.some(
      (value) =>
        value === "" || !/^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u.test(value),
    )
  ) {
    throw new FormRegistryError(
      "invalid_request",
      "target pool class contains an invalid token",
    );
  }
  return [...new Set(normalized)].sort();
}
