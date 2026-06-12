/**
 * Export installation lifecycle routes (request / poll / download).
 *
 * Pure-move decomposition of the former installation-lifecycle-routes
 * god-file; behavior is identical to the prior single-file handlers.
 */
import {
  takosumiAccountsInstallationExportOperationPath,
} from "@takosjp/takosumi-accounts-contract";
import type {
  AccountsStore,
} from "./store.ts";
import {
  exportOperationBody,
  exportOperationBodyFromEvents,
  findIdempotentOperationEvent,
  findInFlightInstallationOperation,
  findOperationEvent,
  idempotencyRequestConflict,
  installationExportFailedEvent,
  installationExportRequestedEvent,
  installationExportedEvent,
  installationOperationId,
  installationOperationRequestDigest,
  requiredIdempotencyKey,
  serializeInstallationEvent,
} from "./installation-helpers.ts";
import {
  completeAppInstallationExportWithWorker,
} from "./installation-materialize-helpers.ts";
import {
  errorJson,
  isRecord,
  json,
  readJsonObject,
  stringArrayValue,
  stringValue,
} from "./http-helpers.ts";
import type {
  AppInstallationExportRequest,
  AppInstallationExportWorker,
} from "./mod.ts";
import {
  readExportDownloadSigningSecretFromEnv,
  signExportDownloadUrl,
} from "./export-archive.ts";
import {
  appendLedgerEvent,
} from "./installation-ledger-events.ts";

export async function handleRequestAppInstallationExport(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
  exportWorker?: AppInstallationExportWorker;
}): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(input.request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);

  const format = stringValue(body.format) ?? "bundle";
  const encryption = body.encryption === undefined
    ? {}
    : isRecord(body.encryption)
    ? body.encryption
    : undefined;
  const scope = body.scope === undefined
    ? {}
    : isRecord(body.scope)
    ? body.scope
    : undefined;
  if (!encryption || !scope || format !== "bundle") {
    return errorJson("invalid_request", "export requires format=bundle with object encryption and scope", 400);
  }
  const encryptionMethod = stringValue(encryption.method) ?? "none";
  const encryptionRecipients = stringArrayValue(encryption.recipients) ?? [];
  if (
    (encryptionMethod !== "none" && encryptionMethod !== "age") ||
    (encryptionMethod === "age" && encryptionRecipients.length === 0)
  ) {
    return errorJson("invalid_request", "export encryption.method must be none or age; age requires recipients", 400);
  }
  const requestPayload: AppInstallationExportRequest = {
    includeData: body.includeData === true,
    format: "bundle",
    encryption: {
      method: encryptionMethod,
      recipients: encryptionRecipients,
    },
    scope,
  };
  const requestDigest = await installationOperationRequestDigest(
    requestPayload,
  );

  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return errorJson("installation_not_found", "installation not found", 404);

  const operationId = await installationOperationId({
    installationId: input.installationId,
    operation: "export",
    idempotencyKey,
  });
  const events = await input.store.listInstallationEvents(
    input.installationId,
  );
  const existing = findIdempotentOperationEvent({
    events,
    eventType: installationExportRequestedEvent,
    idempotencyKey,
  });
  if (existing) {
    const conflict = idempotencyRequestConflict(existing, requestDigest);
    if (conflict) return conflict;
    const existingOperationId = stringValue(existing.payload.operationId) ??
      operationId;
    return json(
      exportOperationBodyFromEvents({
        installationId: input.installationId,
        operationId: existingOperationId,
        events,
      }),
      202,
      {
        location: takosumiAccountsInstallationExportOperationPath(
          input.installationId,
          existingOperationId,
        ),
      },
    );
  }
  const inFlight = findInFlightInstallationOperation(events);
  if (inFlight) {
    return errorJson("installation_locked", `installation already has an in-flight ${inFlight.eventType} operation`, 409);
  }
  if (
    installation.status === "installing" || installation.status === "exported"
  ) {
    return errorJson("state_conflict", "export requires an installation that is not installing or exported", 409);
  }

  const now = Date.now();
  const event = await appendLedgerEvent(input.store, {
    installationId: input.installationId,
    eventType: installationExportRequestedEvent,
    payload: {
      operationId,
      idempotencyKey,
      requestDigest,
      ...requestPayload,
    },
    now,
  });
  const location = takosumiAccountsInstallationExportOperationPath(
    input.installationId,
    operationId,
  );
  if (input.exportWorker) {
    const workerBody = await completeAppInstallationExportWithWorker({
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
      ...exportOperationBody(input.installationId, operationId),
      event: serializeInstallationEvent(event),
    },
    202,
    { location },
  );
}

export async function handleGetAppInstallationExportOperation(input: {
  installationId: string;
  operationId: string;
  store: AccountsStore;
}): Promise<Response> {
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return errorJson("installation_not_found", "installation not found", 404);
  const events = await input.store.listInstallationEvents(input.installationId);
  const event = events.find((entry) =>
    entry.eventType === installationExportRequestedEvent &&
    entry.payload.operationId === input.operationId
  );
  if (!event) return errorJson("export_operation_not_found", "export operation not found", 404);
  const completed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportedEvent],
  });
  if (completed) {
    return json(exportOperationBody(input.installationId, input.operationId, {
      status: "exported",
      downloadUrl: stringValue(completed.payload.downloadUrl) ?? null,
      downloadExpiresAt: stringValue(completed.payload.downloadExpiresAt) ??
        null,
    }));
  }
  const failed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportFailedEvent],
  });
  if (failed) {
    return json(exportOperationBody(input.installationId, input.operationId, {
      status: "failed",
      downloadUrl: null,
      downloadExpiresAt: null,
      error: stringValue(failed.payload.error) ?? "export failed",
    }));
  }
  return json(exportOperationBody(input.installationId, input.operationId));
}

export async function handleDownloadAppInstallationExport(input: {
  installationId: string;
  operationId: string;
  store: AccountsStore;
  /**
   * Optional override of the export download signing secret. When omitted
   * the handler reads `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET` via
   * `readExportDownloadSigningSecretFromEnv`.
   */
  exportDownloadSigningSecret?: string | Uint8Array;
}): Promise<Response> {
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return errorJson("installation_not_found", "installation not found", 404);
  const events = await input.store.listInstallationEvents(input.installationId);
  const event = events.find((entry) =>
    entry.eventType === installationExportRequestedEvent &&
    entry.payload.operationId === input.operationId
  );
  if (!event) return errorJson("export_operation_not_found", "export operation not found", 404);
  const failed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportFailedEvent],
  });
  if (failed) {
    return errorJson("export_failed", stringValue(failed.payload.error) ?? "export failed", 409);
  }
  const completed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportedEvent],
  });
  if (!completed) {
    return errorJson("export_not_ready", "export artifact is not ready for download", 409);
  }
  const downloadUrl = stringValue(completed.payload.downloadUrl);
  if (!downloadUrl) return errorJson("export_artifact_not_found", "export artifact not found", 404);
  try {
    const url = new URL(downloadUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError("unsupported protocol");
    }
  } catch {
    return errorJson("invalid_export_download_url", "invalid export download url", 502);
  }
  const recordedExpiresAt = stringValue(completed.payload.downloadExpiresAt);
  if (recordedExpiresAt) {
    const expiresAtMs = Date.parse(recordedExpiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return errorJson("invalid_export_download_expiry", "invalid export download expiry", 502);
    }
    if (expiresAtMs <= Date.now()) {
      return errorJson("export_download_expired", "export download expired", 410);
    }
  }
  const signingSecret = input.exportDownloadSigningSecret ??
    readExportDownloadSigningSecretFromEnv();
  if (!signingSecret) {
    return errorJson("feature_unavailable", "export download signing secret is not configured; refusing to issue an unsigned redirect", 503);
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
    return errorJson("invalid_export_download_url", "invalid export download url", 502);
  }
}
