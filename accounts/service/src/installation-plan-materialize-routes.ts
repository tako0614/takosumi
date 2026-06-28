/**
 * Plan / materialize / usage installation lifecycle routes.
 *
 * Pure-move decomposition of the former installation-lifecycle-routes
 * god-file; behavior is identical to the prior single-file handlers.
 */
import type {
  AccountsStore,
  BillingUsageRecord,
  TokenRecord,
} from "./store.ts";
import { constantTimeEqual, sha256HexText } from "./encoding.ts";
import {
  appCapsuleMaterializeDigest,
  findIdempotentOperationEvent,
  findInFlightCapsuleOperation,
  idempotencyRequestConflict,
  installationMaterializeRequestedEvent,
  installationOperationId,
  installationOperationRequestDigest,
  isMeteredBindingKind,
  isSha256HexDigest,
  requiredIdempotencyKey,
  serializeServiceBindingMaterial,
  serializeServiceGrantMaterial,
  serializeBillingUsageRecord,
  serializeCapsuleEvent,
} from "./installation-helpers.ts";
import {
  completeAppCapsuleMaterializeWithWorker,
  materializeAcceptedBody,
  materializePreservationSnapshot,
} from "./installation-materialize-helpers.ts";
import { requireCapsuleAccessTokenCapability } from "./installation-routes-internal.ts";
import {
  errorJson,
  isPlainRecord,
  isRecord,
  json,
  readJsonObject,
  stringValue,
} from "./http-helpers.ts";
import type {
  AppCapsuleMaterializeRequest,
  AppCapsuleMaterializeWorker,
} from "./mod.ts";
import { usageMeterNameLeaksInternalWorkersBackend } from "takosumi-contract/billing";
import type { DeployControlFacadeOptions } from "./deploy-control-facade.ts";
import { appendLedgerEvent } from "./installation-ledger-events.ts";
import {
  serviceBindingMaterialRecordsFromValue,
  serviceGrantMaterialRecordsFromValue,
  appCapsuleRevisionPermissionDigest,
  normalizeSourceGitUrl,
  planCoreDeploymentForCloudProjection,
} from "./installation-lifecycle-shared.ts";

export async function handlePlanAppCapsuleDeployment(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
  deployControl?: DeployControlFacadeOptions;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const installation = await input.store.findAppCapsule(
    input.capsuleId,
  );
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (installation.status !== "ready") {
    return errorJson(
      "state_conflict",
      "deployment PlanRun requires a ready Capsule projection",
      409,
    );
  }
  if (input.deployControl) {
    const source = isRecord(body.source) ? body.source : undefined;
    const corePlanRun = await planCoreDeploymentForCloudProjection({
      deployControl: input.deployControl,
      capsuleId: input.capsuleId,
      source,
    });
    if (corePlanRun instanceof Response) return corePlanRun;
    const sourceGitUrl =
      corePlanRun.sourceUrl ??
      stringValue(source?.gitUrl) ??
      stringValue(source?.url) ??
      installation.sourceGitUrl;
    const sourceRef =
      corePlanRun.sourceRef ??
      stringValue(source?.ref) ??
      stringValue(body.ref) ??
      stringValue(body.to) ??
      installation.sourceRef;
    const sourceCommit =
      corePlanRun.sourceCommit ??
      corePlanRun.sourceDigest ??
      stringValue(source?.commit) ??
      stringValue(body.sourceCommit) ??
      installation.sourceCommit;
    const sourcePath =
      corePlanRun.sourcePath ??
      stringValue(source?.path) ??
      stringValue(source?.modulePath) ??
      installation.sourcePath;
    const planDigest = corePlanRun.planDigest;
    const artifactDigest =
      corePlanRun.artifactDigest ??
      stringValue(source?.artifactDigest) ??
      stringValue(body.artifactDigest) ??
      null;
    if (
      normalizeSourceGitUrl(sourceGitUrl) !==
      normalizeSourceGitUrl(installation.sourceGitUrl)
    ) {
      return errorJson(
        "source_mismatch",
        "deployment PlanRun must keep the installation source git URL",
        409,
      );
    }
    if (
      installation.sourcePath &&
      sourcePath &&
      sourcePath !== installation.sourcePath
    ) {
      return errorJson(
        "source_path_mismatch",
        "deployment PlanRun must keep the installation source path",
        409,
      );
    }
    const appId = stringValue(body.appId);
    if (appId && appId !== installation.appId) {
      return errorJson(
        "app_mismatch",
        "deployment PlanRun must keep the installation appId",
        409,
      );
    }

    const now = Date.now();
    const requestedBindings = serviceBindingMaterialRecordsFromValue({
      value: body.serviceBindings,
      capsuleId: input.capsuleId,
      now,
    });
    if (requestedBindings instanceof Response) return requestedBindings;
    const requestedGrants = serviceGrantMaterialRecordsFromValue({
      value: body.serviceGrants,
      capsuleId: input.capsuleId,
      now,
    });
    if (requestedGrants instanceof Response) return requestedGrants;

    const permissionDigest = await appCapsuleRevisionPermissionDigest({
      operation: "deployment",
      capsuleId: input.capsuleId,
      appId: installation.appId,
      sourceGitUrl,
      sourceRef,
      sourceCommit,
      ...(sourcePath ? { sourcePath } : {}),
      planDigest,
      artifactDigest,
      requestedBindings,
      requestedGrants,
    });

    return json({
      operation: "deployment",
      capsuleId: input.capsuleId,
      source: {
        url: sourceGitUrl,
        ref: sourceRef,
        commit: sourceCommit,
        ...(sourcePath ? { path: sourcePath } : {}),
        planDigest,
        artifactDigest,
      },
      requestedServiceBindings: requestedBindings.map(
        serializeServiceBindingMaterial,
      ),
      requestedServiceGrants: requestedGrants.map(
        serializeServiceGrantMaterial,
      ),
      changes:
        isRecord(corePlanRun.payload) &&
        Array.isArray(corePlanRun.payload.changes)
          ? corePlanRun.payload.changes
          : [],
      expected: {
        ...(corePlanRun.expected ?? {}),
        permissionDigest,
        costAckRequired: requestedBindings.some((binding) =>
          isMeteredBindingKind(binding.kind),
        ),
      },
    });
  }

  const source = isRecord(body.source) ? body.source : {};
  const sourceGitUrl =
    stringValue(source.gitUrl) ??
    stringValue(source.url) ??
    installation.sourceGitUrl;
  const sourceRef =
    stringValue(source.ref) ?? stringValue(body.ref) ?? stringValue(body.to);
  const sourceCommit =
    stringValue(source.commit) ?? stringValue(body.sourceCommit);
  const sourcePath =
    stringValue(source.path) ??
    stringValue(source.modulePath) ??
    installation.sourcePath;
  const planDigest =
    stringValue(source.planDigest) ?? stringValue(body.planDigest);
  const artifactDigest =
    stringValue(source.artifactDigest) ?? stringValue(body.artifactDigest);
  if (!sourceRef || !sourceCommit || !planDigest) {
    return errorJson(
      "invalid_request",
      "source.ref, source.commit, and source.planDigest are required",
      400,
    );
  }
  if (
    normalizeSourceGitUrl(sourceGitUrl) !==
    normalizeSourceGitUrl(installation.sourceGitUrl)
  ) {
    return errorJson(
      "source_mismatch",
      "deployment PlanRun must keep the installation source git URL",
      409,
    );
  }
  if (
    installation.sourcePath &&
    sourcePath &&
    sourcePath !== installation.sourcePath
  ) {
    return errorJson(
      "source_path_mismatch",
      "deployment PlanRun must keep the installation source path",
      409,
    );
  }
  const appId = stringValue(body.appId);
  if (appId && appId !== installation.appId) {
    return errorJson(
      "app_mismatch",
      "deployment PlanRun must keep the installation appId",
      409,
    );
  }

  const now = Date.now();
  const requestedBindings = serviceBindingMaterialRecordsFromValue({
    value: body.serviceBindings,
    capsuleId: input.capsuleId,
    now,
  });
  if (requestedBindings instanceof Response) return requestedBindings;
  const requestedGrants = serviceGrantMaterialRecordsFromValue({
    value: body.serviceGrants,
    capsuleId: input.capsuleId,
    now,
  });
  if (requestedGrants instanceof Response) return requestedGrants;

  const permissionDigest = await appCapsuleRevisionPermissionDigest({
    operation: "deployment",
    capsuleId: input.capsuleId,
    appId: installation.appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    ...(sourcePath ? { sourcePath } : {}),
    planDigest,
    artifactDigest: artifactDigest ?? null,
    requestedBindings,
    requestedGrants,
  });

  return json({
    operation: "deployment",
    capsuleId: input.capsuleId,
    source: {
      gitUrl: sourceGitUrl,
      ref: sourceRef,
      commit: sourceCommit,
      ...(sourcePath ? { path: sourcePath } : {}),
      planDigest,
      artifactDigest: artifactDigest ?? null,
    },
    requestedServiceBindings: requestedBindings.map(
      serializeServiceBindingMaterial,
    ),
    requestedServiceGrants: requestedGrants.map(serializeServiceGrantMaterial),
    expected: {
      permissionDigest,
      costAckRequired: requestedBindings.some((binding) =>
        isMeteredBindingKind(binding.kind),
      ),
    },
  });
}

export async function handleRequestAppCapsuleMaterialize(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
  materializeWorker?: AppCapsuleMaterializeWorker;
}): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(input.request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);

  const region = stringValue(body.region);
  const plan =
    body.plan === undefined ? {} : isRecord(body.plan) ? body.plan : undefined;
  const cutover =
    body.cutover === undefined
      ? {}
      : isRecord(body.cutover)
        ? body.cutover
        : undefined;
  const confirm = isRecord(body.confirm) ? body.confirm : undefined;
  if (
    body.mode !== "dedicated" ||
    !region ||
    !plan ||
    !cutover ||
    confirm?.costAck !== true
  ) {
    return errorJson(
      "invalid_request",
      "materialize requires mode=dedicated, region, object plan/cutover, and confirm.costAck=true",
      400,
    );
  }
  const permissionDigest = stringValue(
    confirm.permissionDigest ?? confirm.permission_digest,
  );
  const expectedPermissionDigest = await appCapsuleMaterializeDigest({
    capsuleId: input.capsuleId,
    mode: "dedicated",
    region,
    plan,
    cutover,
  });
  if (!permissionDigest || !isSha256HexDigest(permissionDigest)) {
    return errorJson(
      "invalid_confirm",
      "materialize confirm.permissionDigest=sha256:<64-hex> is required",
      400,
    );
  }
  if (!constantTimeEqual(permissionDigest, expectedPermissionDigest)) {
    return errorJson(
      "approval_digest_mismatch",
      "confirm.permissionDigest does not match materialize request",
      409,
    );
  }
  const requestPayload: AppCapsuleMaterializeRequest = {
    mode: "dedicated",
    region,
    plan,
    cutover,
    confirm: {
      costAck: true,
      permissionDigest,
    },
  };
  const requestDigest =
    await installationOperationRequestDigest(requestPayload);

  const installation = await input.store.findAppCapsule(
    input.capsuleId,
  );
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  const preserve = await materializePreservationSnapshot({
    store: input.store,
    installation,
  });
  const preserveDigest = await installationOperationRequestDigest(preserve);

  const operationId = await installationOperationId({
    capsuleId: input.capsuleId,
    operation: "materialize",
    idempotencyKey,
  });
  const events = await input.store.listCapsuleEvents(input.capsuleId);
  const existing = findIdempotentOperationEvent({
    events,
    eventType: installationMaterializeRequestedEvent,
    idempotencyKey,
  });
  if (existing) {
    const conflict = idempotencyRequestConflict(existing, requestDigest);
    if (conflict) return conflict;
    const existingPreserve = isRecord(existing.payload.preserve)
      ? existing.payload.preserve
      : preserve;
    const existingPreserveDigest =
      stringValue(existing.payload.preserveDigest) ??
      (await installationOperationRequestDigest(existingPreserve));
    return json(
      materializeAcceptedBody({
        installation,
        operationId: stringValue(existing.payload.operationId) ?? operationId,
        region: stringValue(existing.payload.region) ?? region,
        preserve: existingPreserve,
        preserveDigest: existingPreserveDigest,
      }),
      202,
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
  if (installation.status !== "ready" || installation.mode !== "shared-cell") {
    return errorJson(
      "state_conflict",
      "materialize requires a ready shared-cell Capsule projection",
      409,
    );
  }

  const now = Date.now();
  const event = await appendLedgerEvent(input.store, {
    capsuleId: input.capsuleId,
    eventType: installationMaterializeRequestedEvent,
    payload: {
      operationId,
      idempotencyKey,
      fromMode: installation.mode,
      toMode: "dedicated",
      requestDigest,
      preserve,
      preserveDigest,
      ...requestPayload,
    },
    now,
  });
  if (input.materializeWorker) {
    const workerBody = await completeAppCapsuleMaterializeWithWorker({
      store: input.store,
      installation,
      operationId,
      requestPayload,
      preserve,
      preserveDigest,
      materializeWorker: input.materializeWorker,
    });
    return json(workerBody, 202);
  }
  return json(
    {
      ...materializeAcceptedBody({
        installation,
        operationId,
        region,
        preserve,
        preserveDigest,
      }),
      event: serializeCapsuleEvent(event),
    },
    202,
  );
}

export async function handleReportCapsuleBillingUsage(input: {
  capsuleId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const billingAuth = await requireCapsuleAccessTokenCapability({
    request: input.request,
    store: input.store,
    capsuleId: input.capsuleId,
    capability: "billing.usage.report",
  });
  if (!billingAuth.ok) return billingAuth.response;
  const authRecord: TokenRecord = billingAuth.record;
  const installation = await input.store.findAppCapsule(
    input.capsuleId,
  );
  if (!installation)
    return errorJson("installation_not_found", "installation not found", 404);
  if (installation.status !== "ready") {
    return errorJson(
      "state_conflict",
      "usage reports require a ready Capsule projection",
      409,
    );
  }
  if (!installation.billingAccountId) {
    return errorJson(
      "billing_account_not_configured",
      "usage reports require an Capsule projection billingAccountId",
      409,
    );
  }

  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  const explicitBillingAccountId =
    stringValue(body.billingAccountId) ?? stringValue(body.billing_account_id);
  if (
    explicitBillingAccountId &&
    explicitBillingAccountId !== installation.billingAccountId
  ) {
    return errorJson(
      "billing_account_mismatch",
      "usage report billing account must match the Capsule projection",
      409,
    );
  }

  const meter = stringValue(body.meter);
  const quantity = positiveNumberValue(body.quantity);
  const unit = stringValue(body.unit);
  const periodStart = optionalTimestampValue(
    body.periodStart ?? body.period_start,
  );
  const periodEnd = optionalTimestampValue(body.periodEnd ?? body.period_end);
  const metadata =
    body.metadata === undefined
      ? {}
      : isPlainRecord(body.metadata) && isJsonValue(body.metadata)
        ? body.metadata
        : undefined;
  const idempotencyKey =
    stringValue(body.idempotencyKey) ?? stringValue(body.idempotency_key);
  const explicitReportId =
    stringValue(body.reportId) ?? stringValue(body.report_id);
  // When the caller supplies an idempotencyKey but no explicit reportId, derive
  // the usageReportId deterministically from `${capsuleId}:${idempotencyKey}`
  // so a concurrent duplicate (same key, no reportId) claims the SAME report id
  // and is deduped ATOMICALLY by the existing usageReportId claim
  // (D1 #putIfAbsentWithIndexes / Postgres ON CONFLICT (usage_report_id)),
  // instead of the previous non-atomic list-then-insert that double-billed under
  // concurrency. A random id is only used when neither reportId nor
  // idempotencyKey is present (no idempotency semantics requested).
  const derivedIdempotentReportId =
    explicitReportId === undefined && idempotencyKey !== undefined
      ? `usage_${(
          await sha256HexText(`${input.capsuleId}:${idempotencyKey}`)
        ).slice("sha256:".length)}`
      : undefined;
  const usageReportId =
    explicitReportId ??
    derivedIdempotentReportId ??
    `usage_${crypto.randomUUID()}`;
  if (
    !meter ||
    !/^[a-z][a-z0-9_.:-]{0,95}$/.test(meter) ||
    usageMeterNameLeaksInternalWorkersBackend(meter) ||
    quantity === undefined ||
    !unit ||
    unit.length > 32 ||
    periodStart === "invalid" ||
    periodEnd === "invalid" ||
    (periodStart !== undefined &&
      periodEnd !== undefined &&
      periodEnd < periodStart) ||
    metadata === undefined ||
    (idempotencyKey !== undefined && idempotencyKey.length > 160) ||
    !/^usage_[A-Za-z0-9_-]{8,160}$/.test(usageReportId)
  ) {
    return errorJson(
      "invalid_request",
      "reportId, meter, positive quantity, unit, optional period, idempotencyKey, and JSON metadata are required",
      400,
    );
  }

  const now = Date.now();
  const requestDigest = await installationOperationRequestDigest({
    reportId: usageReportId,
    billingAccountId: installation.billingAccountId,
    meter,
    quantity,
    unit,
    periodStart: periodStart ?? null,
    periodEnd: periodEnd ?? null,
    idempotencyKey: idempotencyKey ?? null,
    metadata,
  });
  const existingUsageReport =
    await input.store.findBillingUsageRecord(usageReportId);
  if (existingUsageReport) {
    if (
      existingUsageReport.capsuleId !== input.capsuleId ||
      existingUsageReport.billingAccountId !== installation.billingAccountId
    ) {
      return errorJson(
        "usage_report_id_conflict",
        "usage report id is already owned by another Capsule projection",
        409,
      );
    }
    if (existingUsageReport.requestDigest !== requestDigest) {
      return errorJson(
        "usage_report_id_conflict",
        "usage report id was already used with a different request body",
        409,
      );
    }
    return json(
      {
        usage_report: serializeBillingUsageRecord(existingUsageReport),
        duplicate: true,
      },
      200,
    );
  }

  // When the reportId was derived from the idempotencyKey above, the
  // idempotency dedup is already covered ATOMICALLY by the usageReportId claim
  // (the findBillingUsageRecord early-return handles both the duplicate 200 and
  // the different-body 409). The list-then-find scan below is only needed for
  // the residual case where the caller supplies an EXPLICIT reportId that
  // reuses an idempotencyKey already attached to a different report; that
  // best-effort scan stays non-atomic but does not gate the double-bill path.
  const existingIdempotentReport =
    idempotencyKey === undefined || explicitReportId === undefined
      ? undefined
      : (
          await input.store.listBillingUsageRecordsForCapsule(
            input.capsuleId,
          )
        ).find((record) => record.idempotencyKey === idempotencyKey);
  if (existingIdempotentReport) {
    if (existingIdempotentReport.requestDigest !== requestDigest) {
      return errorJson(
        "idempotency_key_conflict",
        "idempotencyKey was already used with a different request body",
        409,
      );
    }
    return json(
      {
        usage_report: serializeBillingUsageRecord(existingIdempotentReport),
        duplicate: true,
      },
      200,
    );
  }

  const record: BillingUsageRecord = {
    usageReportId,
    capsuleId: input.capsuleId,
    billingAccountId: installation.billingAccountId,
    meter,
    quantity,
    unit,
    ...(periodStart === undefined ? {} : { periodStart }),
    ...(periodEnd === undefined ? {} : { periodEnd }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    requestDigest,
    metadata,
    ...(authRecord.takosumiSubject
      ? { reportedBySubject: authRecord.takosumiSubject }
      : {}),
    reportedAt: now,
  };
  await input.store.saveBillingUsageRecord(record);
  await appendLedgerEvent(input.store, {
    capsuleId: input.capsuleId,
    eventType: "billing.usage_reported",
    payload: {
      usageReportId: record.usageReportId,
      billingAccountId: record.billingAccountId,
      meter: record.meter,
      quantity: record.quantity,
      unit: record.unit,
      idempotencyKey: record.idempotencyKey ?? null,
    },
    now,
  });

  return json({ usage_report: serializeBillingUsageRecord(record) }, 202);
}

function positiveNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function optionalTimestampValue(
  value: unknown,
): number | "invalid" | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "invalid";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
