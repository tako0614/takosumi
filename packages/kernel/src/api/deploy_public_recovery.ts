import type { ManifestResource } from "takosumi-contract";
import type {
  ApplyV2Outcome,
  OperationPlanPreview,
  PlannedResource,
} from "../domains/deploy/apply_v2.ts";
import { buildOperationPlanPreview } from "../domains/deploy/operation_plan_preview.ts";
import { buildRefDag } from "../domains/deploy/ref_resolver_v2.ts";
import {
  appendOperationPlanJournalStages,
  type OperationJournalPhase,
  type OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import type {
  RevokeDebtRecord,
  RevokeDebtStore,
} from "../domains/deploy/revoke_debt_store.ts";
import { apiError } from "./errors.ts";
import { generatedObjectIdForPublicOperation } from "./deploy_public_catalog_hooks.ts";
import {
  isCompensableRecoveryStage,
  isContinuableRecoveryStage,
  summarizeLatestJournal,
  toJournalEntrySummary,
  toRevokeDebtRecordSummary,
} from "./deploy_public_summaries.ts";
import type {
  DeployPublicHandledResponse,
  DeployPublicRecoveryCompensateResponse,
  DeployPublicRecoveryInspectResponse,
  DeployPublicRecoveryMode,
} from "./deploy_public_types.ts";

export function withOperationPlanPreview(input: {
  readonly outcome: ApplyV2Outcome;
  readonly resources: readonly ManifestResource[];
  readonly tenantId: string;
  readonly deploymentName: string;
}): ApplyV2Outcome {
  if (input.outcome.status !== "succeeded") return input.outcome;

  const dag = buildRefDag(input.resources);
  if (dag.issues.length > 0) return input.outcome;
  const resourcesByName = new Map(
    input.resources.map((resource) => [resource.name, resource]),
  );
  const planned = input.outcome.planned ?? dag.order.flatMap((name) => {
    const resource = resourcesByName.get(name);
    return resource
      ? [{
        name: resource.name,
        shape: resource.shape,
        providerId: providerIdForIntentPreview(resource),
        op: "create" as const,
      }]
      : [];
  });

  return {
    ...input.outcome,
    planned,
    operationPlanPreview: buildOperationPlanPreview({
      resources: input.resources,
      planned,
      edges: dag.edges,
      spaceId: input.tenantId,
      deploymentName: input.deploymentName,
    }),
  };
}

export async function handleRecoveryPreflight(input: {
  readonly store: OperationJournalStore;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly requestedPhase: OperationJournalPhase;
  readonly operationPlanDigest: `sha256:${string}`;
  readonly recoveryMode?: DeployPublicRecoveryMode;
}): Promise<DeployPublicHandledResponse | undefined> {
  const entries = await input.store.listByDeployment(
    input.tenantId,
    input.deploymentName,
  );
  const journal = summarizeLatestJournal(entries);
  if (input.recoveryMode === "inspect") {
    const ok: DeployPublicRecoveryInspectResponse = {
      status: "ok",
      outcome: {
        status: "recovery-inspect",
        tenantId: input.tenantId,
        deploymentName: input.deploymentName,
        ...(journal ? { journal } : {}),
        entries: entries.map(toJournalEntrySummary),
      },
    };
    return { status: 200, body: ok };
  }
  if (input.recoveryMode === "continue") {
    if (!journal || journal.terminal) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `deployment ${input.deploymentName} has no unfinished public WAL ` +
            `to continue`,
        ),
      };
    }
    if (journal.status === "failed") {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `deployment ${input.deploymentName} has failed public WAL ` +
            `phase=${journal.phase} stage=${journal.latestStage}; inspect ` +
            `before choosing compensate or a new apply/destroy`,
        ),
      };
    }
    if (journal.phase !== input.requestedPhase) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode continue refused: unfinished public WAL phase=` +
            `${journal.phase} does not match requested phase=` +
            `${input.requestedPhase}`,
        ),
      };
    }
    if (journal.operationPlanDigest !== input.operationPlanDigest) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode continue refused: request operationPlanDigest=` +
            `${input.operationPlanDigest} does not match unfinished public ` +
            `WAL operationPlanDigest=${journal.operationPlanDigest}`,
        ),
      };
    }
    if (!isContinuableRecoveryStage(journal.latestStage)) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode continue refused: public WAL stage=` +
            `${journal.latestStage} is not continuable`,
        ),
      };
    }
    return undefined;
  }
  if (input.recoveryMode === "compensate") {
    if (!journal || journal.terminal) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `deployment ${input.deploymentName} has no unfinished public WAL ` +
            `to compensate`,
        ),
      };
    }
    if (journal.phase !== input.requestedPhase) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode compensate refused: unfinished public WAL phase=` +
            `${journal.phase} does not match requested phase=` +
            `${input.requestedPhase}`,
        ),
      };
    }
    if (journal.operationPlanDigest !== input.operationPlanDigest) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode compensate refused: request operationPlanDigest=` +
            `${input.operationPlanDigest} does not match unfinished public ` +
            `WAL operationPlanDigest=${journal.operationPlanDigest}`,
        ),
      };
    }
    if (!isCompensableRecoveryStage(journal.latestStage)) {
      return {
        status: 409,
        body: apiError(
          "failed_precondition",
          `recoveryMode compensate refused: public WAL stage=` +
            `${journal.latestStage} has no committed effect to compensate`,
        ),
      };
    }
    return undefined;
  }
  if (journal && !journal.terminal) {
    return {
      status: 409,
      body: apiError(
        "failed_precondition",
        `deployment ${input.deploymentName} has unfinished public WAL ` +
          `phase=${journal.phase} stage=${journal.latestStage} ` +
          `status=${journal.status}; retry with recoveryMode: "inspect" ` +
          `or continue the same OperationPlan with recoveryMode: ` +
          `"continue", or compensate committed effects with recoveryMode: ` +
          `"compensate" before starting another apply/destroy`,
      ),
    };
  }
  return undefined;
}

export async function handleRecoveryCompensate(input: {
  readonly journalStore: OperationJournalStore;
  readonly revokeDebtStore: RevokeDebtStore;
  readonly preview: OperationPlanPreview;
  readonly phase: OperationJournalPhase;
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly createdAt: string;
}): Promise<DeployPublicHandledResponse> {
  const debts: RevokeDebtRecord[] = [];
  for (const operation of input.preview.operations) {
    debts.push(
      await input.revokeDebtStore.enqueue({
        generatedObjectId: generatedObjectIdForPublicOperation({
          deploymentName: input.deploymentName,
          resourceName: operation.resourceName,
        }),
        reason: "activation-rollback",
        ownerSpaceId: input.tenantId,
        deploymentName: input.deploymentName,
        operationPlanDigest: input.preview.operationPlanDigest,
        journalEntryId: operation.idempotencyKey.journalEntryId,
        operationId: operation.operationId,
        resourceName: operation.resourceName,
        providerId: operation.providerId,
        now: input.createdAt,
        detail: {
          kind: "takosumi.public-recovery-compensate@v1",
          phase: input.phase,
          operationKind: operation.op,
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
  await appendOperationPlanJournalStages({
    store: input.journalStore,
    preview: input.preview,
    phase: input.phase,
    stages: ["abort"],
    status: "failed",
    createdAt: input.createdAt,
    detail: {
      reason: "compensate-revoke-debt-enqueued",
      revokeDebtIds: debts.map((debt) => debt.id),
    },
  });
  const entries = await input.journalStore.listByDeployment(
    input.tenantId,
    input.deploymentName,
  );
  const journal = summarizeLatestJournal(entries);
  const ok: DeployPublicRecoveryCompensateResponse = {
    status: "ok",
    outcome: {
      status: "recovery-compensate",
      tenantId: input.tenantId,
      deploymentName: input.deploymentName,
      ...(journal ? { journal } : {}),
      debts: debts.map(toRevokeDebtRecordSummary),
    },
  };
  return { status: 200, body: ok };
}

export function buildPublicOperationPlanPreview(input: {
  readonly resources: readonly ManifestResource[];
  readonly tenantId: string;
  readonly deploymentName: string;
  readonly op: PlannedResource["op"];
}): OperationPlanPreview {
  const dag = buildRefDag(input.resources);
  if (dag.issues.length > 0) {
    // The caller has already accepted `resolveManifestResourcesV1`; ref-DAG
    // validation errors will be surfaced by applyV2/destroyV2. Build a stable
    // fallback order so the journal still records the rejected intent.
    const planned = input.resources.map((resource) => ({
      name: resource.name,
      shape: resource.shape,
      providerId: providerIdForIntentPreview(resource),
      op: input.op,
    }));
    return buildOperationPlanPreview({
      resources: input.resources,
      planned,
      edges: [],
      spaceId: input.tenantId,
      deploymentName: input.deploymentName,
    });
  }
  const resourcesByName = new Map(
    input.resources.map((resource) => [resource.name, resource]),
  );
  const orderedNames = input.op === "delete"
    ? [...dag.order].reverse()
    : dag.order;
  const planned: PlannedResource[] = orderedNames.flatMap((name) => {
    const resource = resourcesByName.get(name);
    return resource
      ? [{
        name: resource.name,
        shape: resource.shape,
        providerId: providerIdForIntentPreview(resource),
        op: input.op,
      }]
      : [];
  });
  return buildOperationPlanPreview({
    resources: input.resources,
    planned,
    edges: dag.edges,
    spaceId: input.tenantId,
    deploymentName: input.deploymentName,
  });
}

export function providerIdForIntentPreview(resource: ManifestResource): string {
  return resource.provider ?? "(auto)";
}
