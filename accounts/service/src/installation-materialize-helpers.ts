import type {
  ServiceBindingMaterialKind,
  AppInstallationMode,
  AppInstallationStatus,
  InstallationRecord,
  RuntimeBindingRecord,
} from "./ledger.ts";
import type { AccountsStore } from "./store.ts";
import { collectInstallationExportBundle } from "./export-bundle.ts";
import { exportDownloadUrl } from "./export-download-url.ts";
import {
  appendExportOperationCompletion,
  appendExportOperationFailure,
  appendLedgerEvent,
  canonicalJson,
  exportOperationBody,
  findOperationEvent,
  installationEventsTrackingUrl,
  installationMaterializeFailedEvent,
  installationMaterializeRequestedEvent,
  installationMaterializeSucceededEvent,
  isSha256DigestRef,
  nullableString,
  operationClosedEventTypes,
  operationRequestedEventType,
  serializeAppInstallation,
  serializeInstallationEvent,
  serializeRuntimeBinding,
} from "./installation-helpers.ts";
import {
  errorJson,
  isPlainRecord,
  isRecord,
  json,
  stringArrayValue,
  stringValue,
} from "./http-helpers.ts";
import type {
  AppInstallationExportRequest,
  AppInstallationExportWorker,
  AppInstallationExportWorkerResult,
  AppInstallationMaterializeContinuityEvidence,
  AppInstallationMaterializeRequest,
  AppInstallationMaterializeWorker,
  AppInstallationMaterializeWorkerResult,
} from "./mod.ts";
import { publicInstallationOperationErrorMessage } from "./installation-operation-errors.ts";

export function runtimeBindingFromValue(input: {
  value: unknown;
  installationId: string;
  mode: AppInstallationMode;
  now: number;
}): RuntimeBindingRecord | undefined {
  if (input.value === undefined) return undefined;
  if (!isRecord(input.value)) return undefined;
  const targetId = stringValue(input.value.targetId);
  if (!targetId) return undefined;
  const targetType =
    input.value.targetType === "dedicated" ||
    input.value.targetType === "self-hosted" ||
    input.value.targetType === "shared-cell"
      ? input.value.targetType
      : input.mode;
  return {
    runtimeBindingId:
      stringValue(input.value.runtimeTargetId) ?? `rtb_${crypto.randomUUID()}`,
    installationId: input.installationId,
    mode: input.mode,
    targetType,
    targetId,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function materializeAcceptedBody(input: {
  installation: InstallationRecord;
  operationId: string;
  region: string;
  preserve?: Record<string, unknown>;
  preserveDigest?: string;
}): Record<string, unknown> {
  return {
    operationId: input.operationId,
    installationId: input.installation.installationId,
    fromMode: input.installation.mode,
    toMode: "dedicated",
    region: input.region,
    ...(input.preserve ? { preserve: input.preserve } : {}),
    ...(input.preserveDigest ? { preserveDigest: input.preserveDigest } : {}),
    etaSeconds: 600,
    trackingUrl: installationEventsTrackingUrl(
      input.installation.installationId,
      [
        installationMaterializeRequestedEvent,
        installationMaterializeSucceededEvent,
        installationMaterializeFailedEvent,
      ],
    ),
  };
}

export async function materializePreservationSnapshot(input: {
  store: AccountsStore;
  installation: InstallationRecord;
}): Promise<Record<string, unknown>> {
  const runtimeBinding = input.installation.runtimeBindingId
    ? await input.store.findRuntimeBinding(input.installation.runtimeBindingId)
    : undefined;
  const bindings = await input.store.listServiceBindingMaterialsForInstallation(
    input.installation.installationId,
  );
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installation.installationId,
  );
  return {
    source: {
      gitUrl: input.installation.sourceGitUrl,
      ref: input.installation.sourceRef,
      commit: input.installation.sourceCommit,
      planDigest: input.installation.planDigest,
      artifactDigest: input.installation.artifactDigest ?? null,
    },
    dataNamespace: runtimeBinding?.targetId ?? null,
    billingAccountId: input.installation.billingAccountId ?? null,
    runtimeTarget: runtimeBinding
      ? {
          id: runtimeBinding.runtimeBindingId,
          mode: runtimeBinding.mode,
          targetType: runtimeBinding.targetType,
          targetId: runtimeBinding.targetId,
        }
      : null,
    oidcClient: oidcClient
      ? {
          clientId: oidcClient.clientId,
          namespacePath: oidcClient.namespacePath,
          issuerUrl: oidcClient.issuerUrl,
          redirectUris: [...oidcClient.redirectUris],
          allowedScopes: [...oidcClient.allowedScopes],
          subjectMode: oidcClient.subjectMode,
          tokenEndpointAuthMethod: oidcClient.tokenEndpointAuthMethod,
        }
      : null,
    serviceBindings: bindings
      .filter((binding) => isMaterializePreservedBindingKind(binding.kind))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((binding) => ({
        name: binding.name,
        kind: binding.kind,
        configRef: binding.configRef,
        secretRefs: [...binding.secretRefs],
      })),
  };
}

export function isMaterializePreservedBindingKind(
  kind: ServiceBindingMaterialKind,
): boolean {
  return (
    kind === "identity.oidc" ||
    kind === "storage.sql" ||
    kind === "storage.object" ||
    kind === "protocol.http.api"
  );
}

export async function completeAppInstallationMaterializeWithWorker(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  operationId: string;
  requestPayload: AppInstallationMaterializeRequest;
  preserve: Record<string, unknown>;
  preserveDigest: string;
  materializeWorker: AppInstallationMaterializeWorker;
}): Promise<Record<string, unknown>> {
  let result: AppInstallationMaterializeWorkerResult;
  try {
    result = await input.materializeWorker({
      installation: input.installation,
      operationId: input.operationId,
      request: input.requestPayload,
      preserve: input.preserve,
      preserveDigest: input.preserveDigest,
    });
  } catch {
    return await materializeOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "materialize worker failed",
    });
  }

  const returnedPreserveDigest =
    stringValue(result.preserveDigest) ?? input.preserveDigest;
  if (returnedPreserveDigest !== input.preserveDigest) {
    return await materializeOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "materialize worker returned mismatched preserveDigest",
    });
  }

  const now = Date.now();
  const runtimeBinding = runtimeBindingFromValue({
    value: result.runtimeTarget,
    installationId: input.installation.installationId,
    mode: "dedicated",
    now,
  });
  if (!runtimeBinding || runtimeBinding.targetType !== "dedicated") {
    return await materializeOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "materialize worker did not return a dedicated runtime target",
    });
  }
  const continuityError = validateMaterializeContinuity({
    preserve: input.preserve,
    runtimeBinding,
    evidence: result.continuity,
  });
  if (continuityError) {
    return await materializeOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: continuityError,
    });
  }

  const updated: InstallationRecord = {
    ...input.installation,
    mode: "dedicated",
    runtimeBindingId: runtimeBinding.runtimeBindingId,
    status: "ready",
    updatedAt: now,
  };
  await input.store.saveRuntimeBinding(runtimeBinding);
  await input.store.saveAppInstallation(updated);
  const event = await appendLedgerEvent(input.store, {
    installationId: input.installation.installationId,
    eventType: installationMaterializeSucceededEvent,
    payload: {
      operationId: input.operationId,
      fromMode: input.installation.mode,
      toMode: "dedicated",
      runtimeTargetId: runtimeBinding.runtimeBindingId,
      preserveDigest: input.preserveDigest,
      reason: stringValue(result.reason) ?? "dedicated runtime ready",
    },
    now,
  });
  return {
    ...materializeAcceptedBody({
      installation: input.installation,
      operationId: input.operationId,
      region: input.requestPayload.region,
      preserve: input.preserve,
      preserveDigest: input.preserveDigest,
    }),
    status: "ready",
    installation: serializeAppInstallation(updated),
    runtime_target: serializeRuntimeBinding(runtimeBinding),
    event: serializeInstallationEvent(event),
  };
}

export async function materializeOperationFailedBody(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  operationId: string;
  error: string;
}): Promise<Record<string, unknown>> {
  const now = Date.now();
  const error = publicInstallationOperationErrorMessage(
    input.error,
    "materialize failed",
  );
  const event = await appendLedgerEvent(input.store, {
    installationId: input.installation.installationId,
    eventType: installationMaterializeFailedEvent,
    payload: {
      operationId: input.operationId,
      fromMode: input.installation.mode,
      toMode: "dedicated",
      runtimeTargetId: input.installation.runtimeBindingId ?? null,
      reason: error,
      error,
    },
    now,
  });
  return {
    operationId: input.operationId,
    installationId: input.installation.installationId,
    fromMode: input.installation.mode,
    toMode: "dedicated",
    status: "failed",
    trackingUrl: installationEventsTrackingUrl(
      input.installation.installationId,
      [
        installationMaterializeRequestedEvent,
        installationMaterializeSucceededEvent,
        installationMaterializeFailedEvent,
      ],
    ),
    error,
    event: serializeInstallationEvent(event),
  };
}

export function validateMaterializeContinuity(input: {
  preserve: Record<string, unknown>;
  runtimeBinding: RuntimeBindingRecord;
  evidence?: AppInstallationMaterializeContinuityEvidence;
}): string | undefined {
  if (!input.evidence || !isPlainRecord(input.evidence)) {
    return "materialize worker did not return continuity evidence";
  }
  if (!isPlainRecord(input.evidence.cutover)) {
    return "materialize worker continuity requires cutover evidence";
  }
  const expectedDataNamespace = nullableString(input.preserve.dataNamespace);
  if (input.evidence.sourceDataNamespace !== expectedDataNamespace) {
    return "materialize worker continuity sourceDataNamespace mismatch";
  }

  const expectedRuntimeTarget = isPlainRecord(input.preserve.runtimeTarget)
    ? nullableString(input.preserve.runtimeTarget.targetId)
    : null;
  if (input.evidence.cutover.fromTargetId !== expectedRuntimeTarget) {
    return "materialize worker continuity source runtime target mismatch";
  }
  if (input.evidence.cutover.toTargetId !== input.runtimeBinding.targetId) {
    return "materialize worker continuity dedicated runtime target mismatch";
  }
  if (input.evidence.cutover.ready !== true) {
    return "materialize worker continuity requires dedicated readiness";
  }

  const expectedOidcClient = isPlainRecord(input.preserve.oidcClient)
    ? input.preserve.oidcClient
    : null;
  if (
    canonicalJson(input.evidence.oidcClient) !==
    canonicalJson(expectedOidcClient)
  ) {
    return "materialize worker continuity OIDC client mismatch";
  }

  if (
    canonicalJson(
      normalizeContinuityBindings(input.evidence.preservedServiceBindings),
    ) !==
    canonicalJson(normalizeContinuityBindings(input.preserve.serviceBindings))
  ) {
    return "materialize worker continuity service binding refs mismatch";
  }
}

export function normalizeContinuityBindings(
  value: unknown,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainRecord)
    .map((binding) => ({
      name: stringValue(binding.name) ?? "",
      kind: stringValue(binding.kind) ?? "",
      configRef: stringValue(binding.configRef) ?? "",
      secretRefs: stringArrayValue(binding.secretRefs) ?? [],
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function completeAppInstallationExportWithWorker(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  operationId: string;
  requestPayload: AppInstallationExportRequest;
  exportWorker: AppInstallationExportWorker;
}): Promise<Record<string, unknown>> {
  const bundle = await collectInstallationExportBundle({
    store: input.store,
    installationId: input.installation.installationId,
  });
  if (!bundle) {
    return exportOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "installation export bundle could not be collected",
    });
  }

  let result: AppInstallationExportWorkerResult;
  try {
    result = await input.exportWorker({
      installation: input.installation,
      operationId: input.operationId,
      request: input.requestPayload,
      bundle,
    });
  } catch {
    return await exportOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "export worker failed",
    });
  }

  const downloadUrl = stringValue(result.downloadUrl);
  const downloadExpiresAt = stringValue(result.downloadExpiresAt);
  const archiveDigest = stringValue(result.archiveDigest);
  if (!downloadUrl) {
    return await exportOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "export worker did not return a downloadUrl",
    });
  }
  try {
    exportDownloadUrl(downloadUrl, "export worker downloadUrl");
  } catch {
    return await exportOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "export worker returned an unsupported downloadUrl",
    });
  }
  if (downloadExpiresAt && !Number.isFinite(Date.parse(downloadExpiresAt))) {
    return await exportOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "export worker returned an invalid downloadExpiresAt",
    });
  }
  if (archiveDigest && !isSha256DigestRef(archiveDigest)) {
    return await exportOperationFailedBody({
      store: input.store,
      installation: input.installation,
      operationId: input.operationId,
      error: "export worker returned an invalid archiveDigest",
    });
  }
  const event = await appendExportOperationCompletion({
    store: input.store,
    installation: input.installation,
    operationId: input.operationId,
    downloadUrl,
    downloadExpiresAt,
    archiveDigest,
  });
  return {
    ...exportOperationBody(
      input.installation.installationId,
      input.operationId,
      {
        status: "exported",
        downloadUrl,
        downloadExpiresAt: downloadExpiresAt ?? null,
        archiveDigest: archiveDigest ?? null,
      },
    ),
    event: serializeInstallationEvent(event),
  };
}

export async function exportOperationFailedBody(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  operationId: string;
  error: string;
}): Promise<Record<string, unknown>> {
  const error = publicInstallationOperationErrorMessage(
    input.error,
    "export failed",
  );
  const event = await appendExportOperationFailure({
    store: input.store,
    installation: input.installation,
    operationId: input.operationId,
    error,
  });
  return {
    ...exportOperationBody(
      input.installation.installationId,
      input.operationId,
      {
        status: "failed",
        downloadUrl: null,
        downloadExpiresAt: null,
        error,
      },
    ),
    event: serializeInstallationEvent(event),
  };
}

export async function materializeCompletionFromStatusPatch(input: {
  body: Record<string, unknown>;
  installation: InstallationRecord;
  requestedMode: AppInstallationMode;
  status: AppInstallationStatus;
  store: AccountsStore;
  now: number;
}): Promise<
  | {
      runtimeBinding?: RuntimeBindingRecord;
      runtimeBindingId: string;
      preserveDigest: string;
    }
  | Response
> {
  const operationId = stringValue(input.body.operationId);
  const expectedPreserveDigest =
    stringValue(input.body.preserveDigest) ??
    (isRecord(input.body.preserved)
      ? (stringValue(input.body.preserved.preserveDigest) ??
        stringValue(input.body.preserved.digest))
      : undefined);
  if (
    input.installation.status !== "ready" ||
    input.status !== "ready" ||
    input.installation.mode !== "shared-cell" ||
    input.requestedMode !== "dedicated" ||
    !operationId
  ) {
    return errorJson(
      "state_conflict",
      "materialize completion requires ready shared-cell -> dedicated with operationId",
      409,
    );
  }
  const events = await input.store.listInstallationEvents(
    input.installation.installationId,
  );
  const requested = findOperationEvent({
    events,
    operationId,
    eventTypes: [installationMaterializeRequestedEvent],
  });
  if (!requested) {
    return errorJson(
      "operation_not_found",
      "materialize completion requires a matching materialize request event",
      409,
    );
  }
  const requestedPreserveDigest = stringValue(requested.payload.preserveDigest);
  if (
    !requestedPreserveDigest ||
    expectedPreserveDigest !== requestedPreserveDigest
  ) {
    return errorJson(
      "preservation_mismatch",
      "materialize completion requires preserveDigest from the materialize request",
      409,
    );
  }
  const closed = findOperationEvent({
    events,
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
  const runtimeBinding = runtimeBindingFromValue({
    value: input.body.runtimeTarget,
    installationId: input.installation.installationId,
    mode: input.requestedMode,
    now: input.now,
  });
  const runtimeBindingId =
    runtimeBinding?.runtimeBindingId ?? stringValue(input.body.runtimeTargetId);
  if (!runtimeBindingId) {
    return errorJson(
      "invalid_request",
      "materialize completion requires runtimeTarget or runtimeTargetId",
      400,
    );
  }
  if (runtimeBinding?.targetType !== "dedicated") {
    return errorJson(
      "invalid_runtime_target",
      "materialize completion requires a dedicated runtime target",
      400,
    );
  }
  return {
    runtimeBinding,
    runtimeBindingId,
    preserveDigest: requestedPreserveDigest,
  };
}

export async function validateOperationCompletionFromStatusPatch(input: {
  store: AccountsStore;
  installationId: string;
  operation: "materialize" | "export";
  operationId: string;
}): Promise<void | Response> {
  const events = await input.store.listInstallationEvents(input.installationId);
  const requested = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [operationRequestedEventType(input.operation)],
  });
  if (!requested) {
    return errorJson(
      "operation_not_found",
      `${input.operation} completion requires a matching request event`,
      409,
    );
  }
  const closed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: operationClosedEventTypes(input.operation),
  });
  if (closed) {
    return errorJson(
      "operation_already_closed",
      `${input.operation} operation already has a completion event`,
      409,
    );
  }
}
