import type { Digest, JsonObject } from "takosumi-contract";

export type CatalogReleaseHookStage = "pre-commit" | "post-commit";

export interface ExecutableCatalogHookOperation {
  readonly operationId: string;
  readonly resourceName: string;
  readonly providerId: string;
  readonly operationKind: string;
  readonly desiredDigest: Digest;
  readonly journalEntryId: string;
  readonly idempotencyKey: {
    readonly spaceId: string;
    readonly operationPlanDigest: Digest;
    readonly journalEntryId: string;
  };
}

export interface ExecutableCatalogHookInvocation {
  readonly spaceId: string;
  readonly stage: CatalogReleaseHookStage;
  readonly operationPlanDigest: Digest;
  readonly desiredSnapshotDigest: Digest;
  readonly operations: readonly ExecutableCatalogHookOperation[];
  readonly catalogRelease?: {
    readonly descriptorDigest: Digest;
    readonly publisherId: string;
    readonly publisherKeyId: string;
  };
}

export type ExecutableCatalogHookResult =
  | {
    readonly ok: true;
    readonly message?: string;
    readonly metadata?: JsonObject;
  }
  | {
    readonly ok: false;
    readonly reason: string;
    readonly message: string;
    readonly metadata?: JsonObject;
  };

export interface ExecutableCatalogHookPackage {
  readonly id: string;
  readonly version: string;
  readonly stages: readonly CatalogReleaseHookStage[];
  run(input: ExecutableCatalogHookInvocation): Promise<
    ExecutableCatalogHookResult
  >;
}

export type CatalogReleaseExecutableHookRunResult =
  | {
    readonly ok: true;
    readonly status: "skipped";
    readonly stage: CatalogReleaseHookStage;
  }
  | {
    readonly ok: true;
    readonly status: "succeeded";
    readonly stage: CatalogReleaseHookStage;
    readonly packages: readonly CatalogReleaseExecutableHookPackageResult[];
  }
  | {
    readonly ok: false;
    readonly status: "failed";
    readonly stage: CatalogReleaseHookStage;
    readonly packageId: string;
    readonly packageVersion: string;
    readonly reason: string;
    readonly message: string;
    readonly metadata?: JsonObject;
    readonly packages: readonly CatalogReleaseExecutableHookPackageResult[];
  };

export interface CatalogReleaseExecutableHookPackageResult {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly status: "succeeded" | "failed";
  readonly message?: string;
  readonly reason?: string;
  readonly metadata?: JsonObject;
}

export interface CatalogReleaseExecutableHookRunner {
  runExecutableHooks(
    input: ExecutableCatalogHookInvocation,
  ): Promise<CatalogReleaseExecutableHookRunResult | undefined>;
}

export function createExecutableCatalogHookRunner(
  packages: readonly ExecutableCatalogHookPackage[],
): CatalogReleaseExecutableHookRunner {
  const frozenPackages = Object.freeze([...packages]);
  return {
    async runExecutableHooks(input) {
      return await runExecutableCatalogHooks({
        packages: frozenPackages,
        invocation: input,
      });
    },
  };
}

export async function runExecutableCatalogHooks(input: {
  readonly packages: readonly ExecutableCatalogHookPackage[];
  readonly invocation: ExecutableCatalogHookInvocation;
}): Promise<CatalogReleaseExecutableHookRunResult> {
  const selected = input.packages.filter((hookPackage) =>
    hookPackage.stages.includes(input.invocation.stage)
  );
  if (selected.length === 0) {
    return {
      ok: true,
      status: "skipped",
      stage: input.invocation.stage,
    };
  }

  const packageResults: CatalogReleaseExecutableHookPackageResult[] = [];
  for (const hookPackage of selected) {
    const result = await hookPackage.run(input.invocation);
    if (!result.ok) {
      const failed: CatalogReleaseExecutableHookPackageResult = {
        packageId: hookPackage.id,
        packageVersion: hookPackage.version,
        status: "failed",
        reason: result.reason,
        message: result.message,
        ...(result.metadata ? { metadata: result.metadata } : {}),
      };
      packageResults.push(failed);
      return {
        ok: false,
        status: "failed",
        stage: input.invocation.stage,
        packageId: hookPackage.id,
        packageVersion: hookPackage.version,
        reason: result.reason,
        message: result.message,
        ...(result.metadata ? { metadata: result.metadata } : {}),
        packages: Object.freeze([...packageResults]),
      };
    }
    packageResults.push({
      packageId: hookPackage.id,
      packageVersion: hookPackage.version,
      status: "succeeded",
      ...(result.message ? { message: result.message } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
    });
  }

  return {
    ok: true,
    status: "succeeded",
    stage: input.invocation.stage,
    packages: Object.freeze(packageResults),
  };
}

export function executableCatalogHookPackageFromModule(
  module: unknown,
  specifier: string,
): ExecutableCatalogHookPackage | undefined {
  if (!isRecord(module)) return undefined;
  const explicit = module.catalogHookPackage ?? module.hookPackage;
  if (explicit !== undefined) {
    if (isExecutableCatalogHookPackage(explicit)) return explicit;
    throw new Error(
      `catalog hook package module exported no hook package: ${specifier}`,
    );
  }
  return isExecutableCatalogHookPackage(module.default)
    ? module.default
    : undefined;
}

function isExecutableCatalogHookPackage(
  value: unknown,
): value is ExecutableCatalogHookPackage {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    typeof value.version === "string" &&
    Array.isArray(value.stages) &&
    value.stages.every((stage) =>
      stage === "pre-commit" || stage === "post-commit"
    ) &&
    typeof value.run === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
