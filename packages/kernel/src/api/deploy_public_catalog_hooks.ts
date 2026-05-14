import type { JsonObject } from "takosumi-contract";
import {
  appendOperationPlanJournalStages,
  type OperationJournalPhase,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import type { OperationPlanPreview } from "../domains/deploy/apply_v2.ts";
import type {
  RevokeDebtRecord,
  RevokeDebtStore,
} from "../domains/deploy/revoke_debt_store.ts";
import type { CatalogReleaseVerificationResult } from "../domains/registry/mod.ts";
import type {
  CatalogReleaseExecutableHookPackageResult,
  CatalogReleaseExecutableHookRunResult,
  ExecutableCatalogHookInvocation,
} from "../plugins/executable_hooks.ts";
import { apiError } from "./errors.ts";
import { isJsonObject } from "./deploy_public_request_helpers.ts";
import type {
  CatalogReleaseWalHookVerifier,
  DeployPublicHandledResponse,
} from "./deploy_public_types.ts";

export type CatalogReleaseWalHookStage = "pre-commit" | "post-commit";

export type CatalogReleaseWalHookResult =
  | {
    readonly ok: true;
    readonly status: "skipped";
    readonly stage: CatalogReleaseWalHookStage;
  }
  | {
    readonly ok: true;
    readonly status: "succeeded";
    readonly stage: CatalogReleaseWalHookStage;
    readonly descriptorDigest?: string;
    readonly publisherId?: string;
    readonly publisherKeyId?: string;
    readonly executableHook?: CatalogReleaseExecutableHookRunResult;
  }
  | {
    readonly ok: false;
    readonly status: "failed";
    readonly stage: CatalogReleaseWalHookStage;
    readonly reason: string;
    readonly message: string;
    readonly descriptorDigest?: string;
    readonly publisherKeyId?: string;
    readonly executableHook?: CatalogReleaseExecutableHookRunResult & {
      readonly ok: false;
    };
  };

export async function invokeCatalogReleaseWalHook(input: {
  readonly verifier?: CatalogReleaseWalHookVerifier;
  readonly spaceId: string;
  readonly stage: CatalogReleaseWalHookStage;
  readonly preview: OperationPlanPreview;
}): Promise<CatalogReleaseWalHookResult> {
  if (!input.verifier) {
    return { ok: true, status: "skipped", stage: input.stage };
  }
  const verification = await input.verifier.verifyCurrentReleaseForSpace(
    input.spaceId,
  );
  if (!verification) {
    return { ok: true, status: "skipped", stage: input.stage };
  }
  if (!verification.ok) {
    return {
      ok: false,
      status: "failed",
      stage: input.stage,
      reason: verification.reason,
      message: verification.message,
      ...(verification.descriptorDigest
        ? { descriptorDigest: verification.descriptorDigest }
        : {}),
      ...(verification.publisherKeyId
        ? { publisherKeyId: verification.publisherKeyId }
        : {}),
    };
  }
  const executableHook = await input.verifier.runExecutableHooks?.(
    executableHookInvocation({
      spaceId: input.spaceId,
      stage: input.stage,
      preview: input.preview,
      verification: verification.ok ? verification : undefined,
    }),
  );
  if (executableHook && !executableHook.ok) {
    return {
      ok: false,
      status: "failed",
      stage: input.stage,
      reason: executableHook.reason,
      message: executableHook.message,
      ...(verification.ok
        ? {
          descriptorDigest: verification.descriptorDigest,
          publisherKeyId: verification.publisherKeyId,
        }
        : {}),
      executableHook,
    };
  }
  return {
    ok: true,
    status: "succeeded",
    stage: input.stage,
    descriptorDigest: verification.descriptorDigest,
    publisherId: verification.publisherId,
    publisherKeyId: verification.publisherKeyId,
    ...(executableHook ? { executableHook } : {}),
  };
}

export async function handleCatalogReleasePreCommitFailure(input: {
  readonly journalStore: OperationJournalStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly createdAt: string;
  readonly hook: CatalogReleaseWalHookResult & { readonly ok: false };
}): Promise<DeployPublicHandledResponse> {
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["abort"],
    status: "failed",
    createdAt: input.createdAt,
    detail: {
      reason: "catalog-release-pre-commit-hook-failed",
      catalogReleaseHook: catalogReleaseWalHookDetailRequired(input.hook),
    },
  });
  return {
    status: 409,
    body: apiError(
      "failed_precondition",
      `CatalogRelease pre-commit hook failed: ${input.hook.message}`,
    ),
  };
}

export async function handleCatalogReleasePostCommitFailure(input: {
  readonly journalStore: OperationJournalStore;
  readonly revokeDebtStore: RevokeDebtStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly createdAt: string;
  readonly hook: CatalogReleaseWalHookResult & { readonly ok: false };
}): Promise<DeployPublicHandledResponse> {
  const debts = await enqueueCatalogReleaseHookFailureDebts({
    revokeDebtStore: input.revokeDebtStore,
    preview: input.preview,
    phase: input.phase,
    tenantId: input.tenantId,
    deploymentName: input.deploymentName,
    createdAt: input.createdAt,
    hook: input.hook,
  });
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["post-commit"],
    status: "failed",
    createdAt: input.createdAt,
    detail: {
      reason: "catalog-release-post-commit-hook-failed",
      catalogReleaseHook: catalogReleaseWalHookDetailRequired(input.hook),
      revokeDebtIds: debts.map((debt) => debt.id),
    },
  });
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["observe", "finalize"],
    status: "succeeded",
    createdAt: input.createdAt,
    detail: {
      reason: "catalog-release-post-commit-hook-failed-observed",
      revokeDebtIds: debts.map((debt) => debt.id),
    },
  });
  return {
    status: 409,
    body: apiError(
      "failed_precondition",
      `CatalogRelease post-commit hook failed after provider commit; ` +
        `RevokeDebt enqueued: ${input.hook.message}`,
    ),
  };
}

async function enqueueCatalogReleaseHookFailureDebts(input: {
  readonly revokeDebtStore: RevokeDebtStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly createdAt: string;
  readonly hook: CatalogReleaseWalHookResult & { readonly ok: false };
}): Promise<readonly RevokeDebtRecord[]> {
  const debts: RevokeDebtRecord[] = [];
  for (const operation of input.preview.operations) {
    debts.push(
      await input.revokeDebtStore.enqueue({
        generatedObjectId: generatedObjectIdForPublicOperation({
          deploymentName: input.deploymentName,
          resourceName: operation.resourceName,
        }),
        reason: "approval-invalidated",
        ownerSpaceId: input.tenantId,
        deploymentName: input.deploymentName,
        operationPlanDigest: input.preview.operationPlanDigest,
        journalEntryId: operation.idempotencyKey.journalEntryId,
        operationId: operation.operationId,
        resourceName: operation.resourceName,
        providerId: operation.providerId,
        now: input.createdAt,
        detail: {
          kind: "takosumi.catalog-release-hook-failure@v1",
          phase: input.phase,
          hookStage: input.hook.stage,
          failureReason: input.hook.reason,
          desiredSnapshotDigest: input.preview.desiredSnapshotDigest,
          desiredDigest: operation.desiredDigest,
          idempotencyKey: {
            spaceId: operation.idempotencyKey.spaceId,
            operationPlanDigest: operation.idempotencyKey.operationPlanDigest,
            journalEntryId: operation.idempotencyKey.journalEntryId,
          },
        },
      }),
    );
  }
  return debts;
}

export function catalogReleaseWalHookDetail(
  hook: CatalogReleaseWalHookResult,
): JsonObject | undefined {
  if (hook.status === "skipped") return undefined;
  if (!hook.ok) {
    return {
      kind: "takosumi.catalog-release-wal-hook@v1",
      stage: hook.stage,
      status: hook.status,
      reason: hook.reason,
      ...(hook.descriptorDigest
        ? { descriptorDigest: hook.descriptorDigest }
        : {}),
      ...(hook.publisherKeyId ? { publisherKeyId: hook.publisherKeyId } : {}),
      ...(hook.executableHook
        ? { executableHook: executableHookDetail(hook.executableHook) }
        : {}),
    };
  }
  return {
    kind: "takosumi.catalog-release-wal-hook@v1",
    stage: hook.stage,
    status: hook.status,
    ...(hook.descriptorDigest
      ? { descriptorDigest: hook.descriptorDigest }
      : {}),
    ...(hook.publisherId ? { publisherId: hook.publisherId } : {}),
    ...(hook.publisherKeyId ? { publisherKeyId: hook.publisherKeyId } : {}),
    ...(hook.executableHook
      ? { executableHook: executableHookDetail(hook.executableHook) }
      : {}),
  };
}

function executableHookInvocation(input: {
  readonly spaceId: string;
  readonly stage: CatalogReleaseWalHookStage;
  readonly preview: OperationPlanPreview;
  readonly verification?: CatalogReleaseVerificationResult & {
    readonly ok: true;
  };
}): ExecutableCatalogHookInvocation {
  return {
    spaceId: input.spaceId,
    stage: input.stage,
    operationPlanDigest: input.preview.operationPlanDigest,
    desiredSnapshotDigest: input.preview.desiredSnapshotDigest,
    operations: input.preview.operations.map((operation) => ({
      operationId: operation.operationId,
      resourceName: operation.resourceName,
      providerId: operation.providerId,
      operationKind: operation.op === "create"
        ? "materialize-create"
        : "materialize-delete",
      desiredDigest: operation.desiredDigest,
      journalEntryId: operation.idempotencyKey.journalEntryId,
      idempotencyKey: operation.idempotencyKey,
    })),
    ...(input.verification
      ? {
        catalogRelease: {
          descriptorDigest: input.verification.descriptorDigest,
          publisherId: input.verification.publisherId,
          publisherKeyId: input.verification.publisherKeyId,
        },
      }
      : {}),
  };
}

function executableHookDetail(
  hook: CatalogReleaseExecutableHookRunResult,
): JsonObject {
  if (hook.status === "skipped") {
    return {
      kind: "takosumi.catalog-release-executable-hook@v1",
      stage: hook.stage,
      status: hook.status,
    };
  }
  if (!hook.ok) {
    return {
      kind: "takosumi.catalog-release-executable-hook@v1",
      stage: hook.stage,
      status: hook.status,
      packageId: hook.packageId,
      packageVersion: hook.packageVersion,
      reason: hook.reason,
      packages: executableHookPackageDetails(hook.packages),
      ...(hook.metadata ? { metadata: hook.metadata } : {}),
    };
  }
  return {
    kind: "takosumi.catalog-release-executable-hook@v1",
    stage: hook.stage,
    status: hook.status,
    packages: executableHookPackageDetails(hook.packages),
  };
}

function executableHookPackageDetails(
  packages: readonly CatalogReleaseExecutableHookPackageResult[],
): JsonObject[] {
  return packages.map((item) => {
    const detail: JsonObject = {
      packageId: item.packageId,
      packageVersion: item.packageVersion,
      status: item.status,
    };
    if (item.message) detail.message = item.message;
    if (item.reason) detail.reason = item.reason;
    if (isJsonObject(item.metadata)) detail.metadata = item.metadata;
    return detail;
  });
}

function catalogReleaseWalHookDetailRequired(
  hook: CatalogReleaseWalHookResult,
): JsonObject {
  const detail = catalogReleaseWalHookDetail(hook);
  if (!detail) {
    throw new Error("CatalogRelease WAL hook detail is required");
  }
  return detail;
}

export function catalogReleaseHookDetailField(
  hook: CatalogReleaseWalHookResult,
): JsonObject {
  const detail = catalogReleaseWalHookDetail(hook);
  return detail ? { catalogReleaseHook: detail } : {};
}

export function generatedObjectIdForPublicOperation(input: {
  readonly deploymentName: string;
  readonly resourceName: string;
}): string {
  return `generated:takosumi-public-deploy/${
    encodeURIComponent(input.deploymentName)
  }/${encodeURIComponent(input.resourceName)}`;
}
