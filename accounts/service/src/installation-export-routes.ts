/**
 * Export installation lifecycle routes (request / poll / download).
 *
 * Pure-move decomposition of the former installation-lifecycle-routes
 * god-file; behavior is identical to the prior single-file handlers.
 */
import { takosumiAccountsCapsuleExportOperationPath } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "./store.ts";
import {
  exportOperationBody,
  exportOperationBodyFromEvents,
  findIdempotentOperationEvent,
  findInFlightCapsuleOperation,
  findOperationEvent,
  idempotencyRequestConflict,
  installationExportFailedEvent,
  installationExportRequestedEvent,
  installationExportedEvent,
  installationOperationId,
  installationOperationRequestDigest,
  requiredIdempotencyKey,
  serializeCapsuleEvent,
} from "./installation-helpers.ts";
import { completeAppCapsuleExportWithWorker } from "./installation-materialize-helpers.ts";
import { publicCapsuleOperationErrorMessage } from "./installation-operation-errors.ts";
import {
  errorJson,
  isPlainRecord,
  json,
  readJsonObject,
  stringArrayValue,
  stringValue,
} from "./http-helpers.ts";
import type {
  AppCapsuleExportRequest,
  AppCapsuleExportWorker,
} from "./mod.ts";
import {
  exportDownloadUrl,
  readExportDownloadSigningSecretFromEnv,
  signExportDownloadUrl,
} from "./export-download-url.ts";
import { appendLedgerEvent } from "./installation-ledger-events.ts";

export async function handleRequestAppCapsuleExport(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
  exportWorker?: AppCapsuleExportWorker;
}): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(input.request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const body = await readJsonObject(input.request);
  if (!body || Array.isArray(body)) {
    return errorJson("invalid_request", "invalid request", 400);
  }

  const format =
    body.format === undefined ? "bundle" : stringValue(body.format);
  const encryption =
    body.encryption === undefined
      ? {}
      : isPlainRecord(body.encryption)
        ? body.encryption
        : undefined;
  const scope =
    body.scope === undefined
      ? {}
      : isPlainRecord(body.scope)
        ? body.scope
        : undefined;
  if (!encryption || !scope || format !== "bundle") {
    return errorJson(
      "invalid_request",
      "export requires format=bundle with object encryption and scope",
      400,
    );
  }
  if (body.includeData !== undefined && typeof body.includeData !== "boolean") {
    return errorJson(
      "invalid_request",
      "export includeData must be a boolean",
      400,
    );
  }
  const encryptionMethod =
    encryption.method === undefined ? "none" : stringValue(encryption.method);
  const encryptionRecipients =
    encryption.recipients === undefined
      ? []
      : stringArrayValue(encryption.recipients);
  if (
    !encryptionMethod ||
    !encryptionRecipients ||
    (encryptionMethod !== "none" && encryptionMethod !== "age") ||
    (encryptionMethod === "age" && encryptionRecipients.length === 0) ||
    (encryptionMethod === "none" && encryptionRecipients.length > 0)
  ) {
    return errorJson(
      "invalid_request",
      "export encryption.method must be none or age; age requires recipients and none forbids recipients",
      400,
    );
  }
  const includeData = body.includeData === true;
  if (includeData && encryptionMethod !== "age") {
    return errorJson(
      "invalid_request",
      "export includeData requires age encryption",
      400,
    );
  }
  const requestPayload: AppCapsuleExportRequest = {
    includeData,
    format: "bundle",
    encryption: {
      method: encryptionMethod,
      recipients: encryptionRecipients,
    },
    scope,
  };
  const requestDigest =
    await installationOperationRequestDigest(requestPayload);

  const installation = await input.store.findAppCapsule(
    input.capsuleId,
  );
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);

  const operationId = await installationOperationId({
    capsuleId: input.capsuleId,
    operation: "export",
    idempotencyKey,
  });
  const events = await input.store.listCapsuleEvents(input.capsuleId);
  const existing = findIdempotentOperationEvent({
    events,
    eventType: installationExportRequestedEvent,
    idempotencyKey,
  });
  if (existing) {
    const conflict = idempotencyRequestConflict(existing, requestDigest);
    if (conflict) return conflict;
    const existingOperationId =
      stringValue(existing.payload.operationId) ?? operationId;
    return json(
      exportOperationBodyFromEvents({
        capsuleId: input.capsuleId,
        operationId: existingOperationId,
        events,
      }),
      202,
      {
        location: takosumiAccountsCapsuleExportOperationPath(
          input.capsuleId,
          existingOperationId,
        ),
      },
    );
  }
  const inFlight = findInFlightCapsuleOperation(events);
  if (inFlight) {
    return errorJson(
      "installation_locked",
      `installation already has an in-flight ${inFlight.eventType} operation`,
      409,
    );
  }
  if (
    installation.status === "installing" ||
    installation.status === "exported"
  ) {
    return errorJson(
      "state_conflict",
      "export requires an installation that is not installing or exported",
      409,
    );
  }

  const now = Date.now();
  const event = await appendLedgerEvent(input.store, {
    capsuleId: input.capsuleId,
    eventType: installationExportRequestedEvent,
    payload: {
      operationId,
      idempotencyKey,
      requestDigest,
      ...requestPayload,
    },
    now,
  });
  const location = takosumiAccountsCapsuleExportOperationPath(
    input.capsuleId,
    operationId,
  );
  if (input.exportWorker) {
    const workerBody = await completeAppCapsuleExportWithWorker({
      store: input.store,
      installation,
      operationId,
      requestPayload,
      exportWorker: input.exportWorker,
    });
    return json(workerBody, 202, { location });
  }
  return json(
    {
      ...exportOperationBody(input.capsuleId, operationId),
      event: serializeCapsuleEvent(event),
    },
    202,
    { location },
  );
}

export async function handleGetAppCapsuleExportOperation(input: {
  capsuleId: string;
  operationId: string;
  store: AccountsStore;
}): Promise<Response> {
  const installation = await input.store.findAppCapsule(
    input.capsuleId,
  );
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  const events = await input.store.listCapsuleEvents(input.capsuleId);
  const event = events.find(
    (entry) =>
      entry.eventType === installationExportRequestedEvent &&
      entry.payload.operationId === input.operationId,
  );
  if (!event)
    return errorJson(
      "export_operation_not_found",
      "export operation not found",
      404,
    );
  const completed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportedEvent],
  });
  if (completed) {
    return json(
      exportOperationBody(input.capsuleId, input.operationId, {
        status: "exported",
        downloadUrl: stringValue(completed.payload.downloadUrl) ?? null,
        downloadExpiresAt:
          stringValue(completed.payload.downloadExpiresAt) ?? null,
        archiveDigest: stringValue(completed.payload.archiveDigest) ?? null,
      }),
    );
  }
  const failed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportFailedEvent],
  });
  if (failed) {
    return json(
      exportOperationBody(input.capsuleId, input.operationId, {
        status: "failed",
        downloadUrl: null,
        downloadExpiresAt: null,
        error: publicCapsuleOperationErrorMessage(
          failed.payload.error,
          "export failed",
        ),
      }),
    );
  }
  return json(exportOperationBody(input.capsuleId, input.operationId));
}

export async function handleDownloadAppCapsuleExport(input: {
  capsuleId: string;
  operationId: string;
  store: AccountsStore;
  /**
   * Optional override of the export download signing secret. When omitted
   * the handler reads `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET` via
   * `readExportDownloadSigningSecretFromEnv`.
   */
  exportDownloadSigningSecret?: string | Uint8Array;
}): Promise<Response> {
  const installation = await input.store.findAppCapsule(
    input.capsuleId,
  );
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  const events = await input.store.listCapsuleEvents(input.capsuleId);
  const event = events.find(
    (entry) =>
      entry.eventType === installationExportRequestedEvent &&
      entry.payload.operationId === input.operationId,
  );
  if (!event)
    return errorJson(
      "export_operation_not_found",
      "export operation not found",
      404,
    );
  const failed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportFailedEvent],
  });
  if (failed) {
    return errorJson(
      "export_failed",
      publicCapsuleOperationErrorMessage(
        failed.payload.error,
        "export failed",
      ),
      409,
    );
  }
  const completed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportedEvent],
  });
  if (!completed) {
    return errorJson(
      "export_not_ready",
      "export artifact is not ready for download",
      409,
    );
  }
  const downloadUrl = stringValue(completed.payload.downloadUrl);
  if (!downloadUrl)
    return errorJson(
      "export_artifact_not_found",
      "export artifact not found",
      404,
    );
  try {
    exportDownloadUrl(downloadUrl, "export download URL");
  } catch {
    return errorJson(
      "invalid_export_download_url",
      "invalid export download url",
      502,
    );
  }
  const recordedExpiresAt = stringValue(completed.payload.downloadExpiresAt);
  if (recordedExpiresAt) {
    const expiresAtMs = Date.parse(recordedExpiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return errorJson(
        "invalid_export_download_expiry",
        "invalid export download expiry",
        502,
      );
    }
    if (expiresAtMs <= Date.now()) {
      return errorJson(
        "export_download_expired",
        "export download expired",
        410,
      );
    }
  }
  const signingSecret =
    input.exportDownloadSigningSecret ??
    readExportDownloadSigningSecretFromEnv();
  if (!signingSecret) {
    return errorJson(
      "feature_unavailable",
      "export download signing secret is not configured; refusing to issue an unsigned redirect",
      503,
    );
  }
  try {
    const signed = await signExportDownloadUrl(downloadUrl, {
      secret: signingSecret,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: signed.url,
        "x-export-download-expires-at": signed.expiresAt,
      },
    });
  } catch {
    return errorJson(
      "invalid_export_download_url",
      "invalid export download url",
      502,
    );
  }
}
