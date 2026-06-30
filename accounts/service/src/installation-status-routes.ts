/**
 * Status / uninstall / revision installation lifecycle routes.
 *
 * Pure-move decomposition of the former installation-lifecycle-routes
 * god-file; behavior is identical to the prior single-file handlers.
 */
import { takosumiAccountsCapsuleEventsPath } from "@takosjp/takosumi-accounts-contract";
import { type CapsuleRecord, transitionAppCapsuleStatus } from "./ledger.ts";
import type { AccountsStore } from "./store.ts";
import {
  activatedHttpDomainProjectionFromEvents,
  findOperationEvent,
  installationActivatedHttpDomainEvent,
  installationEnvelope,
  installationExportFailedEvent,
  installationExportedEvent,
  installationMaterializeFailedEvent,
  installationMaterializeSucceededEvent,
  isSha256DigestRef,
  serializeServiceBindingMaterial,
  serializeServiceGrantMaterial,
  serializeAppCapsule,
  serializeCapsuleEvent,
} from "./installation-helpers.ts";
import {
  materializeCompletionFromStatusPatch,
  validateOperationCompletionFromStatusPatch,
} from "./installation-materialize-helpers.ts";
import { exportDownloadUrl } from "./export-download-url.ts";
import { consoleErrorRedacted } from "./redacted-log.ts";
import {
  errorJson,
  appCapsuleStatusValue,
  isRecord,
  json,
  readJsonObject,
  stringValue,
} from "./http-helpers.ts";
import type { DeployControlFacadeOptions } from "./deploy-control-facade.ts";
import { appendLedgerEvent } from "./installation-ledger-events.ts";
import { publicCapsuleOperationErrorMessage } from "./installation-operation-errors.ts";
import {
  activatedHttpDomainEventPayload,
  activatedHttpDomainInactiveEventPayload,
  serviceBindingMaterialRecordsFromValue,
  serviceGrantMaterialRecordsFromValue,
  appCapsuleModeValue,
  appCapsuleRevisionConfirmFromValue,
  appCapsuleRevisionPayload,
  applyCoreDeploymentForCloudProjection,
  installationRecordFromCoreDeploymentProjection,
  normalizeSourceGitUrl,
  revisionEnvelopeResponse,
  rollbackCoreDeploymentForCloudProjection,
} from "./installation-lifecycle-shared.ts";
import { redactPublicString } from "./public-redaction.ts";

export async function handleUpdateAppCapsuleStatus(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const status = appCapsuleStatusValue(body.status);
  if (!status) return errorJson("invalid_request", "invalid request", 400);
  const requestedMode =
    body.mode === undefined ? undefined : appCapsuleModeValue(body.mode);
  if (body.mode !== undefined && !requestedMode) {
    return errorJson("invalid_request", "invalid request", 400);
  }
  const failedOperation =
    body.operation === undefined
      ? undefined
      : installationFailedOperationValue(body.operation);
  if (body.operation !== undefined && !failedOperation) {
    return errorJson("invalid_request", "invalid request", 400);
  }
  if (failedOperation && !stringValue(body.operationId)) {
    return errorJson(
      "invalid_request",
      "operationId is required when operation is provided",
      400,
    );
  }
  const installation = await input.store.findAppCapsule(input.capsuleId);
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);

  let updated;
  const now = Date.now();
  try {
    updated = transitionAppCapsuleStatus(installation, status, now);
  } catch (error) {
    consoleErrorRedacted("installation_status_conflict", error);
    return errorJson(
      "state_conflict",
      "installation status transition is not allowed",
      409,
    );
  }
  const statusOperationId = stringValue(body.operationId);
  if (updated.status === "exported" && statusOperationId) {
    const exportCompletion = await validateOperationCompletionFromStatusPatch({
      store: input.store,
      capsuleId: input.capsuleId,
      operation: "export",
      operationId: statusOperationId,
    });
    if (exportCompletion instanceof Response) return exportCompletion;
  }
  if (failedOperation && statusOperationId) {
    const failedCompletion = await validateOperationCompletionFromStatusPatch({
      store: input.store,
      capsuleId: input.capsuleId,
      operation: failedOperation,
      operationId: statusOperationId,
    });
    if (failedCompletion instanceof Response) return failedCompletion;
  }
  const exportedDownloadUrl = stringValue(body.downloadUrl);
  const exportedDownloadExpiresAt = stringValue(body.downloadExpiresAt);
  const exportedArchiveDigest = stringValue(body.archiveDigest);
  if (updated.status === "exported") {
    if (statusOperationId && !exportedDownloadUrl) {
      return errorJson(
        "invalid_request",
        "downloadUrl is required when completing an export operation",
        400,
      );
    }
    if (exportedDownloadUrl) {
      try {
        exportDownloadUrl(exportedDownloadUrl, "export status downloadUrl");
      } catch {
        return errorJson(
          "invalid_request",
          "downloadUrl must be HTTPS or loopback HTTP",
          400,
        );
      }
    }
    if (
      exportedDownloadExpiresAt &&
      !Number.isFinite(Date.parse(exportedDownloadExpiresAt))
    ) {
      return errorJson(
        "invalid_request",
        "downloadExpiresAt must be a valid timestamp",
        400,
      );
    }
    if (exportedArchiveDigest && !isSha256DigestRef(exportedArchiveDigest)) {
      return errorJson(
        "invalid_request",
        "archiveDigest must be sha256:<digest>",
        400,
      );
    }
  }
  let runtimeBinding;
  let materializeSucceededEvent;
  let materializePreserveDigest;
  if (requestedMode && requestedMode !== installation.mode) {
    const completion = await materializeCompletionFromStatusPatch({
      body,
      installation,
      requestedMode,
      status,
      store: input.store,
      now,
    });
    if (completion instanceof Response) return completion;
    updated = {
      ...updated,
      mode: requestedMode,
      runtimeBindingId: completion.runtimeBindingId,
      updatedAt: now,
    };
    runtimeBinding = completion.runtimeBinding;
    materializePreserveDigest = completion.preserveDigest;
  } else if (requestedMode && requestedMode === installation.mode) {
    const operationId = stringValue(body.operationId);
    if (operationId) {
      const closed = findOperationEvent({
        events: await input.store.listCapsuleEvents(input.capsuleId),
        operationId,
        eventTypes: [
          installationMaterializeSucceededEvent,
          installationMaterializeFailedEvent,
        ],
      });
      if (closed) {
        return errorJson(
          "operation_already_closed",
          "materialize operation already has a completion event",
          409,
        );
      }
    }
  }
  await input.store.saveAppCapsule(updated);
  if (runtimeBinding) await input.store.saveRuntimeBinding(runtimeBinding);
  let exportedEvent;
  let failedOperationEvent;
  if (updated.status !== installation.status) {
    const publicReason = publicOptionalString(body.reason);
    await appendLedgerEvent(input.store, {
      capsuleId: input.capsuleId,
      eventType: "installation.status_changed",
      payload: {
        from: installation.status,
        to: updated.status,
        reason: publicReason,
      },
      now: updated.updatedAt,
    });
    if (updated.status === "exported") {
      exportedEvent = await appendLedgerEvent(input.store, {
        capsuleId: input.capsuleId,
        eventType: installationExportedEvent,
        payload: {
          operationId: stringValue(body.operationId) ?? null,
          from: installation.status,
          to: updated.status,
          reason: publicReason,
          downloadUrl: exportedDownloadUrl ?? null,
          downloadExpiresAt: exportedDownloadExpiresAt ?? null,
          archiveDigest: exportedArchiveDigest ?? null,
        },
        now: updated.updatedAt,
      });
    }
  }
  if (failedOperation) {
    const fallback =
      failedOperation === "materialize"
        ? "materialize worker failed"
        : "export failed";
    const failureReason = publicCapsuleOperationErrorMessage(
      body.reason,
      fallback,
    );
    const failureError = publicCapsuleOperationErrorMessage(
      body.error ?? body.reason,
      fallback,
    );
    failedOperationEvent = await appendLedgerEvent(input.store, {
      capsuleId: input.capsuleId,
      eventType:
        failedOperation === "materialize"
          ? installationMaterializeFailedEvent
          : installationExportFailedEvent,
      payload: {
        operationId: stringValue(body.operationId),
        from: installation.status,
        to: updated.status,
        reason: failureReason,
        error: failureError,
      },
      now: updated.status === installation.status ? now : updated.updatedAt,
    });
  }
  if (requestedMode && requestedMode !== installation.mode) {
    materializeSucceededEvent = await appendLedgerEvent(input.store, {
      capsuleId: input.capsuleId,
      eventType: installationMaterializeSucceededEvent,
      payload: {
        operationId: stringValue(body.operationId),
        fromMode: installation.mode,
        toMode: requestedMode,
        runtimeTargetId: updated.runtimeBindingId ?? null,
        preserveDigest: materializePreserveDigest ?? null,
        reason: publicOptionalString(body.reason),
      },
      now: updated.updatedAt,
    });
  }
  return json({
    installation: serializeAppCapsule(updated),
    ...(exportedEvent
      ? { event: serializeCapsuleEvent(exportedEvent) }
      : materializeSucceededEvent
        ? { event: serializeCapsuleEvent(materializeSucceededEvent) }
        : failedOperationEvent
          ? { event: serializeCapsuleEvent(failedOperationEvent) }
          : {}),
  });
}

function publicOptionalString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text === undefined ? undefined : redactPublicString(text);
}

export async function handleUninstallAppCapsule(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  void input;
  return errorJson(
    "destroy_plan_required",
    "Capsule removal must use the Takosumi deploy-control destroy-plan flow.",
    410,
  );
}

export async function handleUpdateAppCapsuleRevision(input: {
  capsuleId: string;
  operation: "revision" | "rollback";
  request: Request;
  store: AccountsStore;
  deployControl?: DeployControlFacadeOptions;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const installation = await input.store.findAppCapsule(input.capsuleId);
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (installation.status !== "ready") {
    return errorJson(
      "state_conflict",
      `${input.operation} requires a ready Capsule projection`,
      409,
    );
  }
  if (!input.deployControl) {
    return errorJson(
      "deploy_control_required",
      "Capsule projection revision requires the Takosumi deploy-control ledger.",
      503,
    );
  }
  return await handleCoreDeployControlBackedRevision({
    capsuleId: input.capsuleId,
    operation: input.operation,
    body,
    store: input.store,
    deployControl: input.deployControl,
    installation,
  });
}

async function handleCoreDeployControlBackedRevision(input: {
  capsuleId: string;
  operation: "revision" | "rollback";
  body: Record<string, unknown>;
  store: AccountsStore;
  deployControl: DeployControlFacadeOptions;
  installation: CapsuleRecord;
}): Promise<Response> {
  const now = Date.now();
  const source = isRecord(input.body.source) ? input.body.source : undefined;
  const expected = isRecord(input.body.expected)
    ? input.body.expected
    : undefined;

  if (input.operation === "rollback") {
    const coreRollback = await rollbackCoreDeploymentForCloudProjection({
      deployControl: input.deployControl,
      capsuleId: input.capsuleId,
      deploymentId:
        stringValue(input.body.deploymentId) ??
        stringValue(input.body.deployment_id),
      planRunId:
        stringValue(input.body.planRunId) ??
        stringValue(input.body.plan_run_id) ??
        (expected ? stringValue(expected.planRunId) : undefined),
      expected,
    });
    if (coreRollback instanceof Response) return coreRollback;
    const updated = installationRecordFromCoreDeploymentProjection({
      installation: input.installation,
      projection: coreRollback,
      now,
    });
    await input.store.saveAppCapsule(updated);
    const event = await appendLedgerEvent(input.store, {
      capsuleId: input.capsuleId,
      eventType: "installation.rolled_back",
      payload: {
        reason: publicOptionalString(input.body.reason),
        previous: appCapsuleRevisionPayload(input.installation),
        next: appCapsuleRevisionPayload(updated),
        coreDeployment: {
          id: coreRollback.deploymentId,
          rollback:
            isRecord(coreRollback.payload) &&
            isRecord(coreRollback.payload.rollback)
              ? coreRollback.payload.rollback
              : undefined,
        },
      },
      now,
    });
    await appendLedgerEvent(input.store, {
      capsuleId: input.capsuleId,
      eventType: installationActivatedHttpDomainEvent,
      payload: coreRollback.activatedHttpDomain
        ? activatedHttpDomainEventPayload(coreRollback.activatedHttpDomain)
        : activatedHttpDomainInactiveEventPayload({
            deploymentId: coreRollback.deploymentId,
            now,
          }),
      now,
    });
    return await revisionEnvelopeResponse({
      store: input.store,
      installation: updated,
      operation: input.operation,
      event,
    });
  }

  const sourceGitUrl =
    stringValue(source?.gitUrl) ??
    stringValue(source?.url) ??
    input.installation.sourceGitUrl;
  const sourceRef =
    stringValue(source?.ref) ??
    stringValue(input.body.ref) ??
    stringValue(input.body.to);
  const sourceCommit =
    stringValue(expected?.sourceCommit) ??
    stringValue(source?.commit) ??
    stringValue(input.body.sourceCommit);
  const sourcePath =
    stringValue(source?.path) ??
    stringValue(source?.modulePath) ??
    input.installation.sourcePath;
  const planDigest =
    stringValue(expected?.planDigest) ??
    stringValue(source?.planDigest) ??
    stringValue(input.body.planDigest);
  const artifactDigest =
    stringValue(source?.artifactDigest) ??
    stringValue(input.body.artifactDigest);
  if (!sourceRef || !sourceCommit || !planDigest) {
    return errorJson(
      "invalid_request",
      "deployment through Takosumi deploy control requires source.ref plus expected.sourceCommit and expected.planDigest",
      400,
    );
  }
  if (
    normalizeSourceGitUrl(sourceGitUrl) !==
    normalizeSourceGitUrl(input.installation.sourceGitUrl)
  ) {
    return errorJson(
      "source_mismatch",
      "deployment must keep the installation source git URL",
      409,
    );
  }
  if (
    input.installation.sourcePath &&
    sourcePath &&
    sourcePath !== input.installation.sourcePath
  ) {
    return errorJson(
      "source_path_mismatch",
      "deployment must keep the installation source path",
      409,
    );
  }
  const appId = stringValue(input.body.appId);
  if (appId && appId !== input.installation.appId) {
    return errorJson(
      "app_mismatch",
      "deployment must keep the installation appId",
      409,
    );
  }

  const requestedBindings = serviceBindingMaterialRecordsFromValue({
    value: input.body.serviceBindings,
    capsuleId: input.capsuleId,
    now,
  });
  if (requestedBindings instanceof Response) return requestedBindings;
  const requestedGrants = serviceGrantMaterialRecordsFromValue({
    value: input.body.serviceGrants,
    capsuleId: input.capsuleId,
    now,
  });
  if (requestedGrants instanceof Response) return requestedGrants;
  const confirmResult = await appCapsuleRevisionConfirmFromValue({
    value: input.body.confirm,
    operation: input.operation,
    capsuleId: input.capsuleId,
    appId: input.installation.appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    ...(sourcePath ? { sourcePath } : {}),
    planDigest,
    artifactDigest: artifactDigest ?? null,
    requestedBindings,
    requestedGrants,
  });
  if (confirmResult instanceof Response) return confirmResult;

  const coreDeploy = await applyCoreDeploymentForCloudProjection({
    deployControl: input.deployControl,
    capsuleId: input.capsuleId,
    source,
    expected,
  });
  if (coreDeploy instanceof Response) return coreDeploy;

  const updated = installationRecordFromCoreDeploymentProjection({
    installation: input.installation,
    projection: coreDeploy,
    fallback: {
      sourceGitUrl,
      sourceRef,
      sourceCommit,
      ...(sourcePath ? { sourcePath } : {}),
      planDigest,
      artifactDigest,
    },
    now,
  });
  await input.store.saveAppCapsule(updated);
  const event = await appendLedgerEvent(input.store, {
    capsuleId: input.capsuleId,
    eventType: "installation.deployed",
    payload: {
      reason: publicOptionalString(input.body.reason),
      confirm: confirmResult,
      previous: appCapsuleRevisionPayload(input.installation),
      next: appCapsuleRevisionPayload(updated),
      requestedServiceBindings: requestedBindings.map(
        serializeServiceBindingMaterial,
      ),
      requestedServiceGrants: requestedGrants.map(
        serializeServiceGrantMaterial,
      ),
      coreDeployment: { id: coreDeploy.deploymentId },
    },
    now,
  });
  await appendLedgerEvent(input.store, {
    capsuleId: input.capsuleId,
    eventType: installationActivatedHttpDomainEvent,
    payload: coreDeploy.activatedHttpDomain
      ? activatedHttpDomainEventPayload(coreDeploy.activatedHttpDomain)
      : activatedHttpDomainInactiveEventPayload({
          deploymentId: coreDeploy.deploymentId,
          now,
        }),
    now,
  });

  return await revisionEnvelopeResponse({
    store: input.store,
    installation: updated,
    operation: input.operation,
    event,
  });
}

function installationFailedOperationValue(
  value: unknown,
): "materialize" | "export" | undefined {
  return value === "materialize" || value === "export" ? value : undefined;
}
