import type { JsonObject } from "takosumi-contract";
import type {
  OperationJournalEntry,
  OperationJournalStage,
  OperationJournalStatus,
  OperationJournalStore,
} from "../domains/deploy/operation_journal.ts";
import {
  type RevokeDebtRecord,
  type RevokeDebtStore,
  summarizeRevokeDebt,
} from "../domains/deploy/revoke_debt_store.ts";
import type {
  TakosumiAppliedResourceRecord,
  TakosumiDeploymentRecord,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import type {
  DeploymentAuditCauseSummary,
  DeploymentJournalEntrySummary,
  DeploymentJournalSummary,
  DeploymentResourceSummary,
  DeploymentRevokeDebtRecordSummary,
  DeploymentSummary,
  DeployPublicAuditResponse,
  DeployPublicProvenance,
} from "./deploy_public_types.ts";
import { isJsonObject } from "./deploy_public_request_helpers.ts";

export async function toDeploymentSummary(
  record: TakosumiDeploymentRecord,
  journalStore: OperationJournalStore,
  revokeDebtStore: RevokeDebtStore,
): Promise<DeploymentSummary> {
  const journalEntries = await journalStore.listByDeployment(
    record.tenantId,
    record.name,
  );
  const journal = summarizeLatestJournal(journalEntries);
  const provenance = latestJournalProvenance(journalEntries);
  const revokeDebts = await revokeDebtStore.listByDeployment(
    record.tenantId,
    record.name,
  );
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    tenantId: record.tenantId,
    appliedAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(provenance ? { provenance } : {}),
    ...(journal ? { journal } : {}),
    ...(revokeDebts.length > 0
      ? { revokeDebt: summarizeRevokeDebt(revokeDebts) }
      : {}),
    resources: record.appliedResources.map(toResourceSummary),
  };
}

export async function toDeploymentAuditResponse(
  record: TakosumiDeploymentRecord,
  journalStore: OperationJournalStore,
  revokeDebtStore: RevokeDebtStore,
): Promise<DeployPublicAuditResponse> {
  const journalEntries = await journalStore.listByDeployment(
    record.tenantId,
    record.name,
  );
  const journal = summarizeLatestJournal(journalEntries);
  const provenance = latestJournalProvenance(journalEntries);
  const revokeDebts = await revokeDebtStore.listByDeployment(
    record.tenantId,
    record.name,
  );
  const deployment = await toDeploymentSummary(
    record,
    journalStore,
    revokeDebtStore,
  );
  return {
    status: "ok",
    audit: {
      deployment,
      ...(journal ? { journal } : {}),
      ...(provenance ? { provenance } : {}),
      causeChain: journalEntries.map(toDeploymentAuditCauseSummary),
      entries: journalEntries.map(toJournalEntrySummary),
      revokeDebts: revokeDebts.map(toRevokeDebtRecordSummary),
    },
  };
}

export function summarizeLatestJournal(
  entries: readonly OperationJournalEntry[],
): DeploymentJournalSummary | undefined {
  if (entries.length === 0) return undefined;
  const sorted = [...entries].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) ||
    left.operationPlanDigest.localeCompare(right.operationPlanDigest) ||
    left.operationId.localeCompare(right.operationId)
  );
  const latest = sorted.at(-1);
  if (!latest) return undefined;
  const samePlan = entries.filter((entry) =>
    entry.operationPlanDigest === latest.operationPlanDigest &&
    entry.phase === latest.phase
  );
  const stageRanked = [...samePlan].sort((left, right) =>
    journalStageRank(left.stage) - journalStageRank(right.stage) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.operationId.localeCompare(right.operationId)
  );
  const latestStageEntry = stageRanked.at(-1) ?? latest;
  return {
    operationPlanDigest: latest.operationPlanDigest,
    phase: latest.phase,
    latestStage: latestStageEntry.stage,
    status: summarizeJournalStatus(samePlan),
    entryCount: samePlan.length,
    failedEntryCount: samePlan.filter((entry) => entry.status === "failed")
      .length,
    terminal: summarizeJournalTerminal(samePlan),
    updatedAt: latestStageEntry.createdAt,
  };
}

function summarizeJournalTerminal(
  entries: readonly OperationJournalEntry[],
): boolean {
  const latestByOperation = latestJournalEntriesByOperation(entries);
  const first = latestByOperation[0];
  if (!first || !isTerminalJournalStage(first.stage)) return false;
  return latestByOperation.every((entry) => entry.stage === first.stage);
}

function latestJournalEntriesByOperation(
  entries: readonly OperationJournalEntry[],
): readonly OperationJournalEntry[] {
  const byOperation = new Map<string, OperationJournalEntry>();
  for (const entry of entries) {
    const existing = byOperation.get(entry.operationId);
    if (
      !existing ||
      compareJournalStageProgress(existing, entry) < 0
    ) {
      byOperation.set(entry.operationId, entry);
    }
  }
  return [...byOperation.values()];
}

function compareJournalStageProgress(
  left: OperationJournalEntry,
  right: OperationJournalEntry,
): number {
  return journalStageRank(left.stage) - journalStageRank(right.stage) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.journalEntryId.localeCompare(right.journalEntryId);
}

export function toJournalEntrySummary(
  entry: OperationJournalEntry,
): DeploymentJournalEntrySummary {
  return {
    operationPlanDigest: entry.operationPlanDigest,
    journalEntryId: entry.journalEntryId,
    operationId: entry.operationId,
    phase: entry.phase,
    stage: entry.stage,
    operationKind: entry.operationKind,
    ...(entry.resourceName ? { resourceName: entry.resourceName } : {}),
    ...(entry.providerId ? { providerId: entry.providerId } : {}),
    effectDigest: entry.effectDigest,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(journalEntryProvenance(entry)
      ? { provenance: journalEntryProvenance(entry) }
      : {}),
  };
}

function toDeploymentAuditCauseSummary(
  entry: OperationJournalEntry,
): DeploymentAuditCauseSummary {
  const detail = journalEntryDetail(entry);
  const reason = detailReason(detail);
  return {
    operationPlanDigest: entry.operationPlanDigest,
    journalEntryId: entry.journalEntryId,
    operationId: entry.operationId,
    phase: entry.phase,
    stage: entry.stage,
    operationKind: entry.operationKind,
    ...(entry.resourceName ? { resourceName: entry.resourceName } : {}),
    ...(entry.providerId ? { providerId: entry.providerId } : {}),
    effectDigest: entry.effectDigest,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(detail ? { detail } : {}),
    ...(reason ? { reason } : {}),
    ...(detail && typeof detail.outcomeStatus === "string"
      ? { outcomeStatus: detail.outcomeStatus }
      : {}),
    ...(detail && Array.isArray(detail.revokeDebtIds)
      ? { revokeDebtIds: detail.revokeDebtIds.map(String) }
      : {}),
    ...(journalEntryProvenance(entry)
      ? { provenance: journalEntryProvenance(entry) }
      : {}),
  };
}

function detailReason(detail: JsonObject | undefined): string | undefined {
  if (!detail) return undefined;
  if (typeof detail.reason === "string") return detail.reason;
  const catalogReleaseHook = isJsonObject(detail.catalogReleaseHook)
    ? detail.catalogReleaseHook
    : undefined;
  if (typeof catalogReleaseHook?.reason === "string") {
    return catalogReleaseHook.reason;
  }
  const executableHook = isJsonObject(detail.executableHook)
    ? detail.executableHook
    : isJsonObject(catalogReleaseHook?.executableHook)
    ? catalogReleaseHook.executableHook
    : undefined;
  return typeof executableHook?.reason === "string"
    ? executableHook.reason
    : undefined;
}

function latestJournalProvenance(
  entries: readonly OperationJournalEntry[],
): DeployPublicProvenance | undefined {
  const withProvenance = entries
    .map((entry) => ({ entry, provenance: journalEntryProvenance(entry) }))
    .filter((item): item is {
      readonly entry: OperationJournalEntry;
      readonly provenance: DeployPublicProvenance;
    } => Boolean(item.provenance));
  withProvenance.sort((left, right) =>
    compareJournalStageProgress(left.entry, right.entry)
  );
  return withProvenance.at(-1)?.provenance;
}

function journalEntryProvenance(
  entry: OperationJournalEntry,
): DeployPublicProvenance | undefined {
  const detail = journalEntryDetail(entry);
  const provenance = detail?.provenance;
  return isJsonObject(provenance) ? provenance : undefined;
}

function journalEntryDetail(
  entry: OperationJournalEntry,
): JsonObject | undefined {
  const detail = isJsonObject(entry.effect.detail)
    ? entry.effect.detail
    : undefined;
  return detail;
}

function summarizeJournalStatus(
  entries: readonly OperationJournalEntry[],
): OperationJournalStatus {
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  if (entries.some((entry) => entry.status === "skipped")) return "skipped";
  if (entries.some((entry) => entry.status === "succeeded")) {
    return "succeeded";
  }
  return "recorded";
}

function isTerminalJournalStage(stage: OperationJournalStage): boolean {
  return stage === "finalize" || stage === "abort" || stage === "skip";
}

export function isContinuableRecoveryStage(
  stage: OperationJournalStage,
): boolean {
  return stage === "prepare" || stage === "pre-commit" ||
    stage === "commit" || stage === "post-commit" || stage === "observe";
}

export function isCompensableRecoveryStage(
  stage: OperationJournalStage,
): boolean {
  return stage === "commit" || stage === "post-commit" || stage === "observe";
}

function journalStageRank(stage: OperationJournalStage): number {
  switch (stage) {
    case "prepare":
      return 0;
    case "pre-commit":
      return 1;
    case "commit":
      return 2;
    case "post-commit":
      return 3;
    case "observe":
      return 4;
    case "finalize":
      return 5;
    case "abort":
      return 6;
    case "skip":
      return 7;
  }
}

function toResourceSummary(
  entry: TakosumiAppliedResourceRecord,
): DeploymentResourceSummary {
  return {
    name: entry.resourceName,
    shape: entry.shape,
    provider: entry.providerId,
    status: "applied",
    outputs: entry.outputs,
    handle: entry.handle,
  };
}

export function toRevokeDebtRecordSummary(
  record: RevokeDebtRecord,
): DeploymentRevokeDebtRecordSummary {
  return {
    id: record.id,
    generatedObjectId: record.generatedObjectId,
    reason: record.reason,
    status: record.status,
    ownerSpaceId: record.ownerSpaceId,
    originatingSpaceId: record.originatingSpaceId,
    ...(record.deploymentName ? { deploymentName: record.deploymentName } : {}),
    ...(record.operationPlanDigest
      ? { operationPlanDigest: record.operationPlanDigest }
      : {}),
    ...(record.journalEntryId ? { journalEntryId: record.journalEntryId } : {}),
    ...(record.operationId ? { operationId: record.operationId } : {}),
    ...(record.resourceName ? { resourceName: record.resourceName } : {}),
    ...(record.providerId ? { providerId: record.providerId } : {}),
    retryAttempts: record.retryAttempts,
    createdAt: record.createdAt,
    statusUpdatedAt: record.statusUpdatedAt,
    ...(record.lastRetryAt ? { lastRetryAt: record.lastRetryAt } : {}),
    ...(record.nextRetryAt ? { nextRetryAt: record.nextRetryAt } : {}),
    ...(record.agedAt ? { agedAt: record.agedAt } : {}),
    ...(record.clearedAt ? { clearedAt: record.clearedAt } : {}),
  };
}
