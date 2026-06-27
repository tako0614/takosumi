/**
 * Deploy-control App-Installation projection sync: mirrors a deploy/apply/run
 * outcome into the accounts ledger's app-installation projection rows + events.
 * Extracted from `control-routes.ts` (P3 god-file split); shared by the deploy,
 * capsule, and run control handlers.
 */
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  Connection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  Deployment,
  InternalDeployRequest,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  ArtifactSnapshotRequest,
  Source,
  CreateSourceRequest,
  CreateSourceResponse,
  ListSourceSnapshotsResponse,
  ListSourcesResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSnapshot,
} from "takosumi-contract/sources";
import type {
  DeployResponse,
  PublicDeployResponse,
} from "takosumi-contract/deploy";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListProvidersResponse } from "takosumi-contract/providers";
import type { Space, SpaceType } from "takosumi-contract/spaces";
import type {
  InstallationProviderEnvBindingSet,
  InstallConfig,
  Installation,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicInstallation,
} from "takosumi-contract/installations";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderEnvBinding,
  InstallationProviderEnvBindings,
  InstallationProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/output-snapshots";
import type { PublicDeployment } from "takosumi-contract/deployments";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  BillingSettings,
  CreditBalance,
  CreditReservation,
  UsageEvent,
} from "takosumi-contract/billing";
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  AppInstallationMode,
  AppInstallationStatus,
  InstallationRecord,
  SpaceKind,
} from "../ledger.ts";
import type { SharedCellRuntimeAllocator } from "../runtime.ts";
import type { AccountsStore } from "../store.ts";
import type {
  ControlPlaneOperations,
  RunGroupWithRunsLike,
  ControlSpaceRole,
  ControlMembershipStatus,
  PublicSpaceMember,
  MembershipActor,
} from "../control-operations.ts";
import { errorJson } from "../http-helpers.ts";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppInstallationStatus } from "../ledger.ts";

interface DeployControlProjectionSource {
  readonly sourceGitUrl: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly sourcePath?: string;
  readonly planDigest: string;
  readonly artifactDigest?: string;
}

export async function syncDeployControlProjectionFromDeploy(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly deployResponse: DeployResponse;
  readonly projectionMode?: Extract<
    AppInstallationMode,
    "self-hosted" | "shared-cell"
  >;
  readonly sharedCellRuntime?: SharedCellRuntimeAllocator;
}): Promise<Response | undefined> {
  const planRunId =
    input.deployResponse.planRun?.id ?? input.deployResponse.run.id;
  const { planRun } = await input.operations.getPlanRun(planRunId);
  return await upsertDeployControlInstallationProjection({
    operations: input.operations,
    store: input.store,
    sessionSubject: input.sessionSubject,
    installation: input.deployResponse.installation,
    planRun,
    fallbackRun: input.deployResponse.planRun ?? input.deployResponse.run,
    requestedStatus: projectionStatusFromDeploy(input.deployResponse),
    projectionMode: input.projectionMode,
    sharedCellRuntime: input.sharedCellRuntime,
  });
}

export async function syncDeployControlProjectionFromApply(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly planRun: PublicPlanRun;
  readonly response: ApplyRunResponse;
}): Promise<Response | undefined> {
  const installation =
    input.response.installation ??
    (input.planRun.installationId
      ? await input.operations.installations
          .getInstallation(input.planRun.installationId)
          .catch(() => undefined)
      : undefined);
  if (!installation) return undefined;
  return await upsertDeployControlInstallationProjection({
    operations: input.operations,
    store: input.store,
    sessionSubject: input.sessionSubject,
    installation,
    planRun: input.planRun,
    fallbackRun: undefined,
    requestedStatus: projectionStatusFromRunStatus(
      input.response.applyRun.status,
    ),
  });
}

export async function syncDeployControlProjectionStatusFromRun(input: {
  readonly store: AccountsStore;
  readonly run: Run;
}): Promise<void> {
  if (
    (input.run.type !== "apply" && input.run.type !== "destroy_apply") ||
    !input.run.installationId
  ) {
    return;
  }
  const requestedStatus = projectionStatusFromRun(input.run);
  if (requestedStatus === "installing") return;
  const installation = await input.store.findAppInstallation(
    input.run.installationId,
  );
  if (!installation) return;
  await saveProjectionStatusChange({
    store: input.store,
    installation,
    requestedStatus,
    reason: `deploy-control ${input.run.type} run ${input.run.status}`,
  });
}

async function upsertDeployControlInstallationProjection(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly installation: PublicInstallation;
  readonly planRun: PublicPlanRun;
  readonly fallbackRun?: Run;
  readonly requestedStatus: AppInstallationStatus;
  readonly projectionMode?: Extract<
    AppInstallationMode,
    "self-hosted" | "shared-cell"
  >;
  readonly sharedCellRuntime?: SharedCellRuntimeAllocator;
}): Promise<Response | undefined> {
  const source = await projectionSourceFromPlanRun({
    operations: input.operations,
    planRun: input.planRun,
    fallbackRun: input.fallbackRun,
  });
  if (!source) return undefined;
  const existing = await input.store.findAppInstallation(input.installation.id);
  if (existing?.status === "ready" && input.requestedStatus === "installing") {
    return undefined;
  }
  const now = Date.now();
  const accountId =
    existing?.accountId ??
    (await ensureProjectionLedgerScope({
      operations: input.operations,
      store: input.store,
      sessionSubject: input.sessionSubject,
      spaceId: input.installation.spaceId,
      now,
    }));
  if (!accountId) return undefined;
  const status = nextProjectionStatus(existing?.status, input.requestedStatus);
  const mode = existing?.mode ?? input.projectionMode ?? "self-hosted";
  let runtimeBindingId = existing?.runtimeBindingId;
  let runtimeBinding;
  if (mode === "shared-cell" && !runtimeBindingId) {
    if (!input.sharedCellRuntime) {
      return errorJson(
        "feature_unavailable",
        "shared-cell projection runtime is not configured",
        503,
      );
    }
    runtimeBinding = await input.sharedCellRuntime({
      installationId: input.installation.id,
      accountId,
      spaceId: input.installation.spaceId,
      appId: input.installation.name,
      createdBySubject: input.sessionSubject,
      now,
    });
    if (!runtimeBinding) {
      return errorJson(
        "shared_cell_capacity_unavailable",
        "shared-cell install requires an available warm runtime slot",
        503,
      );
    }
    if (
      runtimeBinding.installationId !== input.installation.id ||
      runtimeBinding.mode !== "shared-cell" ||
      runtimeBinding.targetType !== "shared-cell"
    ) {
      return errorJson(
        "invalid_shared_cell_runtime_target",
        "shared-cell runtime allocator must return a shared-cell runtime target for the requested installation",
        500,
      );
    }
    runtimeBindingId = runtimeBinding.runtimeBindingId;
  }
  const record: InstallationRecord = {
    installationId: input.installation.id,
    accountId,
    spaceId: input.installation.spaceId,
    appId: input.installation.name,
    sourceGitUrl: source.sourceGitUrl,
    sourceRef: source.sourceRef,
    sourceCommit: source.sourceCommit,
    ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
    planDigest: source.planDigest,
    ...(source.artifactDigest ? { artifactDigest: source.artifactDigest } : {}),
    mode,
    ...(runtimeBindingId ? { runtimeBindingId } : {}),
    ...(existing?.billingAccountId
      ? { billingAccountId: existing.billingAccountId }
      : {}),
    status,
    createdBySubject: existing?.createdBySubject ?? input.sessionSubject,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await input.store.saveAppInstallation(record);
  if (runtimeBinding) await input.store.saveRuntimeBinding(runtimeBinding);
  if (!existing) {
    await appendLedgerEvent(input.store, {
      installationId: record.installationId,
      eventType: "installation.created",
      payload: {
        appId: record.appId,
        accountId: record.accountId,
        spaceId: record.spaceId,
        mode: record.mode,
        status: record.status,
      },
      now,
    });
    return undefined;
  }
  if (record.status !== existing.status) {
    await appendProjectionStatusChangedEvent({
      store: input.store,
      installationId: record.installationId,
      from: existing.status,
      to: record.status,
      reason: "deploy-control projection sync",
      now,
    });
  }
  return undefined;
}

export async function saveProjectionStatusChange(input: {
  readonly store: AccountsStore;
  readonly installation: InstallationRecord;
  readonly requestedStatus: AppInstallationStatus;
  readonly reason: string;
}): Promise<void> {
  const status = nextProjectionStatus(
    input.installation.status,
    input.requestedStatus,
  );
  if (status === input.installation.status) return;
  const now = Date.now();
  await input.store.saveAppInstallation({
    ...input.installation,
    status,
    updatedAt: now,
  });
  await appendProjectionStatusChangedEvent({
    store: input.store,
    installationId: input.installation.installationId,
    from: input.installation.status,
    to: status,
    reason: input.reason,
    now,
  });
}

async function appendProjectionStatusChangedEvent(input: {
  readonly store: AccountsStore;
  readonly installationId: string;
  readonly from: AppInstallationStatus;
  readonly to: AppInstallationStatus;
  readonly reason: string;
  readonly now: number;
}): Promise<void> {
  await appendLedgerEvent(input.store, {
    installationId: input.installationId,
    eventType: "installation.status_changed",
    payload: {
      from: input.from,
      to: input.to,
      reason: input.reason,
    },
    now: input.now,
  });
}

async function ensureProjectionLedgerScope(input: {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  readonly sessionSubject: TakosumiSubject;
  readonly spaceId: string;
  readonly now: number;
}): Promise<string | undefined> {
  const existingSpace = await input.store.findSpace(input.spaceId);
  if (existingSpace) {
    const existingAccount = await input.store.findLedgerAccount(
      existingSpace.accountId,
    );
    if (
      existingAccount &&
      existingAccount.legalOwnerSubject !== input.sessionSubject
    ) {
      return undefined;
    }
    if (!existingAccount) {
      await input.store.saveLedgerAccount({
        accountId: existingSpace.accountId,
        legalOwnerSubject: input.sessionSubject,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    return existingSpace.accountId;
  }
  const accountId = await projectionAccountIdForSubject(input.sessionSubject);
  const existingAccount = await input.store.findLedgerAccount(accountId);
  if (!existingAccount) {
    await input.store.saveLedgerAccount({
      accountId,
      legalOwnerSubject: input.sessionSubject,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  const space = await input.operations.spaces
    .getSpace(input.spaceId)
    .catch(() => undefined);
  await input.store.saveSpace({
    spaceId: input.spaceId,
    accountId,
    kind: ledgerSpaceKind(space?.type),
    ...(space?.displayName ? { displayName: space.displayName } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  });
  const confirmedSpace = await input.store.findSpace(input.spaceId);
  return confirmedSpace?.accountId === accountId ? accountId : undefined;
}

async function projectionSourceFromPlanRun(input: {
  readonly operations: ControlPlaneOperations;
  readonly planRun: PublicPlanRun;
  readonly fallbackRun?: Run;
}): Promise<DeployControlProjectionSource | undefined> {
  const snapshotId =
    input.planRun.sourceSnapshotId ?? input.fallbackRun?.sourceSnapshotId;
  const snapshot = snapshotId
    ? await input.operations
        .getSourceSnapshot(snapshotId)
        .catch(() => undefined)
    : undefined;
  if (snapshot) {
    return {
      sourceGitUrl: snapshot.url,
      sourceRef: snapshot.ref,
      sourceCommit: snapshot.resolvedCommit || snapshot.archiveDigest,
      ...(snapshot.path ? { sourcePath: snapshot.path } : {}),
      planDigest:
        input.planRun.planDigest ??
        input.fallbackRun?.planDigest ??
        snapshot.archiveDigest,
      ...(input.planRun.planArtifact?.digest
        ? { artifactDigest: input.planRun.planArtifact.digest }
        : {}),
    };
  }
  const source = (input.planRun as { readonly source?: OpenTofuModuleSource })
    .source;
  if (!source) return undefined;
  const planDigest =
    input.planRun.planDigest ??
    input.fallbackRun?.planDigest ??
    input.planRun.sourceDigest;
  const artifactDigest = input.planRun.planArtifact?.digest;
  if (source.kind === "git") {
    return {
      sourceGitUrl: source.url,
      sourceRef: source.ref ?? "HEAD",
      sourceCommit:
        input.planRun.sourceCommit ??
        source.commit ??
        input.planRun.sourceDigest,
      ...(source.modulePath ? { sourcePath: source.modulePath } : {}),
      planDigest,
      ...(artifactDigest ? { artifactDigest } : {}),
    };
  }
  if (source.kind === "prepared") {
    return {
      sourceGitUrl: source.url,
      sourceRef: "prepared",
      sourceCommit: input.planRun.sourceCommit ?? source.digest,
      ...(source.modulePath ? { sourcePath: source.modulePath } : {}),
      planDigest,
      ...(artifactDigest ? { artifactDigest } : {}),
    };
  }
  return {
    sourceGitUrl: `local:${source.path}`,
    sourceRef: source.modulePath ?? "local",
    sourceCommit: input.planRun.sourceCommit ?? input.planRun.sourceDigest,
    ...(source.modulePath ? { sourcePath: source.modulePath } : {}),
    planDigest,
    ...(artifactDigest ? { artifactDigest } : {}),
  };
}

function projectionStatusFromDeploy(
  deployResponse: DeployResponse,
): AppInstallationStatus {
  if (
    deployResponse.status === "failed" ||
    deployResponse.run.status === "failed" ||
    deployResponse.planRun?.status === "failed" ||
    deployResponse.applyRun?.status === "failed"
  ) {
    return "failed";
  }
  if (
    deployResponse.status === "applied" ||
    deployResponse.applyRun?.status === "succeeded" ||
    (deployResponse.installation.status === "active" &&
      deployResponse.installation.currentStateGeneration > 0)
  ) {
    return "ready";
  }
  return "installing";
}

export function deployProjectionModeValue(
  value: unknown,
): Extract<AppInstallationMode, "self-hosted" | "shared-cell"> | undefined {
  if (value === "self-hosted" || value === "shared-cell") return value;
  return undefined;
}

function projectionStatusFromRunStatus(
  status: Run["status"],
): AppInstallationStatus {
  if (status === "succeeded") return "ready";
  if (status === "failed" || status === "cancelled" || status === "expired") {
    return "failed";
  }
  return "installing";
}

function projectionStatusFromRun(run: Run): AppInstallationStatus {
  if (run.type === "destroy_apply" && run.status === "succeeded") {
    return "suspended";
  }
  return projectionStatusFromRunStatus(run.status);
}

function nextProjectionStatus(
  existing: AppInstallationStatus | undefined,
  requested: AppInstallationStatus,
): AppInstallationStatus {
  if (!existing) return requested;
  if (existing === requested) return existing;
  if (existing === "ready" && requested === "failed") return existing;
  if (canTransitionAppInstallationStatus(existing, requested)) return requested;
  return existing;
}

async function projectionAccountIdForSubject(
  subject: TakosumiSubject,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`takosumi.accounts.projection-account:${subject}`),
  );
  return `acct_${base64UrlEncodeBytes(new Uint8Array(digest)).slice(0, 32)}`;
}

function ledgerSpaceKind(type: SpaceType | undefined): SpaceKind {
  return type === "organization" ? "org" : "personal";
}
