import {
  canonicalJson,
  takosumiAccountsInstallationEventsPath,
  takosumiAccountsInstallationExportDownloadPath,
  takosumiAccountsInstallationMaterializeDigest,
} from "@takosjp/takosumi-accounts-contract";
import {
  type ServiceBindingMaterialKind,
  type ServiceBindingMaterialRecord,
  type ServiceGrantMaterialRecord,
  buildInstallationEvent,
  type InstallationEventRecord,
  type InstallationRecord,
  type RuntimeBindingRecord,
  transitionAppInstallationStatus,
} from "./ledger.ts";
import type {
  AccountsStore,
  BillingUsageRecord,
  OidcClientRecord,
} from "./store.ts";
import { sha256HexText, sha256Text } from "./encoding.ts";
import { errorJson, isRecord, json, stringValue } from "./http-helpers.ts";
import { publicInstallationOperationErrorMessage } from "./installation-operation-errors.ts";
import { redactPublicRecord } from "./public-redaction.ts";

export const installationMaterializeRequestedEvent =
  "installation.materialize-requested";
export const installationMaterializeSucceededEvent =
  "installation.materialize-succeeded";
export const installationMaterializeFailedEvent =
  "installation.materialize-failed";
export const installationExportRequestedEvent = "installation.export-requested";
export const installationExportedEvent = "installation.exported";
export const installationExportFailedEvent = "installation.export-failed";
export const installationUninstalledEvent = "installation.uninstalled";
export const installationActivatedHttpDomainEvent =
  "installation.activated-http-domain";
export const inFlightInstallationOperationEvents = new Set([
  installationMaterializeRequestedEvent,
  installationExportRequestedEvent,
]);

export interface ActivatedHttpDomainProjection {
  readonly url: string;
  readonly canonicalOrigin: string;
  readonly exposureId?: string;
  readonly deploymentOutputRef?: string;
  readonly activationEvidenceId?: string;
  readonly component?: string;
  readonly host?: string;
  readonly scheme?: string;
  readonly listener?: string;
  readonly state?: "pending" | "active" | "failed" | "inactive";
  readonly verifiedAt?: string;
}

export function isSha256HexDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Lightweight format check for a `sha256:`-prefixed digest reference.
 *
 * Plan and artifact digests in this codebase are `sha256:<base64url>` (see
 * `sha256Text`), NOT the fixed-width hex form `isSha256HexDigest` requires, so
 * this only asserts the `sha256:` scheme and a non-empty digest body. That is
 * enough to reject a digest-typed field carrying arbitrary junk (e.g. "x")
 * while still accepting both the real base64url digests and the shorter forms
 * used in fixtures. Strong provenance still comes from the service deployControl
 * (which supplies `planDigest` from `coreApply.planDigest`); this is
 * a format guard on the caller-supplied value recorded in the ledger.
 */
export function isSha256DigestRef(value: string): boolean {
  return /^sha256:[A-Za-z0-9_-]+$/.test(value);
}

/** Content integrity digest of raw bytes, formatted as `sha256:<hex>`. */
export async function sha256HexBytes(value: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so the digest input is a plain
  // BufferSource (avoids SharedArrayBuffer/offset typing pitfalls).
  const bytes = new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function isMeteredBindingKind(
  kind: ServiceBindingMaterialKind,
): boolean {
  return (
    kind === "storage.sql" ||
    kind === "storage.object" ||
    kind === "protocol.http.api"
  );
}

// `canonicalJson` is owned by the accounts contract (imported above) so the
// dashboard SPA and this server serialize permission digests identically.
// Re-export it for the existing in-package call sites.
export { canonicalJson };

export function compareCanonicalJson(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function serviceBindingMaterialApprovalPayload(
  binding: ServiceBindingMaterialRecord,
): Record<string, unknown> {
  return {
    name: binding.name,
    kind: binding.kind,
    configRef: binding.configRef,
    secretRefs: [...binding.secretRefs].sort(),
  };
}

export function serviceGrantMaterialApprovalPayload(
  grant: ServiceGrantMaterialRecord,
): Record<string, unknown> {
  return {
    capability: grant.capability,
    scope: grant.scope,
  };
}

export async function appInstallationPermissionDigest(input: {
  bindings: readonly ServiceBindingMaterialRecord[];
  grants: readonly ServiceGrantMaterialRecord[];
}): Promise<string> {
  return await sha256HexText(
    canonicalJson({
      serviceBindingKinds: input.bindings.map((binding) => binding.kind).sort(),
      serviceGrantCapabilities: input.grants
        .map((grant) => grant.capability)
        .sort(),
    }),
  );
}

export function appInstallationMaterializeDigest(input: {
  installationId: string;
  mode: "dedicated";
  region: string;
  plan: Record<string, unknown>;
  cutover: Record<string, unknown>;
}): Promise<string> {
  // Delegate to the contract so the server verifies the materialize permission
  // digest against the exact function the dashboard SPA uses to produce it.
  return takosumiAccountsInstallationMaterializeDigest(input);
}

/**
 * Maximum number of times we retry the read-then-write hash-chain
 * append before giving up. Three retries with capped exponential
 * backoff bounds the worst-case latency at ~70ms across all attempts
 * (10 + 20 + 40ms backoff). Concurrent appends to the same installation
 * are expected to be rare (per-installation lifecycle is serial in the
 * common case); contention here indicates either a deliberate
 * concurrent admin operation or a worker retry storm.
 */
const APPEND_LEDGER_EVENT_MAX_RETRIES = 3;
const APPEND_LEDGER_EVENT_BASE_BACKOFF_MS = 10;

export async function appendLedgerEvent(
  store: AccountsStore,
  input: {
    installationId: string;
    eventType: string;
    payload?: Record<string, unknown>;
    now: number;
  },
): Promise<InstallationEventRecord> {
  // F7 fix: wrap the read-then-write hash-chain logic in a retry loop.
  //
  // Backend serialization differs and is described accurately here because
  // this comment is load-bearing for reasoning about hash-chain safety:
  //
  // - Postgres serializes appends with a per-installation row lock
  //   (FOR UPDATE NOWAIT on installation_event_chain_locks). The loser of
  //   a contention race observes a lock-not-available error (55P03), is
  //   caught below, and retries against the refreshed tail. This path is
  //   genuinely serialized per installation.
  //
  // - D1 has NO per-installation serialization. `appendInstallationEvent`
  //   persists via `INSERT OR REPLACE` keyed on the event's own random
  //   `eventId` (`evt_<uuid>`, minted per call). It is therefore NOT
  //   idempotent-by-eventId in the IGNORE/DO-NOTHING sense the old comment
  //   claimed: every call inserts a distinct row, so a concurrent appender
  //   that read the same tail inserts a second successor with the same
  //   `previousEventHash`, forking the chain. The retry loop below is
  //   best-effort detection, not prevention: the post-write tail re-read
  //   catches the common case and retries, but a loser's already-persisted
  //   forked row is not removed, and under sustained same-installation
  //   contention all retries can fail — we then throw and the forked event
  //   remains, making `verifyInstallationEventHashChain` return false until
  //   the chain is repaired out of band. The event's content-addressed
  //   `eventHash` still makes tampering detectable; what D1 lacks is an
  //   atomic single-writer guarantee. Fully closing this requires a
  //   store-level conditional append keyed on
  //   (installationId, previousEventHash), which lives in the store
  //   implementations, not in this helper.
  //
  // On every retry we refetch the chain tail so the new event is computed
  // against the latest persisted `previousEventHash`.
  let lastError: unknown;
  for (let attempt = 0; attempt < APPEND_LEDGER_EVENT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Capped exponential backoff: 10ms, 20ms, 40ms.
      const backoffMs =
        APPEND_LEDGER_EVENT_BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
    const events = await store.listInstallationEvents(input.installationId);
    const previousEventHash = events.at(-1)?.eventHash;
    const event = await buildInstallationEvent({
      installationId: input.installationId,
      eventType: input.eventType,
      payload: input.payload,
      previousEventHash,
      createdAt: input.now,
    });
    try {
      await store.appendInstallationEvent(event);
    } catch (error) {
      // Most likely: postgres FOR UPDATE NOWAIT lost the race (55P03).
      // Save the error and retry; if we exhaust retries we re-raise.
      lastError = error;
      continue;
    }
    // Post-write integrity check: re-read and confirm our event is the
    // sole successor of the tail we built against. A genuine fork is
    // another event sharing our `previousEventHash` with a different
    // eventId (a concurrent appender that read the same tail). We must
    // NOT key this on "is our event the list tail": several events in a
    // single operation can share the same millisecond `createdAt`, so
    // tail ordering is ambiguous and would yield spurious fork errors.
    const refreshed = await store.listInstallationEvents(input.installationId);
    const ours = refreshed.find((e) => e.eventId === event.eventId);
    const sibling = refreshed.find(
      (e) =>
        e.eventId !== event.eventId &&
        e.previousEventHash === event.previousEventHash,
    );
    if (ours && !sibling) {
      return event;
    }
    lastError = new Error(
      `installation event chain forked for ${input.installationId}; ` +
        (ours
          ? `event ${event.eventId} shares previousEventHash with ${sibling?.eventId}`
          : `event ${event.eventId} was not observed after write`),
    );
  }
  throw (
    lastError ??
    new Error(
      `failed to append installation event after ${APPEND_LEDGER_EVENT_MAX_RETRIES} attempts`,
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function activatedHttpDomainProjectionFromEvents(
  events: readonly InstallationEventRecord[],
): ActivatedHttpDomainProjection | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.eventType !== installationActivatedHttpDomainEvent) continue;
    if (activatedHttpDomainStateValue(event.payload.state) === "inactive") {
      return undefined;
    }
    const projection = activatedHttpDomainProjectionFromPayload(event.payload);
    if (projection && projection.state !== "failed") return projection;
  }
  return undefined;
}

export function serializeActivatedHttpDomainProjection(
  projection: ActivatedHttpDomainProjection,
): Record<string, unknown> {
  return {
    url: projection.url,
    canonical_origin: projection.canonicalOrigin,
    canonicalOrigin: projection.canonicalOrigin,
    exposure_id: projection.exposureId ?? null,
    exposureId: projection.exposureId ?? null,
    deployment_output_ref: projection.deploymentOutputRef ?? null,
    deploymentOutputRef: projection.deploymentOutputRef ?? null,
    activation_evidence_id: projection.activationEvidenceId ?? null,
    activationEvidenceId: projection.activationEvidenceId ?? null,
    component: projection.component ?? null,
    host: projection.host ?? null,
    scheme: projection.scheme ?? null,
    listener: projection.listener ?? null,
    state: projection.state ?? "active",
    verified_at: projection.verifiedAt ?? null,
    verifiedAt: projection.verifiedAt ?? null,
  };
}

function activatedHttpDomainProjectionFromPayload(
  payload: Record<string, unknown>,
): ActivatedHttpDomainProjection | undefined {
  const url = stringValue(payload.url);
  const canonicalOrigin =
    stringValue(payload.canonicalOrigin) ??
    stringValue(payload.canonical_origin) ??
    canonicalHttpOrigin(url);
  if (!url || !canonicalOrigin) return undefined;
  const state = activatedHttpDomainStateValue(payload.state) ?? "active";
  return {
    url,
    canonicalOrigin,
    exposureId:
      stringValue(payload.exposureId) ?? stringValue(payload.exposure_id),
    deploymentOutputRef:
      stringValue(payload.deploymentOutputRef) ??
      stringValue(payload.deployment_output_ref),
    activationEvidenceId:
      stringValue(payload.activationEvidenceId) ??
      stringValue(payload.activation_evidence_id),
    component: stringValue(payload.component),
    host: stringValue(payload.host),
    scheme: stringValue(payload.scheme),
    listener: stringValue(payload.listener),
    state,
    verifiedAt:
      stringValue(payload.verifiedAt) ?? stringValue(payload.verified_at),
  };
}

function activatedHttpDomainStateValue(
  value: unknown,
): "pending" | "active" | "failed" | "inactive" | undefined {
  return value === "pending" ||
    value === "active" ||
    value === "failed" ||
    value === "inactive"
    ? value
    : undefined;
}

function canonicalHttpOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function requiredIdempotencyKey(request: Request): string | Response {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value || value.length > 200) {
    return errorJson(
      "invalid_request",
      "Idempotency-Key header is required and must be 1-200 characters",
      400,
    );
  }
  return value;
}

export async function installationOperationId(input: {
  installationId: string;
  operation: "materialize" | "export";
  idempotencyKey: string;
}): Promise<string> {
  const digest = await sha256Text(
    `takosumi-accounts-operation:${input.operation}:${input.installationId}:${input.idempotencyKey}`,
  );
  return `op_${digest.slice("sha256:".length, "sha256:".length + 26)}`;
}

export async function installationOperationRequestDigest(
  payload: unknown,
): Promise<string> {
  return await sha256Text(canonicalJson(payload));
}

export function findIdempotentOperationEvent(input: {
  events: readonly InstallationEventRecord[];
  eventType: string;
  idempotencyKey: string;
}): InstallationEventRecord | undefined {
  return input.events.find(
    (event) =>
      event.eventType === input.eventType &&
      event.payload.idempotencyKey === input.idempotencyKey,
  );
}

export function idempotencyRequestConflict(
  event: InstallationEventRecord,
  requestDigest: string,
): Response | undefined {
  const existingDigest = stringValue(event.payload.requestDigest);
  if (existingDigest === requestDigest) return undefined;
  // Fail closed. If the prior operation event carries no stored requestDigest
  // (an older event written before request digests were recorded), we
  // cannot prove the replayed body matches, so we must not silently return the
  // prior operation as if it matched — that would let a different body reuse
  // the key. Treat an unverifiable digest as a conflict. Newly written events
  // always carry a requestDigest, so this only affects pre-existing events.
  return errorJson(
    "idempotency_key_conflict",
    existingDigest
      ? "Idempotency-Key was already used with a different request body"
      : "Idempotency-Key was already used by an operation whose request body cannot be verified",
    409,
  );
}

export function findInFlightInstallationOperation(
  events: readonly InstallationEventRecord[],
): InstallationEventRecord | undefined {
  return events.find((event) => {
    if (!inFlightInstallationOperationEvents.has(event.eventType)) {
      return false;
    }
    return !isInstallationOperationClosed(events, event);
  });
}

export function isInstallationOperationClosed(
  events: readonly InstallationEventRecord[],
  requestEvent: InstallationEventRecord,
): boolean {
  const operationId = stringValue(requestEvent.payload.operationId);
  if (!operationId) return false;
  if (requestEvent.eventType === installationMaterializeRequestedEvent) {
    return (
      findOperationEvent({
        events,
        operationId,
        eventTypes: [
          installationMaterializeSucceededEvent,
          installationMaterializeFailedEvent,
        ],
      }) !== undefined
    );
  }
  if (requestEvent.eventType === installationExportRequestedEvent) {
    return (
      findOperationEvent({
        events,
        operationId,
        eventTypes: [installationExportedEvent, installationExportFailedEvent],
      }) !== undefined
    );
  }
  return false;
}

export function findOperationEvent(input: {
  events: readonly InstallationEventRecord[];
  operationId: string;
  eventTypes: readonly string[];
}): InstallationEventRecord | undefined {
  const eventTypes = new Set(input.eventTypes);
  return input.events.find(
    (event) =>
      eventTypes.has(event.eventType) &&
      event.payload.operationId === input.operationId,
  );
}

export function operationRequestedEventType(
  operation: "materialize" | "export",
): string {
  return operation === "materialize"
    ? installationMaterializeRequestedEvent
    : installationExportRequestedEvent;
}

export function operationClosedEventTypes(
  operation: "materialize" | "export",
): readonly string[] {
  return operation === "materialize"
    ? [
        installationMaterializeSucceededEvent,
        installationMaterializeFailedEvent,
      ]
    : [installationExportedEvent, installationExportFailedEvent];
}

export function installationEventsTrackingUrl(
  installationId: string,
  eventTypes: readonly string[],
): string {
  return `${takosumiAccountsInstallationEventsPath(installationId)}?types=${eventTypes
    .map(encodeURIComponent)
    .join(",")}`;
}

export function exportOperationBody(
  installationId: string,
  operationId: string,
  options: {
    status?: "preparing" | "exported" | "failed";
    downloadUrl?: string | null;
    downloadExpiresAt?: string | null;
    error?: string;
  } = {},
): Record<string, unknown> {
  const status = options.status ?? "preparing";
  return {
    operationId,
    status,
    trackingUrl: installationEventsTrackingUrl(installationId, [
      installationExportRequestedEvent,
      installationExportedEvent,
      installationExportFailedEvent,
    ]),
    downloadUrl:
      status === "exported" && options.downloadUrl
        ? takosumiAccountsInstallationExportDownloadPath(
            installationId,
            operationId,
          )
        : null,
    downloadExpiresAt: options.downloadExpiresAt ?? null,
    ...(options.error ? { error: options.error } : {}),
  };
}

export function exportOperationBodyFromEvents(input: {
  installationId: string;
  operationId: string;
  events: readonly InstallationEventRecord[];
}): Record<string, unknown> {
  const completed = findOperationEvent({
    events: input.events,
    operationId: input.operationId,
    eventTypes: [installationExportedEvent],
  });
  if (completed) {
    return exportOperationBody(input.installationId, input.operationId, {
      status: "exported",
      downloadUrl: stringValue(completed.payload.downloadUrl) ?? null,
      downloadExpiresAt:
        stringValue(completed.payload.downloadExpiresAt) ?? null,
    });
  }
  const failed = findOperationEvent({
    events: input.events,
    operationId: input.operationId,
    eventTypes: [installationExportFailedEvent],
  });
  if (failed) {
    return exportOperationBody(input.installationId, input.operationId, {
      status: "failed",
      downloadUrl: null,
      downloadExpiresAt: null,
      error: publicInstallationOperationErrorMessage(
        failed.payload.error,
        "export failed",
      ),
    });
  }
  return exportOperationBody(input.installationId, input.operationId);
}

export async function appendExportOperationCompletion(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  operationId: string;
  downloadUrl: string;
  downloadExpiresAt?: string;
}): Promise<InstallationEventRecord> {
  const now = Date.now();
  const updated = transitionAppInstallationStatus(
    input.installation,
    "exported",
    now,
  );
  await input.store.saveAppInstallation(updated);
  if (updated.status !== input.installation.status) {
    await appendLedgerEvent(input.store, {
      installationId: input.installation.installationId,
      eventType: "installation.status_changed",
      payload: {
        from: input.installation.status,
        to: updated.status,
        reason: "export worker completed bundle",
      },
      now,
    });
  }
  return await appendLedgerEvent(input.store, {
    installationId: input.installation.installationId,
    eventType: installationExportedEvent,
    payload: {
      operationId: input.operationId,
      from: input.installation.status,
      to: updated.status,
      reason: "export worker completed bundle",
      downloadUrl: input.downloadUrl,
      downloadExpiresAt: input.downloadExpiresAt ?? null,
    },
    now,
  });
}

export async function appendExportOperationFailure(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  operationId: string;
  error: string;
}): Promise<InstallationEventRecord> {
  const now = Date.now();
  const updated = transitionAppInstallationStatus(
    input.installation,
    "failed",
    now,
  );
  await input.store.saveAppInstallation(updated);
  if (updated.status !== input.installation.status) {
    await appendLedgerEvent(input.store, {
      installationId: input.installation.installationId,
      eventType: "installation.status_changed",
      payload: {
        from: input.installation.status,
        to: updated.status,
        reason: input.error,
      },
      now,
    });
  }
  return await appendLedgerEvent(input.store, {
    installationId: input.installation.installationId,
    eventType: installationExportFailedEvent,
    payload: {
      operationId: input.operationId,
      from: input.installation.status,
      to: updated.status,
      reason: input.error,
      error: input.error,
    },
    now,
  });
}

export function installationEnvelope(input: {
  installation: InstallationRecord;
  // Wave 6 (Phase E SQL drift fix): ServiceBindingMaterial / ServiceGrantMaterial / RuntimeBinding
  // are no longer public concepts and the backing tables were dropped.
  // The fields below are accepted for caller-API compatibility but are
  // no longer surfaced in the response envelope. The materialize /
  // lifecycle routes that depend on these fields render
  // their own payloads via the per-field `serialize*` helpers.
  bindings?: readonly ServiceBindingMaterialRecord[];
  grants?: readonly ServiceGrantMaterialRecord[];
  oidcClient?: OidcClientRecord;
  runtimeBinding?: RuntimeBindingRecord;
  activatedHttpDomain?: ActivatedHttpDomainProjection;
  eventsUrl: string;
}): Record<string, unknown> {
  void input.bindings;
  void input.grants;
  void input.runtimeBinding;
  const launch = input.activatedHttpDomain
    ? serializeActivatedHttpDomainProjection(input.activatedHttpDomain)
    : null;
  const deploymentOutputs = input.activatedHttpDomain
    ? [
        {
          name: "launch_url",
          kind: "launch_url",
          value: input.activatedHttpDomain.url,
          sensitive: false,
          ...(input.activatedHttpDomain.deploymentOutputRef
            ? {
                labels: {
                  deploymentOutputRef:
                    input.activatedHttpDomain.deploymentOutputRef,
                },
              }
            : {}),
        },
      ]
    : [];
  return {
    installation: {
      ...serializeAppInstallation(input.installation),
      launch_url: input.activatedHttpDomain?.url ?? null,
      deployment_outputs: deploymentOutputs,
      launch,
      activated_http_domain: launch,
    },
    launch,
    oidc_client: input.oidcClient
      ? serializeOidcClient(input.oidcClient)
      : null,
    tracking: {
      events_url: input.eventsUrl,
    },
  };
}

export function serializeAppInstallation(
  installation: InstallationRecord,
): Record<string, unknown> {
  return {
    id: installation.installationId,
    account_id: installation.accountId,
    space_id: installation.spaceId,
    capsule_id: installation.appId,
    source: {
      type: "git",
      url: installation.sourceGitUrl,
      ref: installation.sourceRef,
      commit: installation.sourceCommit,
    },
    plan_digest: installation.planDigest,
    artifact_digest: installation.artifactDigest ?? null,
    mode: installation.mode,
    runtime_target_id: installation.runtimeBindingId ?? null,
    billing_account_id: installation.billingAccountId ?? null,
    status: installation.status,
    created_by_subject: installation.createdBySubject,
    created_at: new Date(installation.createdAt).toISOString(),
    updated_at: new Date(installation.updatedAt).toISOString(),
  };
}

export function serializeRuntimeBinding(
  runtimeBinding: RuntimeBindingRecord,
): Record<string, unknown> {
  return {
    id: runtimeBinding.runtimeBindingId,
    installation_id: runtimeBinding.installationId,
    mode: runtimeBinding.mode,
    target_type: runtimeBinding.targetType,
    target_id: runtimeBinding.targetId,
    created_at: new Date(runtimeBinding.createdAt).toISOString(),
    updated_at: new Date(runtimeBinding.updatedAt).toISOString(),
  };
}

export function serializeOidcClient(
  client: OidcClientRecord,
): Record<string, unknown> {
  return {
    client_id: client.clientId,
    installation_id: client.installationId,
    servicePath: client.namespacePath,
    // Existing Accounts API consumers may still read namespacePath.
    namespacePath: client.namespacePath,
    issuer_url: client.issuerUrl,
    redirect_uris: client.redirectUris,
    allowed_scopes: client.allowedScopes,
    subject_mode: client.subjectMode,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    created_at: new Date(client.createdAt).toISOString(),
    updated_at: new Date(client.updatedAt).toISOString(),
  };
}

export function serializeServiceBindingMaterial(
  binding: ServiceBindingMaterialRecord,
): Record<string, unknown> {
  return {
    id: binding.bindingId,
    installation_id: binding.installationId,
    name: binding.name,
    kind: binding.kind,
    config_ref: binding.configRef,
    secret_ref_count: binding.secretRefs.length,
    created_at: new Date(binding.createdAt).toISOString(),
    updated_at: new Date(binding.updatedAt).toISOString(),
  };
}

export function serializeServiceGrantMaterial(
  grant: ServiceGrantMaterialRecord,
): Record<string, unknown> {
  return {
    id: grant.grantId,
    installation_id: grant.installationId,
    capability: grant.capability,
    scope: redactPublicRecord(grant.scope),
    granted_at: new Date(grant.grantedAt).toISOString(),
    revoked_at: grant.revokedAt
      ? new Date(grant.revokedAt).toISOString()
      : null,
  };
}

export function serializeBillingUsageRecord(
  record: BillingUsageRecord,
): Record<string, unknown> {
  return {
    id: record.usageReportId,
    installation_id: record.installationId,
    billing_account_id: record.billingAccountId,
    meter: record.meter,
    quantity: record.quantity,
    unit: record.unit,
    period_start:
      record.periodStart === undefined
        ? null
        : new Date(record.periodStart).toISOString(),
    period_end:
      record.periodEnd === undefined
        ? null
        : new Date(record.periodEnd).toISOString(),
    idempotency_key: record.idempotencyKey ?? null,
    metadata: record.metadata,
    reported_by_subject: record.reportedBySubject ?? null,
    reported_at: new Date(record.reportedAt).toISOString(),
    status: "accepted",
  };
}

export function serializeInstallationEvent(
  event: InstallationEventRecord,
): Record<string, unknown> {
  return {
    id: event.eventId,
    installation_id: event.installationId,
    type: event.eventType,
    payload: serializeInstallationEventPayload(event),
    previous_event_hash: event.previousEventHash ?? null,
    event_hash: event.eventHash,
    created_at: new Date(event.createdAt).toISOString(),
  };
}

function serializeInstallationEventPayload(
  event: InstallationEventRecord,
): Record<string, unknown> {
  const payload = omitPublicEventSecretReferenceKeys(
    redactPublicRecord(event.payload),
  ) as Record<string, unknown>;
  if (event.eventType === installationExportedEvent) {
    const operationId = stringValue(event.payload.operationId);
    if (operationId) {
      payload.downloadUrl = takosumiAccountsInstallationExportDownloadPath(
        event.installationId,
        operationId,
      );
    } else if ("downloadUrl" in payload) {
      payload.downloadUrl = null;
    }
  }
  return payload;
}

const PUBLIC_EVENT_SECRET_KEYS = new Set([
  "accessToken",
  "access_token",
  "clientSecret",
  "client_secret",
  "privateKey",
  "private_key",
  "refreshToken",
  "refresh_token",
  "secretRef",
  "secret_ref",
  "secretRefs",
  "secret_refs",
  "token",
  "tokenHash",
  "token_hash",
]);

function omitPublicEventSecretReferenceKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitPublicEventSecretReferenceKeys(entry));
  }
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PUBLIC_EVENT_SECRET_KEYS.has(key)) continue;
    output[key] = omitPublicEventSecretReferenceKeys(child);
  }
  return output;
}
