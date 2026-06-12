/**
 * Status / uninstall / revision installation lifecycle routes.
 *
 * Pure-move decomposition of the former installation-lifecycle-routes
 * god-file; behavior is identical to the prior single-file handlers.
 */
import {
  takosumiAccountsInstallationEventsPath,
} from "@takosjp/takosumi-accounts-contract";
import {
  type AppGrantRecord,
  type InstallationEventRecord,
  type InstallationRecord,
  transitionAppInstallationStatus,
} from "./ledger.ts";
import type {
  AccountsStore,
} from "./store.ts";
import {
  activatedHttpDomainProjectionFromEvents,
  findOperationEvent,
  installationActivatedHttpDomainEvent,
  installationEnvelope,
  installationExportFailedEvent,
  installationExportedEvent,
  installationMaterializeFailedEvent,
  installationMaterializeSucceededEvent,
  installationUninstalledEvent,
  serializeAppBinding,
  serializeAppGrant,
  serializeAppInstallation,
  serializeInstallationEvent,
} from "./installation-helpers.ts";
import {
  materializeCompletionFromStatusPatch,
  validateOperationCompletionFromStatusPatch,
} from "./installation-materialize-helpers.ts";
import {
  errorJson,
  appInstallationStatusValue,
  isRecord,
  json,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "./http-helpers.ts";
import type {
  DeployControlProxyOptions,
} from "./deploy-control-proxy.ts";
import {
  appendLedgerEvent,
} from "./installation-ledger-events.ts";
import {
  activatedHttpDomainEventPayload,
  activatedHttpDomainInactiveEventPayload,
  appBindingRecordsFromValue,
  appGrantRecordsFromValue,
  appInstallationModeValue,
  appInstallationRevisionConfirmFromValue,
  appInstallationRevisionPayload,
  applyCoreDeploymentForCloudProjection,
  installationRecordFromCoreDeploymentProjection,
  normalizeSourceGitUrl,
  revisionEnvelopeResponse,
  rollbackCoreDeploymentForCloudProjection,
} from "./installation-lifecycle-shared.ts";

export async function handleUpdateAppInstallationStatus(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const status = appInstallationStatusValue(body.status);
  if (!status) return errorJson("invalid_request", "invalid request", 400);
  const requestedMode = body.mode === undefined
    ? undefined
    : appInstallationModeValue(body.mode);
  if (body.mode !== undefined && !requestedMode) {
    return errorJson("invalid_request", "invalid request", 400);
  }
  const failedOperation = body.operation === undefined
    ? undefined
    : installationFailedOperationValue(body.operation);
  if (body.operation !== undefined && !failedOperation) {
    return errorJson("invalid_request", "invalid request", 400);
  }
  if (failedOperation && !stringValue(body.operationId)) {
    return errorJson("invalid_request", "operationId is required when operation is provided", 400);
  }
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return errorJson("installation_not_found", "installation not found", 404);

  let updated;
  const now = Date.now();
  try {
    updated = transitionAppInstallationStatus(installation, status, now);
  } catch (error) {
    console.error(
      "installation_status_conflict",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return errorJson("state_conflict", "installation status transition is not allowed", 409);
  }
  const statusOperationId = stringValue(body.operationId);
  if (updated.status === "exported" && statusOperationId) {
    const exportCompletion = await validateOperationCompletionFromStatusPatch({
      store: input.store,
      installationId: input.installationId,
      operation: "export",
      operationId: statusOperationId,
    });
    if (exportCompletion instanceof Response) return exportCompletion;
  }
  if (failedOperation && statusOperationId) {
    const failedCompletion = await validateOperationCompletionFromStatusPatch({
      store: input.store,
      installationId: input.installationId,
      operation: failedOperation,
      operationId: statusOperationId,
    });
    if (failedCompletion instanceof Response) return failedCompletion;
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
        events: await input.store.listInstallationEvents(input.installationId),
        operationId,
        eventTypes: [
          installationMaterializeSucceededEvent,
          installationMaterializeFailedEvent,
        ],
      });
      if (closed) {
        return errorJson("operation_already_closed", "materialize operation already has a completion event", 409);
      }
    }
  }
  await input.store.saveAppInstallation(updated);
  if (runtimeBinding) await input.store.saveRuntimeBinding(runtimeBinding);
  let exportedEvent;
  let failedOperationEvent;
  if (updated.status !== installation.status) {
    await appendLedgerEvent(input.store, {
      installationId: input.installationId,
      eventType: "installation.status_changed",
      payload: {
        from: installation.status,
        to: updated.status,
        reason: stringValue(body.reason),
      },
      now: updated.updatedAt,
    });
    if (updated.status === "exported") {
      exportedEvent = await appendLedgerEvent(input.store, {
        installationId: input.installationId,
        eventType: installationExportedEvent,
        payload: {
          operationId: stringValue(body.operationId) ?? null,
          from: installation.status,
          to: updated.status,
          reason: stringValue(body.reason),
          downloadUrl: stringValue(body.downloadUrl) ?? null,
          downloadExpiresAt: stringValue(body.downloadExpiresAt) ?? null,
        },
        now: updated.updatedAt,
      });
    }
    if (updated.status === "failed" && failedOperation) {
      failedOperationEvent = await appendLedgerEvent(input.store, {
        installationId: input.installationId,
        eventType: failedOperation === "materialize"
          ? installationMaterializeFailedEvent
          : installationExportFailedEvent,
        payload: {
          operationId: stringValue(body.operationId),
          from: installation.status,
          to: updated.status,
          reason: stringValue(body.reason),
          error: stringValue(body.error) ?? stringValue(body.reason) ?? null,
        },
        now: updated.updatedAt,
      });
    }
  }
  if (requestedMode && requestedMode !== installation.mode) {
    materializeSucceededEvent = await appendLedgerEvent(input.store, {
      installationId: input.installationId,
      eventType: installationMaterializeSucceededEvent,
      payload: {
        operationId: stringValue(body.operationId),
        fromMode: installation.mode,
        toMode: requestedMode,
        runtimeTargetId: updated.runtimeBindingId ?? null,
        preserveDigest: materializePreserveDigest ?? null,
        reason: stringValue(body.reason),
      },
      now: updated.updatedAt,
    });
  }
  return json({
    installation: serializeAppInstallation(updated),
    ...(exportedEvent
      ? { event: serializeInstallationEvent(exportedEvent) }
      : materializeSucceededEvent
      ? { event: serializeInstallationEvent(materializeSucceededEvent) }
      : failedOperationEvent
      ? { event: serializeInstallationEvent(failedOperationEvent) }
      : {}),
  });
}

export async function handleUninstallAppInstallation(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const body = await readOptionalJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return errorJson("installation_not_found", "installation not found", 404);

  const existingEvents = await input.store.listInstallationEvents(
    input.installationId,
  );
  const existingUninstallEvent = [...existingEvents].reverse().find((event) =>
    event.eventType === installationUninstalledEvent
  );
  const grants = await input.store.listAppGrantsForInstallation(
    input.installationId,
  );
  const activeGrants = grants.filter((grant) => !grant.revokedAt);
  const now = Date.now();
  const reason = stringValue(body.reason);
  let updated = installation;
  let statusEvent: InstallationEventRecord | undefined;

  if (
    installation.status === "installing" || installation.status === "ready"
  ) {
    updated = transitionAppInstallationStatus(installation, "suspended", now);
    await input.store.saveAppInstallation(updated);
    statusEvent = await appendLedgerEvent(input.store, {
      installationId: input.installationId,
      eventType: "installation.status_changed",
      payload: {
        from: installation.status,
        to: updated.status,
        reason: reason ?? "uninstall requested",
      },
      now: updated.updatedAt,
    });
  }

  const revokedGrants: AppGrantRecord[] = [];
  for (const grant of activeGrants) {
    const revoked = { ...grant, revokedAt: now };
    await input.store.saveAppGrant(revoked);
    revokedGrants.push(revoked);
    await appendLedgerEvent(input.store, {
      installationId: input.installationId,
      eventType: "permission_scope.revoked",
      payload: {
        permissionScopeId: grant.grantId,
        capability: grant.capability,
      },
      now,
    });
  }

  const shouldAppendUninstallEvent = Boolean(statusEvent) ||
    revokedGrants.length > 0 || !existingUninstallEvent;
  if (!statusEvent && shouldAppendUninstallEvent) {
    updated = { ...installation, updatedAt: now };
    await input.store.saveAppInstallation(updated);
  }
  const uninstallEvent = shouldAppendUninstallEvent
    ? await appendLedgerEvent(input.store, {
      installationId: input.installationId,
      eventType: installationUninstalledEvent,
      payload: {
        from: installation.status,
        to: updated.status,
        reason,
        retainedLedger: true,
        revokedPermissionScopeIds: revokedGrants.map((grant) => grant.grantId),
      },
      now: updated.updatedAt,
    })
    : existingUninstallEvent;

  return json({
    installation: serializeAppInstallation(updated),
    revoked_permission_scopes: revokedGrants.map(serializeAppGrant),
    ...(statusEvent
      ? { status_event: serializeInstallationEvent(statusEvent) }
      : {}),
    ...(uninstallEvent
      ? { event: serializeInstallationEvent(uninstallEvent) }
      : {}),
  });
}

export async function handleUpdateAppInstallationRevision(input: {
  installationId: string;
  operation: "deployment" | "rollback";
  request: Request;
  store: AccountsStore;
  deployControl?: DeployControlProxyOptions;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return errorJson("installation_not_found", "installation not found", 404);
  if (installation.status !== "ready") {
    return errorJson("state_conflict", `${input.operation} requires a ready AppInstallation`, 409);
  }
  if (input.deployControl) {
    return await handleCoreDeployControlBackedRevision({
      installationId: input.installationId,
      operation: input.operation,
      body,
      store: input.store,
      deployControl: input.deployControl,
      installation,
    });
  }

  const source = isRecord(body.source) ? body.source : {};
  const sourceGitUrl = stringValue(source.gitUrl) ??
    stringValue(source.url) ?? installation.sourceGitUrl;
  const sourceRef = stringValue(source.ref) ?? stringValue(body.ref) ??
    stringValue(body.to);
  const sourceCommit = stringValue(source.commit) ??
    stringValue(body.sourceCommit);
  const planDigest = stringValue(source.planDigest) ??
    stringValue(body.planDigest);
  const artifactDigest = stringValue(source.artifactDigest) ??
    stringValue(body.artifactDigest);
  if (!sourceRef || !sourceCommit || !planDigest) {
    return errorJson("invalid_request", "source.ref, source.commit, and source.planDigest are required", 400);
  }
  if (
    normalizeSourceGitUrl(sourceGitUrl) !==
      normalizeSourceGitUrl(installation.sourceGitUrl)
  ) {
    return errorJson("source_mismatch", "deployment and rollback must keep the installation source git URL", 409);
  }
  const appId = stringValue(body.appId);
  if (appId && appId !== installation.appId) {
    return errorJson("app_mismatch", "deployment and rollback must keep the installation appId", 409);
  }

  const now = Date.now();
  const requestedBindings = appBindingRecordsFromValue({
    value: body.useEdges,
    installationId: input.installationId,
    now,
  });
  if (requestedBindings instanceof Response) return requestedBindings;
  const requestedGrants = appGrantRecordsFromValue({
    value: body.permissionScopes,
    installationId: input.installationId,
    now,
  });
  if (requestedGrants instanceof Response) return requestedGrants;

  const confirmResult = await appInstallationRevisionConfirmFromValue({
    value: body.confirm,
    operation: input.operation,
    installationId: input.installationId,
    appId: installation.appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    planDigest,
    artifactDigest: artifactDigest ?? null,
    requestedBindings,
    requestedGrants,
  });
  if (confirmResult instanceof Response) return confirmResult;

  const updated: InstallationRecord = {
    ...installation,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    planDigest,
    ...(artifactDigest
      ? { artifactDigest }
      : { artifactDigest: undefined }),
    updatedAt: now,
  };
  await input.store.saveAppInstallation(updated);
  const event = await appendLedgerEvent(input.store, {
    installationId: input.installationId,
    eventType: input.operation === "deployment"
      ? "installation.deployed"
      : "installation.rolled_back",
    payload: {
      reason: stringValue(body.reason),
      confirm: confirmResult,
      previous: appInstallationRevisionPayload(installation),
      next: appInstallationRevisionPayload(updated),
      requestedUseEdges: requestedBindings.map(serializeAppBinding),
      requestedPermissionScopes: requestedGrants.map(serializeAppGrant),
    },
    now,
  });

  const bindings = await input.store.listAppBindingsForInstallation(
    input.installationId,
  );
  const grants = await input.store.listAppGrantsForInstallation(
    input.installationId,
  );
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installationId,
  );
  const runtimeBinding = updated.runtimeBindingId
    ? await input.store.findRuntimeBinding(updated.runtimeBindingId)
    : undefined;
  const events = await input.store.listInstallationEvents(input.installationId);
  return json({
    ...installationEnvelope({
      installation: updated,
      bindings,
      grants,
      oidcClient,
      runtimeBinding,
      activatedHttpDomain: activatedHttpDomainProjectionFromEvents(events),
      eventsUrl: takosumiAccountsInstallationEventsPath(input.installationId),
    }),
    operation: input.operation,
    event: serializeInstallationEvent(event),
  });
}

async function handleCoreDeployControlBackedRevision(input: {
  installationId: string;
  operation: "deployment" | "rollback";
  body: Record<string, unknown>;
  store: AccountsStore;
  deployControl: DeployControlProxyOptions;
  installation: InstallationRecord;
}): Promise<Response> {
  const now = Date.now();
  const source = isRecord(input.body.source) ? input.body.source : undefined;
  const expected = isRecord(input.body.expected)
    ? input.body.expected
    : undefined;

  if (input.operation === "rollback") {
    const coreRollback = await rollbackCoreDeploymentForCloudProjection({
      deployControl: input.deployControl,
      installationId: input.installationId,
      deploymentId: stringValue(input.body.deploymentId) ??
        stringValue(input.body.deployment_id),
      planRunId: stringValue(input.body.planRunId) ??
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
    await input.store.saveAppInstallation(updated);
    const event = await appendLedgerEvent(input.store, {
      installationId: input.installationId,
      eventType: "installation.rolled_back",
      payload: {
        reason: stringValue(input.body.reason),
        previous: appInstallationRevisionPayload(input.installation),
        next: appInstallationRevisionPayload(updated),
        coreDeployment: {
          id: coreRollback.deploymentId,
          rollback: isRecord(coreRollback.payload) &&
              isRecord(coreRollback.payload.rollback)
            ? coreRollback.payload.rollback
            : undefined,
        },
      },
      now,
    });
    await appendLedgerEvent(input.store, {
      installationId: input.installationId,
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

  const sourceGitUrl = stringValue(source?.url) ?? input.installation.sourceGitUrl;
  const sourceRef = stringValue(source?.ref) ?? stringValue(input.body.ref) ??
    stringValue(input.body.to);
  const sourceCommit = stringValue(expected?.sourceCommit) ??
    stringValue(source?.commit) ?? stringValue(input.body.sourceCommit);
  const planDigest = stringValue(expected?.planDigest) ??
    stringValue(source?.planDigest) ??
    stringValue(input.body.planDigest);
  const artifactDigest = stringValue(source?.artifactDigest) ??
    stringValue(input.body.artifactDigest);
  if (!sourceRef || !sourceCommit || !planDigest) {
    return errorJson("invalid_request", "deployment through Takosumi deploy control requires source.ref plus expected.sourceCommit and expected.planDigest", 400);
  }
  if (
    normalizeSourceGitUrl(sourceGitUrl) !==
      normalizeSourceGitUrl(input.installation.sourceGitUrl)
  ) {
    return errorJson("source_mismatch", "deployment must keep the installation source git URL", 409);
  }
  const appId = stringValue(input.body.appId);
  if (appId && appId !== input.installation.appId) {
    return errorJson("app_mismatch", "deployment must keep the installation appId", 409);
  }

  const requestedBindings = appBindingRecordsFromValue({
    value: input.body.useEdges,
    installationId: input.installationId,
    now,
  });
  if (requestedBindings instanceof Response) return requestedBindings;
  const requestedGrants = appGrantRecordsFromValue({
    value: input.body.permissionScopes,
    installationId: input.installationId,
    now,
  });
  if (requestedGrants instanceof Response) return requestedGrants;
  const confirmResult = await appInstallationRevisionConfirmFromValue({
    value: input.body.confirm,
    operation: input.operation,
    installationId: input.installationId,
    appId: input.installation.appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    planDigest,
    artifactDigest: artifactDigest ?? null,
    requestedBindings,
    requestedGrants,
  });
  if (confirmResult instanceof Response) return confirmResult;

  const coreDeploy = await applyCoreDeploymentForCloudProjection({
    deployControl: input.deployControl,
    installationId: input.installationId,
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
      planDigest,
      artifactDigest,
    },
    now,
  });
  await input.store.saveAppInstallation(updated);
  const event = await appendLedgerEvent(input.store, {
    installationId: input.installationId,
    eventType: "installation.deployed",
    payload: {
      reason: stringValue(input.body.reason),
      confirm: confirmResult,
      previous: appInstallationRevisionPayload(input.installation),
      next: appInstallationRevisionPayload(updated),
      requestedUseEdges: requestedBindings.map(serializeAppBinding),
      requestedPermissionScopes: requestedGrants.map(serializeAppGrant),
      coreDeployment: { id: coreDeploy.deploymentId },
    },
    now,
  });
  await appendLedgerEvent(input.store, {
    installationId: input.installationId,
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
