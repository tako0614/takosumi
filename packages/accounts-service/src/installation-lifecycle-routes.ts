import {
 takosumiAccountsInstallationEventsPath,
 takosumiAccountsInstallationExportOperationPath,
 takosumiAccountsInstallationPath,
} from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsInstallationExportBundle,
  parseAccountsInstallationExportBundle,
  planInstallationImport,
} from "./export-bundle.ts";
import {
  type AppBindingKind,
  type AppBindingRecord,
  type AppGrantRecord,
  type AppInstallationMode,
  assertValidAppBindingRecord,
  type InstallationEventRecord,
  type InstallationRecord,
  isAppBindingKind,
  isAppGrantCapability,
  type SpaceKind,
  transitionAppInstallationStatus,
} from "./ledger.ts";
import type {
  AccountsStore,
  BillingUsageRecord,
  OidcClientRecord,
} from "./store.ts";
import type { SharedCellRuntimeAllocator } from "./runtime.ts";
import { constantTimeEqual, sha256HexText, sha256Text } from "./encoding.ts";
import {
  type ActivatedHttpDomainProjection,
  activatedHttpDomainProjectionFromEvents,
  appBindingApprovalPayload,
  appendImportDataRestoreFailure,
  appendLedgerEvent,
  appGrantApprovalPayload,
  appInstallationMaterializeDigest,
  appInstallationPermissionDigest,
  canonicalJson,
  compareCanonicalJson,
  exportOperationBody,
  exportOperationBodyFromEvents,
  findIdempotentOperationEvent,
  findInFlightInstallationOperation,
  findOperationEvent,
  idempotencyRequestConflict,
  installationActivatedHttpDomainEvent,
  installationEnvelope,
  installationExportedEvent,
  installationExportFailedEvent,
  installationExportRequestedEvent,
  installationMaterializeFailedEvent,
  installationMaterializeRequestedEvent,
  installationMaterializeSucceededEvent,
  installationOperationId,
  installationOperationRequestDigest,
  installationUninstalledEvent,
  isMeteredBindingKind,
  isSha256DigestRef,
  isSha256HexDigest,
  parseAppInstallationImportData,
  requiredIdempotencyKey,
  serializeAppBinding,
  serializeAppGrant,
  serializeAppInstallation,
  serializeBillingUsageRecord,
  serializeInstallationEvent,
} from "./installation-helpers.ts";
import {
  completeAppInstallationExportWithWorker,
  completeAppInstallationMaterializeWithWorker,
  materializeAcceptedBody,
  materializeCompletionFromStatusPatch,
  materializePreservationSnapshot,
  runtimeBindingFromValue,
  validateOperationCompletionFromStatusPatch,
} from "./installation-materialize-helpers.ts";
import {
  hasRemovedOidcNamespaceAlias,
  oidcAllowedScopesValue,
  oidcClientAuthMethodValue,
  oidcIssuerUrlValue,
  oidcNamespacePathValue,
  oidcRedirectUrisValue,
  requireInstallationAccessTokenCapability,
} from "./installation-routes-internal.ts";
import {
  appInstallationStatusValue,
  booleanValue,
  isPlainRecord,
  isRecord,
  json,
  readJsonObject,
  readOptionalJsonObject,
  stringArrayValue,
  stringValue,
 takosumiSubjectValue,
} from "./http-helpers.ts";
import type {
  AppBindingMaterializationResult,
  AppBindingMaterializer,
  AppInstallationExportRequest,
  AppInstallationExportWorker,
  AppInstallationImportDataRestorer,
  AppInstallationMaterializeRequest,
  AppInstallationMaterializeWorker,
  LaunchTokenOptions,
} from "./mod.ts";
import {
  type InstallerProxyOptions,
  requestDeploymentApply,
  requestDeploymentDryRun,
  requestInstallationApply,
  requestRollback,
} from "./installer-proxy.ts";
import {
  readExportDownloadSigningSecretFromEnv,
  signExportDownloadUrl,
} from "./export-archive.ts";

/**
 * Whitelist the fields we are willing to echo from an upstream installer
 * error envelope back to the Cloud caller. The installer (Takosumi)
 * may include implementation details, stack traces, or operator-private
 * context in its `payload`; surfacing those verbatim was an information
 * leak (Round 1 finding). Only `code`, `message`, the non-sensitive
 * correlation `requestId`, and `hint` are passed through; anything else is
 * dropped. The fields are read from the nested Installer envelope
 * (`payload.error.*`) with a fallback to a top-level shape.
 */
function sanitizeUpstreamErrorPayload(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload)
  ) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  // The Installer API closed error envelope nests its fields under `error`:
  // `{ error: { code, message, requestId } }`. Reading `record.code` directly
  // (the prior behavior) always missed them and silently dropped the upstream
  // code from every failed-deploy facade response. Unwrap the envelope, falling
  // back to a top-level shape so a non-nested payload still works.
  const inner = (typeof record.error === "object" && record.error !== null &&
      !Array.isArray(record.error))
    ? record.error as Record<string, unknown>
    : record;
  const output: Record<string, unknown> = {};
  if (typeof inner.code === "string" && inner.code.length > 0) {
    output.code = inner.code;
  }
  if (typeof inner.message === "string" && inner.message.length > 0) {
    output.message = inner.message;
  }
  if (typeof inner.requestId === "string" && inner.requestId.length > 0) {
    output.requestId = inner.requestId;
  }
  if (typeof inner.hint === "string" && inner.hint.length > 0) {
    output.hint = inner.hint;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

interface AppInstallationConfirmRecord {
  readonly permissionDigest: string;
  readonly costAck: boolean;
  readonly approvalRequired?: boolean;
  readonly expiresAt?: string;
}

interface CoreInstallationProjection {
  readonly installationId: string;
  readonly appId: string;
  readonly sourceUrl: string;
  readonly sourceRef: string;
  readonly sourceCommit?: string;
  readonly sourceDigest?: string;
  readonly planSnapshotDigest: string;
  readonly artifactDigest?: string;
  readonly activatedHttpDomain?: ActivatedHttpDomainProjection;
}

interface CoreDeploymentProjection {
  readonly deploymentId: string;
  readonly sourceUrl?: string;
  readonly sourceRef?: string;
  readonly sourceCommit?: string;
  readonly sourceDigest?: string;
  readonly planSnapshotDigest: string;
  readonly artifactDigest?: string;
  readonly activatedHttpDomain?: ActivatedHttpDomainProjection;
  readonly expected?: Record<string, unknown>;
  readonly payload: unknown;
}

async function applyCoreInstallationForCloudProjection(input: {
  installer: InstallerProxyOptions;
  spaceId: string | undefined;
  source: Record<string, unknown>;
  expectedCommit: string | undefined;
  expectedSourceDigest: string | undefined;
  expectedPlanSnapshotDigest: string | undefined;
}): Promise<CoreInstallationProjection | Response> {
  const source = coreInstallerSourceFromCloudSource(input.source);
  if (source instanceof Response) return source;
  if (!input.spaceId) {
    return json({
      error: "invalid_request",
      error_description: "spaceId is required",
    }, 400);
  }
  const body: Record<string, unknown> = {
    spaceId: input.spaceId,
    source,
  };
  const expected: Record<string, unknown> = {};
  if (input.expectedPlanSnapshotDigest) {
    expected.planSnapshotDigest = input.expectedPlanSnapshotDigest;
  }
  if (source.kind === "git" && input.expectedCommit) {
    expected.commit = input.expectedCommit;
  } else if (source.kind === "prepared" && input.expectedSourceDigest) {
    expected.sourceDigest = input.expectedSourceDigest;
  }
  if (Object.keys(expected).length > 0) {
    body.expected = {
      ...expected,
    };
  }
  const result = await requestInstallationApply({
    installer: input.installer,
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return json({
      error: "failed_precondition",
      error_description: "Takosumi installation apply failed",
      ...(upstream ? { upstream } : {}),
    }, result.status);
  }
  const projection = coreInstallationProjectionFromApply(result.payload);
  if (projection instanceof Response) return projection;
  return projection;
}

async function dryRunCoreDeploymentForCloudProjection(input: {
  installer: InstallerProxyOptions;
  installationId: string;
  source: Record<string, unknown> | undefined;
}): Promise<CoreDeploymentProjection | Response> {
  const body = coreDeploymentRequestBodyFromCloudBody({ source: input.source });
  if (body instanceof Response) return body;
  const result = await requestDeploymentDryRun({
    installer: input.installer,
    installationId: input.installationId,
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return json({
      error: "failed_precondition",
      error_description: "Takosumi deployment dry-run failed",
      ...(upstream ? { upstream } : {}),
    }, result.status);
  }
  return coreDeploymentProjectionFromDryRun(result.payload);
}

async function applyCoreDeploymentForCloudProjection(input: {
  installer: InstallerProxyOptions;
  installationId: string;
  source: Record<string, unknown> | undefined;
  expected: Record<string, unknown> | undefined;
}): Promise<CoreDeploymentProjection | Response> {
  const body = coreDeploymentRequestBodyFromCloudBody({
    source: input.source,
    expected: input.expected,
  });
  if (body instanceof Response) return body;
  if (!body.expected || !isRecord(body.expected)) {
    return json({
      error: "invalid_request",
      error_description:
        "deployment apply through the Takosumi installer requires expected from deployment dry-run",
    }, 400);
  }
  const result = await requestDeploymentApply({
    installer: input.installer,
    installationId: input.installationId,
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return json({
      error: "failed_precondition",
      error_description: "Takosumi deployment apply failed",
      ...(upstream ? { upstream } : {}),
    }, result.status);
  }
  return coreDeploymentProjectionFromApply(result.payload);
}

async function rollbackCoreDeploymentForCloudProjection(input: {
  installer: InstallerProxyOptions;
  installationId: string;
  deploymentId: string | undefined;
}): Promise<CoreDeploymentProjection | Response> {
  if (!input.deploymentId) {
    return json({
      error: "invalid_request",
      error_description:
        "rollback through the Takosumi installer requires deploymentId",
    }, 400);
  }
  const result = await requestRollback({
    installer: input.installer,
    installationId: input.installationId,
    body: { deploymentId: input.deploymentId },
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return json({
      error: "failed_precondition",
      error_description: "Takosumi rollback failed",
      ...(upstream ? { upstream } : {}),
    }, result.status);
  }
  return coreDeploymentProjectionFromRollback(result.payload);
}

function coreDeploymentRequestBodyFromCloudBody(input: {
  source?: Record<string, unknown>;
  expected?: Record<string, unknown>;
}): Record<string, unknown> | Response {
  const body: Record<string, unknown> = {};
  if (input.source && Object.keys(input.source).length > 0) {
    const source = coreInstallerSourceFromCloudSource(input.source);
    if (source instanceof Response) return source;
    body.source = source;
  }
  if (input.expected) body.expected = input.expected;
  return body;
}

function coreInstallerSourceFromCloudSource(
  source: Record<string, unknown>,
): Record<string, unknown> | Response {
  const kind = stringValue(source.kind) ?? "git";
  const url = stringValue(source.url) ?? stringValue(source.gitUrl);
  if (!url) {
    return json({
      error: "invalid_request",
      error_description: "source.url is required",
    }, 400);
  }
  if (kind === "git") {
    const ref = stringValue(source.ref);
    if (!ref) {
      return json({
        error: "invalid_request",
        error_description: "source.ref is required for git sources",
      }, 400);
    }
    return { kind: "git", url, ref };
  }
  if (kind === "prepared") {
    const digest = stringValue(source.digest) ??
      stringValue(source.sourceDigest);
    if (!digest) {
      return json({
        error: "invalid_request",
        error_description: "source.digest is required for prepared sources",
      }, 400);
    }
    return { kind: "prepared", url, digest };
  }
  if (kind === "local") {
    return { kind: "local", url };
  }
  return json({
    error: "invalid_request",
    error_description: "source.kind must be git, prepared, or local",
  }, 400);
}

function coreInstallationProjectionFromApply(
  payload: unknown,
): CoreInstallationProjection | Response {
  if (!isRecord(payload)) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Takosumi installation apply returned a non-object response",
    }, 502);
  }
  const installation = isRecord(payload.installation)
    ? payload.installation
    : undefined;
  const deployment = isRecord(payload.deployment)
    ? payload.deployment
    : undefined;
  const source = deployment && isRecord(deployment.source)
    ? deployment.source
    : undefined;
  const installationId = stringValue(installation?.id);
  const appId = stringValue(installation?.appId) ??
    stringValue(installation?.app_id);
  const sourceUrl = stringValue(source?.url);
  const sourceKind = stringValue(source?.kind);
  const sourceRef = stringValue(source?.ref) ?? stringValue(source?.digest) ??
    (sourceKind === "local" ? "local" : undefined);
  const sourceCommit = stringValue(source?.commit);
  const sourceDigest = stringValue(source?.digest);
  const planSnapshotDigest = stringValue(deployment?.planSnapshotDigest) ??
    stringValue(deployment?.plan_snapshot_digest);
  const artifactDigest =
    stringValue(deployment?.artifactDigest) ??
      stringValue(deployment?.artifact_digest);
  const activatedHttpDomain = activatedHttpDomainProjectionFromCoreOutputs({
    deploymentId: stringValue(deployment?.id),
    outputs: deployment?.outputs,
    now: Date.now(),
  });
  if (
    !installationId || !appId || !sourceUrl || !sourceRef || !planSnapshotDigest
  ) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Takosumi installation apply response is missing installation/deployment projection fields",
    }, 502);
  }
  return {
    installationId,
    appId,
    sourceUrl,
    sourceRef,
    sourceCommit,
    sourceDigest,
    planSnapshotDigest,
    artifactDigest,
    activatedHttpDomain,
  };
}

function coreDeploymentProjectionFromDryRun(
  payload: unknown,
): CoreDeploymentProjection | Response {
  if (!isRecord(payload)) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Takosumi deployment dry-run returned a non-object response",
    }, 502);
  }
  const projection = coreDeploymentProjectionFromDeploymentLike({
    deployment: payload,
    payload,
    fallbackDeploymentId: "dry-run",
  });
  if (projection instanceof Response) return projection;
  const expected = isRecord(payload.expected) ? payload.expected : undefined;
  return { ...projection, expected };
}

function coreDeploymentProjectionFromApply(
  payload: unknown,
): CoreDeploymentProjection | Response {
  if (!isRecord(payload)) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Takosumi deployment apply returned a non-object response",
    }, 502);
  }
  const deployment = isRecord(payload.deployment)
    ? payload.deployment
    : undefined;
  return coreDeploymentProjectionFromDeploymentLike({ deployment, payload });
}

function coreDeploymentProjectionFromRollback(
  payload: unknown,
): CoreDeploymentProjection | Response {
  if (!isRecord(payload)) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Takosumi rollback returned a non-object response",
    }, 502);
  }
  const deployment = isRecord(payload.deployment)
    ? payload.deployment
    : undefined;
  return coreDeploymentProjectionFromDeploymentLike({ deployment, payload });
}

function coreDeploymentProjectionFromDeploymentLike(input: {
  deployment: Record<string, unknown> | undefined;
  payload: unknown;
  fallbackDeploymentId?: string;
}): CoreDeploymentProjection | Response {
  const deployment = input.deployment;
  const source = deployment && isRecord(deployment.source)
    ? deployment.source
    : isRecord(input.payload) && isRecord(input.payload.source)
    ? input.payload.source
    : undefined;
  const deploymentId = stringValue(deployment?.id) ??
    input.fallbackDeploymentId;
  const planSnapshotDigest = stringValue(deployment?.planSnapshotDigest) ??
    stringValue(deployment?.plan_snapshot_digest) ??
    (isRecord(input.payload)
      ? stringValue(input.payload.planSnapshotDigest) ??
        stringValue(input.payload.plan_snapshot_digest)
      : undefined);
  const artifactDigest =
    stringValue(deployment?.artifactDigest) ??
      stringValue(deployment?.artifact_digest);
  const activatedHttpDomain = activatedHttpDomainProjectionFromCoreOutputs({
    deploymentId,
    outputs: deployment?.outputs,
    now: Date.now(),
  });
  if (!deploymentId || !planSnapshotDigest) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Takosumi deployment response is missing deployment projection fields",
    }, 502);
  }
  return {
    deploymentId,
    sourceUrl: stringValue(source?.url),
    sourceRef: stringValue(source?.ref) ?? stringValue(source?.digest),
    sourceCommit: stringValue(source?.commit),
    sourceDigest: stringValue(source?.digest),
    planSnapshotDigest,
    artifactDigest,
    activatedHttpDomain,
    payload: input.payload,
  };
}

function activatedHttpDomainProjectionFromCoreOutputs(input: {
  deploymentId: string | undefined;
  outputs: unknown;
  now: number;
}): ActivatedHttpDomainProjection | undefined {
  const candidate = activatedHttpDomainCandidateFromCoreOutputs(input.outputs);
  if (!candidate) return undefined;
  const canonicalOrigin = canonicalHttpOrigin(candidate.url);
  if (!canonicalOrigin) return undefined;
  return {
    url: candidate.url,
    canonicalOrigin,
    exposureId: `exposure_${
      stableProjectionIdSegment(input.deploymentId ?? "deployment")
    }_${stableProjectionIdSegment(candidate.component ?? "http")}`,
    deploymentOutputRef: candidate.deploymentOutputRef,
    activationEvidenceId: input.deploymentId,
    component: candidate.component,
    host: candidate.host,
    scheme: candidate.scheme,
    listener: candidate.listener,
    state: "active",
    verifiedAt: new Date(input.now).toISOString(),
  };
}

function activatedHttpDomainCandidateFromCoreOutputs(
  outputs: unknown,
): {
  readonly url: string;
  readonly deploymentOutputRef: string;
  readonly component?: string;
  readonly host?: string;
  readonly scheme?: string;
  readonly listener?: string;
} | undefined {
  if (!isRecord(outputs)) return undefined;
  const candidates: {
    readonly url: string;
    readonly deploymentOutputRef: string;
    readonly component?: string;
    readonly host?: string;
    readonly scheme?: string;
    readonly listener?: string;
  }[] = [];
  const components = isRecord(outputs.components)
    ? outputs.components
    : undefined;
  if (components) {
    for (const [component, value] of Object.entries(components)) {
      if (!isRecord(value)) continue;
      const providerOutputs = isRecord(value.outputs)
        ? activatedHttpDomainCandidateFromOutputRecord({
          output: value.outputs,
          deploymentOutputRef:
            `deployment.outputs.components.${component}.outputs`,
          component,
        })
        : undefined;
      if (providerOutputs) candidates.push(providerOutputs);
      const candidate = activatedHttpDomainCandidateFromOutputRecord({
        output: value,
        deploymentOutputRef: `deployment.outputs.components.${component}`,
        component,
      });
      if (candidate) candidates.push(candidate);
      for (const [slotName, slotValue] of Object.entries(value)) {
        if (slotName === "outputs" || slotName === "providerOutputs") {
          continue;
        }
        if (!isRecord(slotValue)) continue;
        const slotCandidate = activatedHttpDomainCandidateFromOutputRecord({
          output: slotValue,
          deploymentOutputRef:
            `deployment.outputs.components.${component}.${slotName}`,
          component,
        });
        if (slotCandidate) candidates.push(slotCandidate);
      }
    }
  }
  const extensions = isRecord(outputs.extensions)
    ? outputs.extensions
    : undefined;
  const servicePathExposures = isRecord(extensions?.servicePathExposures)
    ? extensions.servicePathExposures
    : undefined;
  if (servicePathExposures) {
    for (const [name, value] of Object.entries(servicePathExposures)) {
      if (!isRecord(value)) continue;
      const outputRef = stringValue(value.output);
      const [component] = outputRef?.split(".") ?? [];
      const material = isRecord(value.material) ? value.material : value;
      const candidate = activatedHttpDomainCandidateFromOutputRecord({
        output: material,
        deploymentOutputRef:
          `deployment.outputs.extensions.servicePathExposures.${name}.material`,
        component: component || name,
      });
      if (candidate) candidates.push(candidate);
    }
  }
  const direct = activatedHttpDomainCandidateFromOutputRecord({
    output: outputs,
    deploymentOutputRef: "deployment.outputs",
  });
  if (direct) candidates.push(direct);
  return candidates.sort((left, right) =>
    activatedHttpDomainCandidateScore(right) -
    activatedHttpDomainCandidateScore(left)
  )[0];
}

function activatedHttpDomainCandidateFromOutputRecord(input: {
  output: Record<string, unknown>;
  deploymentOutputRef: string;
  component?: string;
}): {
  readonly url: string;
  readonly deploymentOutputRef: string;
  readonly component?: string;
  readonly host?: string;
  readonly scheme?: string;
  readonly listener?: string;
} | undefined {
  const endpoint = firstRecord(input.output.endpoints) ??
    firstRecord(input.output.targets);
  const url = stringValue(input.output.url) ?? stringValue(endpoint?.url);
  if (!url || !canonicalHttpOrigin(url)) return undefined;
  return {
    url,
    deploymentOutputRef: input.deploymentOutputRef,
    component: input.component,
    host: stringValue(input.output.host) ?? stringValue(endpoint?.host),
    scheme: stringValue(input.output.scheme) ?? stringValue(endpoint?.scheme),
    listener: stringValue(input.output.listener) ??
      stringValue(endpoint?.listener),
  };
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find(isRecord);
}

function activatedHttpDomainCandidateScore(input: {
  readonly component?: string;
  readonly listener?: string;
  readonly scheme?: string;
}): number {
  let score = 0;
  if (input.component === "public") score += 100;
  if (input.listener === "public") score += 50;
  if (input.scheme === "https") score += 10;
  return score;
}

function canonicalHttpOrigin(url: string): string | undefined {
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

function stableProjectionIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96) || "unknown";
}

function activatedHttpDomainEventPayload(
  projection: ActivatedHttpDomainProjection,
): Record<string, unknown> {
  return {
    url: projection.url,
    canonicalOrigin: projection.canonicalOrigin,
    exposureId: projection.exposureId,
    deploymentOutputRef: projection.deploymentOutputRef,
    activationEvidenceId: projection.activationEvidenceId,
    component: projection.component,
    host: projection.host,
    scheme: projection.scheme,
    listener: projection.listener,
    state: projection.state ?? "active",
    verifiedAt: projection.verifiedAt,
  };
}

function activatedHttpDomainInactiveEventPayload(input: {
  deploymentId: string;
  now: number;
}): Record<string, unknown> {
  return {
    activationEvidenceId: input.deploymentId,
    state: "inactive",
    verifiedAt: new Date(input.now).toISOString(),
  };
}

export async function handleCreateAppInstallation(input: {
  request: Request;
  store: AccountsStore;
  issuer: string;
  installer?: InstallerProxyOptions;
  launchTokens?: LaunchTokenOptions;
  bindingMaterializer?: AppBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);

  const source = isRecord(body.source) ? body.source : {};
  const now = Date.now();
  const requestedInstallationId = stringValue(body.installationId);
  const accountId = stringValue(body.accountId);
  const spaceId = stringValue(body.spaceId);
  let appId = stringValue(body.appId);
  let sourceGitUrl = stringValue(source.gitUrl) ?? stringValue(source.url);
  let sourceRef = stringValue(source.ref);
  let sourceCommit = stringValue(source.commit);
  const sourceDigest = stringValue(source.digest) ??
    stringValue(source.sourceDigest);
  let planSnapshotDigest = stringValue(source.planSnapshotDigest) ??
    stringValue(body.planSnapshotDigest);
  let artifactDigest = stringValue(source.artifactDigest) ??
    stringValue(body.artifactDigest);
  const mode = appInstallationModeValue(body.mode);
  const billingAccountId = stringValue(
    body.billingAccountId ?? body.billing_account_id,
  );
  const createdBySubject = takosumiSubjectValue(body.createdBySubject);
  if (!accountId || !spaceId || !mode || !createdBySubject) {
    return json({
      error: "invalid_request",
      error_description:
        "accountId, spaceId, mode, and createdBySubject are required",
    }, 400);
  }
  const billingGuard = await assertBillingAllowsInstallationCreate({
    store: input.store,
    accountId,
    billingAccountId,
    plan: stringValue(body.plan) ?? stringValue(body.planCode),
    mode,
  });
  if (billingGuard) return billingGuard;
  const existingSpace = await input.store.findSpace(spaceId);
  if (existingSpace && existingSpace.accountId !== accountId) {
    return json({ error: "space_account_mismatch" }, 409);
  }
  if (input.installer && requestedInstallationId) {
    return json({
      error: "invalid_request",
      error_description:
        "installationId is assigned by the Takosumi installer for this Takosumi Accounts facade",
    }, 400);
  }
  if (
    (planSnapshotDigest !== undefined &&
      !isSha256DigestRef(planSnapshotDigest)) ||
    (artifactDigest !== undefined &&
      !isSha256DigestRef(artifactDigest))
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "source.planSnapshotDigest and source.artifactDigest must be sha256: digest references",
    }, 400);
  }
  if (input.installer) {
    const preflightBindings = appBindingRecordsFromValue({
      value: body.useEdges,
      installationId: "inst_core_apply_preflight",
      now,
    });
    if (preflightBindings instanceof Response) return preflightBindings;
    const preflightGrants = appGrantRecordsFromValue({
      value: body.permissionScopes,
      installationId: "inst_core_apply_preflight",
      now,
    });
    if (preflightGrants instanceof Response) return preflightGrants;
    const preflightConfirm = await appInstallationConfirmFromValue({
      value: body.confirm,
      bindings: preflightBindings,
      grants: preflightGrants,
    });
    if (preflightConfirm instanceof Response) return preflightConfirm;
    const preflightOidcClient = await oidcClientCreateRequestFromValue({
      value: body.oidcClients ?? body.oidcClient,
      installationId: "inst_core_apply_preflight",
      defaultIssuer: input.issuer,
      now,
    });
    if (preflightOidcClient instanceof Response) return preflightOidcClient;
  }
  const coreApply = input.installer
    ? await applyCoreInstallationForCloudProjection({
      installer: input.installer,
      spaceId,
      source,
      expectedCommit: sourceCommit,
      expectedSourceDigest: sourceDigest,
      expectedPlanSnapshotDigest: planSnapshotDigest,
    })
    : undefined;
  if (coreApply instanceof Response) return coreApply;
  if (coreApply) {
    appId = appId ?? coreApply.appId;
    sourceGitUrl = sourceGitUrl ?? coreApply.sourceUrl;
    sourceRef = sourceRef ?? coreApply.sourceRef;
    sourceCommit = sourceCommit ?? coreApply.sourceCommit ??
      coreApply.sourceDigest;
    planSnapshotDigest = planSnapshotDigest ?? coreApply.planSnapshotDigest;
    artifactDigest = artifactDigest ??
      coreApply.artifactDigest;
  }
  const installationId = requestedInstallationId ??
    coreApply?.installationId ??
    `inst_${crypto.randomUUID()}`;
  // Duplicate guard. NOTE: this is a check-then-act, not an atomic
  // conditional insert. `saveAppInstallation` later overwrites on conflict
  // (D1 `INSERT OR REPLACE`; Postgres `ON CONFLICT DO UPDATE`), so two
  // concurrent creates with the same caller-influenced installationId can
  // both pass this check and the second silently overwrites the first. The
  // common path is safe: when `input.installer` is wired the space installer
  // assigns the id (a caller-supplied requestedInstallationId is rejected
  // above), and space-assigned/random ids do not collide. Fully closing the
  // no-installer + caller-supplied-id race requires an atomic putIfAbsent
  // on `saveAppInstallation` in the store implementations.
  if (await input.store.findAppInstallation(installationId)) {
    return json({ error: "installation_already_exists" }, 409);
  }
  if (
    !accountId ||
    !spaceId ||
    !appId ||
    !sourceGitUrl ||
    !sourceRef ||
    !sourceCommit ||
    !planSnapshotDigest ||
    !mode ||
    !createdBySubject
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "accountId, spaceId, appId, source.gitUrl/url, source.ref, source.commit, source.planSnapshotDigest, mode, and createdBySubject are required",
    }, 400);
  }
  // These fields are digest-typed integrity attestations recorded in the
  // ledger (surfaced as plan_snapshot_digest); reject values that are not a
  // `sha256:`-prefixed digest reference so the provenance the ledger claims is
  // not weakened by arbitrary junk strings.
  if (
    !isSha256DigestRef(planSnapshotDigest) ||
    (artifactDigest !== undefined &&
      !isSha256DigestRef(artifactDigest))
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "source.planSnapshotDigest and source.artifactDigest must be sha256: digest references",
    }, 400);
  }

  const status = appInstallationStatusValue(body.status) ??
    (coreApply ? "ready" : "installing");
  let runtimeBinding = runtimeBindingFromValue({
    value: body.runtimeTarget,
    installationId,
    mode,
    now,
  });
  let runtimeBindingAutoAssigned = false;
  if (
    !runtimeBinding &&
    mode === "shared-cell" &&
    input.sharedCellRuntime
  ) {
    runtimeBinding = await input.sharedCellRuntime({
      installationId,
      accountId,
      spaceId,
      appId,
      createdBySubject,
      now,
    });
    if (!runtimeBinding) {
      return json({
        error: "shared_cell_capacity_unavailable",
        error_description:
          "shared-cell install requires an available warm runtime slot",
      }, 503);
    }
    if (
      runtimeBinding.installationId !== installationId ||
      runtimeBinding.mode !== "shared-cell" ||
      runtimeBinding.targetType !== "shared-cell"
    ) {
      return json({
        error: "invalid_shared_cell_runtime_target",
        error_description:
          "shared-cell runtime allocator must return a shared-cell runtime target for the requested installation",
      }, 500);
    }
    runtimeBindingAutoAssigned = true;
  }
  const runtimeBindingId = runtimeBinding?.runtimeBindingId ??
    stringValue(body.runtimeTargetId);
  const bindingsResult = appBindingRecordsFromValue({
    value: body.useEdges,
    installationId,
    now,
  });
  if (bindingsResult instanceof Response) return bindingsResult;
  const bindingDeclarations = appBindingDeclarationsFromValue(body.useEdges);
  if (bindingDeclarations instanceof Response) return bindingDeclarations;
  const grantsResult = appGrantRecordsFromValue({
    value: body.permissionScopes,
    installationId,
    now,
  });
  if (grantsResult instanceof Response) return grantsResult;
  const confirmResult = await appInstallationConfirmFromValue({
    value: body.confirm,
    bindings: bindingsResult,
    grants: grantsResult,
  });
  if (confirmResult instanceof Response) return confirmResult;
  const oidcClientResult = await oidcClientCreateRequestFromValue({
    value: body.oidcClients ?? body.oidcClient,
    installationId,
    defaultIssuer: input.issuer,
    now,
  });
  if (oidcClientResult instanceof Response) return oidcClientResult;
  const bindings = materializeOidcClientBinding({
    bindings: bindingsResult,
    oidcClient: oidcClientResult,
    installationId,
    now,
  });
  if (bindings instanceof Response) return bindings;
  const launchTokenMaterialization = materializeLaunchTokenBindings({
    bindings,
    launchTokens: input.launchTokens,
    installationId,
    now,
  });
  if (launchTokenMaterialization instanceof Response) {
    return launchTokenMaterialization;
  }

  // Opportunistic LedgerAccount create with a check-and-set guard. Two
  // concurrent installs that claim the same accountId could otherwise both
  // pass the existence check and either overwrite the row or race the
  // creation. We:
  //   1. Resolve the existing row (if any) and reject 409 immediately when
  //      the requester's subject does not match the recorded owner.
  //   2. Persist the new row only when no record exists, then read it back
  //      to confirm we are the legal owner. If someone else won the race we
  //      respond 409 instead of silently re-binding the account to them.
  const existingLedgerAccount = await input.store.findLedgerAccount(accountId);
  if (existingLedgerAccount) {
    if (existingLedgerAccount.legalOwnerSubject !== createdBySubject) {
      return json({
        error: "account_claim_conflict",
        error_description:
          "accountId is already owned by a different Takosumi subject",
      }, 409);
    }
  } else {
    await input.store.saveLedgerAccount({
      accountId,
      legalOwnerSubject: createdBySubject,
      billingAccountId,
      createdAt: now,
      updatedAt: now,
    });
    const confirmedLedgerAccount = await input.store.findLedgerAccount(
      accountId,
    );
    if (
      !confirmedLedgerAccount ||
      confirmedLedgerAccount.legalOwnerSubject !== createdBySubject
    ) {
      return json({
        error: "account_claim_conflict",
        error_description:
          "accountId was claimed by another install while creating this one",
      }, 409);
    }
  }
  if (!existingSpace) {
    await input.store.saveSpace({
      spaceId,
      accountId,
      kind: spaceKindValue(body.spaceKind) ?? "personal",
      displayName: stringValue(body.spaceDisplayName),
      createdAt: now,
      updatedAt: now,
    });
  }

  const installation: InstallationRecord = {
    installationId,
    accountId,
    spaceId,
    appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    planSnapshotDigest,
    artifactDigest,
    mode,
    runtimeBindingId,
    billingAccountId,
    status,
    createdBySubject,
    createdAt: now,
    updatedAt: now,
  };
  const bindingMaterialization = await materializeConfiguredAppBindings({
    bindings: launchTokenMaterialization.bindings,
    declarations: bindingDeclarations,
    materializer: input.bindingMaterializer,
    installation,
    issuer: input.issuer,
    now,
  });
  if (bindingMaterialization instanceof Response) return bindingMaterialization;
  await input.store.saveAppInstallation(installation);
  if (runtimeBinding) await input.store.saveRuntimeBinding(runtimeBinding);
  for (const binding of bindingMaterialization.bindings) {
    await input.store.saveAppBinding(binding);
  }
  for (const grant of grantsResult) {
    await input.store.saveAppGrant(grant);
  }
  if (oidcClientResult) {
    await input.store.saveOidcClient(oidcClientResult.client);
  }
  await appendLedgerEvent(input.store, {
    installationId,
    eventType: "installation.created",
    payload: {
      appId,
      accountId,
      spaceId,
      mode,
      status,
      ...(billingAccountId ? { billingAccountId } : {}),
    },
    now,
  });
  if (coreApply?.activatedHttpDomain) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: installationActivatedHttpDomainEvent,
      payload: activatedHttpDomainEventPayload(coreApply.activatedHttpDomain),
      now,
    });
  }
  if (confirmResult) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "installation.approved",
      payload: {
        permissionDigest: confirmResult.permissionDigest,
        costAck: confirmResult.costAck,
        ...(confirmResult.approvalRequired !== undefined
          ? { approvalRequired: confirmResult.approvalRequired }
          : {}),
        ...(confirmResult.expiresAt
          ? { expiresAt: confirmResult.expiresAt }
          : {}),
      },
      now,
    });
  }
  if (oidcClientResult) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "oidc_client.registered",
      payload: {
        clientId: oidcClientResult.client.clientId,
        servicePath: oidcClientResult.client.namespacePath,
        // Existing ledger readers may still read namespacePath in old events.
        namespacePath: oidcClientResult.client.namespacePath,
        issuerUrl: oidcClientResult.client.issuerUrl,
        redirectUris: oidcClientResult.client.redirectUris,
        allowedScopes: oidcClientResult.client.allowedScopes,
        subjectMode: oidcClientResult.client.subjectMode,
        tokenEndpointAuthMethod:
          oidcClientResult.client.tokenEndpointAuthMethod,
      },
      now,
    });
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "use_edge.materialized",
      payload: {
        useEdge: oidcClientResult.binding,
        kind: "identity.oidc@v1",
        configRef: oidcBindingConfigRef({
          installationId,
          binding: oidcClientResult.binding,
          clientId: oidcClientResult.client.clientId,
        }),
        secretRefs: oidcClientResult.clientSecret
          ? [
            oidcBindingClientSecretRef({
              installationId,
              binding: oidcClientResult.binding,
            }),
          ]
          : [],
      },
      now,
    });
  }
  if (runtimeBindingAutoAssigned && runtimeBinding) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "runtime_target.assigned",
      payload: {
        runtimeTargetId: runtimeBinding.runtimeBindingId,
        mode: runtimeBinding.mode,
        targetType: runtimeBinding.targetType,
        targetId: runtimeBinding.targetId,
      },
      now,
    });
  }
  for (const binding of launchTokenMaterialization.materialized) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "use_edge.materialized",
      payload: {
        useEdge: binding.name,
        kind: "install-launch-token@v1",
        configRef: binding.configRef,
        secretRefs: [],
      },
      now,
    });
  }
  for (const binding of bindingMaterialization.materialized) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "use_edge.materialized",
      payload: {
        useEdge: binding.name,
        kind: binding.kind,
        configRef: binding.configRef,
        secretRefs: binding.secretRefs,
      },
      now,
    });
  }

  const envelope = installationEnvelope({
    installation,
    bindings: bindingMaterialization.bindings,
    grants: grantsResult,
    runtimeBinding,
    oidcClient: oidcClientResult?.client,
    activatedHttpDomain: coreApply?.activatedHttpDomain,
    eventsUrl: takosumiAccountsInstallationEventsPath(installationId),
  });
  return json(
    {
      ...envelope,
      ...(oidcClientResult?.clientSecret
        ? { oidc_client_secret: oidcClientResult.clientSecret }
        : {}),
      ...(Object.keys(bindingMaterialization.env).length > 0
        ? { use_edge_env: bindingMaterialization.env }
        : {}),
    },
    202,
    {
      location: takosumiAccountsInstallationPath(installationId),
    },
  );
}

export async function handleImportAppInstallation(input: {
  request: Request;
  store: AccountsStore;
  issuer: string;
  launchTokens?: LaunchTokenOptions;
  bindingMaterializer?: AppBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
  importDataRestorer?: AppInstallationImportDataRestorer;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  let bundle: AccountsInstallationExportBundle;
  try {
    bundle = parseAccountsInstallationExportBundle(body.bundle);
  } catch (error) {
    console.error(
      "import_bundle_parse_failed",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_request",
      error_description: "installation export bundle is invalid",
    }, 400);
  }
  const accountId = stringValue(body.targetAccountId) ??
    stringValue(body.accountId);
  const spaceId = stringValue(body.targetSpaceId) ?? stringValue(body.spaceId);
  const createdBySubject = takosumiSubjectValue(
    body.createdBySubject ?? body.subject,
  );
  const mode = body.mode === undefined
    ? undefined
    : body.mode === "dedicated" || body.mode === "self-hosted"
    ? body.mode
    : undefined;
  if (
    !accountId ||
    !spaceId ||
    !createdBySubject ||
    (body.mode !== undefined && !mode)
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "accountId/targetAccountId, spaceId/targetSpaceId, createdBySubject/subject, and optional mode=dedicated|self-hosted are required",
    }, 400);
  }
  let importData;
  try {
    importData = await parseAppInstallationImportData(body.data);
  } catch (error) {
    console.error(
      "import_data_parse_failed",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_import_data",
      error_description: "import data is invalid",
    }, 400);
  }
  if (importData && !input.importDataRestorer) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Import with provider data is temporarily unavailable.",
    }, 503);
  }

  let plan;
  try {
    plan = planInstallationImport({
      bundle,
      targetIssuer: stringValue(body.targetIssuer) ??
        stringValue(body.authIssuer) ?? input.issuer,
      targetAccountId: accountId,
      targetSpaceId: spaceId,
      targetInstallationId: stringValue(body.targetInstallationId) ??
        stringValue(body.installationId),
      createdBySubject,
      ...(mode ? { mode } : {}),
    });
  } catch (error) {
    console.error(
      "import_bundle_plan_failed",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_import_bundle",
      error_description: "installation export bundle could not be planned",
    }, 400);
  }

  const createResponse = await handleCreateAppInstallation({
    request: new Request(input.request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan.request),
    }),
    store: input.store,
    issuer: input.issuer,
    launchTokens: input.launchTokens,
    bindingMaterializer: input.bindingMaterializer,
    sharedCellRuntime: input.sharedCellRuntime,
  });
  if (createResponse.status >= 400) return createResponse;

  const created = await createResponse.json();
  const installationId = stringValue(plan.request.installationId);
  let dataRestore;
  let dataRestoreEvent;
  let dataRestoreInstallation;
  if (installationId) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "installation.import-planned",
      payload: {
        bundleKind: plan.bundleKind,
        sourceIssuer: plan.sourceIssuer,
        targetIssuer: plan.targetIssuer,
      },
      now: Date.now(),
    });
    if (importData && input.importDataRestorer) {
      const installation = await input.store.findAppInstallation(
        installationId,
      );
      if (!installation) {
        return json({
          error: "installation_not_found",
          error_description:
            "imported installation disappeared before data restore",
        }, 404);
      }
      try {
        const result = await input.importDataRestorer({
          installation,
          bundle,
          importPlan: plan,
          dataManifest: importData.manifest,
          entries: importData.entries,
        });
        const restoredEntries = result.restoredEntries ??
          importData.entries.map((entry) => entry.path);
        dataRestoreEvent = await appendLedgerEvent(input.store, {
          installationId,
          eventType: "installation.import-data-restored",
          payload: {
            entries: restoredEntries,
            manifestKind: importData.manifest?.kind ?? null,
            evidence: result.evidence ?? {},
          },
          now: Date.now(),
        });
        dataRestore = {
          status: "restored",
          entries: restoredEntries,
          ...(result.evidence ? { evidence: result.evidence } : {}),
        };
      } catch (error) {
        // The full error is recorded server-side (ledger) for operators, but
        // the client-facing response only carries a fixed safe message so we
        // never echo restorer/driver internals back to callers.
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        console.error(
          "import_data_restore_failed",
          error instanceof Error ? error.stack ?? error.message : String(error),
        );
        await appendImportDataRestoreFailure({
          store: input.store,
          installation,
          error: errorMessage,
        });
        dataRestoreInstallation = await input.store.findAppInstallation(
          installationId,
        );
        dataRestore = {
          status: "failed",
          error: "import data restore failed",
        };
      }
    }
  }

  return json(
    {
      ...created,
      ...(dataRestoreInstallation
        ? { installation: serializeAppInstallation(dataRestoreInstallation) }
        : {}),
      import_plan: {
        bundle_kind: plan.bundleKind,
        source_issuer: plan.sourceIssuer,
        target_issuer: plan.targetIssuer,
      },
      ...(dataRestore ? { data_restore: dataRestore } : {}),
      ...(dataRestoreEvent
        ? { data_restore_event: serializeInstallationEvent(dataRestoreEvent) }
        : {}),
    },
    createResponse.status,
    {
      ...(createResponse.headers.get("location")
        ? { location: createResponse.headers.get("location") ?? "" }
        : {}),
    },
  );
}

async function oidcClientCreateRequestFromValue(input: {
  value: unknown;
  installationId: string;
  defaultIssuer: string;
  now: number;
}): Promise<
  | { binding: string; client: OidcClientRecord; clientSecret?: string }
  | undefined
  | Response
> {
  if (input.value === undefined) return undefined;
  const value = Array.isArray(input.value)
    ? input.value.length === 1 ? input.value[0] : undefined
    : input.value;
  if (!isRecord(value)) {
    return json({
      error: "invalid_oidc_clients",
      error_description: "oidcClients must contain exactly one client object",
    }, 400);
  }
  const redirectUris = oidcRedirectUrisValue(value.redirectUris);
  const authMethod = oidcClientAuthMethodValue(
    value.tokenEndpointAuthMethod ?? value.token_endpoint_auth_method,
  ) ?? "client_secret_post";
  if (hasRemovedOidcNamespaceAlias(value)) {
    return json({
      error: "invalid_oidc_clients",
      error_description:
        "oidcClients entries use servicePath; serviceId/service_id are not accepted",
    }, 400);
  }
  // Accept namespacePath aliases for existing API callers; new requests use servicePath.
  const namespacePathInput = value.servicePath ?? value.service_path ??
    value.namespacePath ?? value.namespace_path;
  const namespacePathValue = namespacePathInput;
  const issuerUrlInput = value.issuerUrl ?? value.issuer_url;
  const allowedScopesInput = value.allowedScopes ?? value.allowed_scopes;
  const subjectMode = value.subjectMode ?? value.subject_mode ?? "pairwise";
  const binding = stringValue(value.useEdge) ?? "auth";
  const namespacePath = oidcNamespacePathValue(namespacePathValue) ??
    "identity.primary.oidc";
  const issuerUrl = oidcIssuerUrlValue(issuerUrlInput) ?? input.defaultIssuer;
  const allowedScopes = oidcAllowedScopesValue(allowedScopesInput) ??
    ["openid"];
  if (
    !redirectUris ||
    (namespacePathValue !== undefined &&
      !oidcNamespacePathValue(namespacePathValue)) ||
    (issuerUrlInput !== undefined && !oidcIssuerUrlValue(issuerUrlInput)) ||
    (allowedScopesInput !== undefined &&
      !oidcAllowedScopesValue(allowedScopesInput)) ||
    subjectMode !== "pairwise"
  ) {
    return json({
      error: "invalid_oidc_clients",
      error_description:
        "oidcClients entries require redirectUris, optional useEdge, optional servicePath, optional issuerUrl, allowedScopes containing openid, and subjectMode pairwise",
    }, 400);
  }
  const clientSecret = authMethod === "none"
    ? undefined
    : `toc_${crypto.randomUUID().replaceAll("-", "")}`;
  return {
    binding,
    client: {
      clientId: stringValue(value.clientId) ?? `toc_${crypto.randomUUID()}`,
      installationId: input.installationId,
      namespacePath,
      issuerUrl,
      redirectUris,
      allowedScopes,
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: authMethod,
      clientSecretHash: clientSecret
        ? await sha256Text(`takosumi-oidc-client:${clientSecret}`)
        : undefined,
      createdAt: input.now,
      updatedAt: input.now,
    },
    clientSecret,
  };
}

function materializeOidcClientBinding(input: {
  bindings: readonly AppBindingRecord[];
  oidcClient:
    | { binding: string; client: OidcClientRecord; clientSecret?: string }
    | undefined;
  installationId: string;
  now: number;
}): readonly AppBindingRecord[] | Response {
  if (!input.oidcClient) return input.bindings;
  const index = input.bindings.findIndex((binding) =>
    binding.name === input.oidcClient?.binding
  );
  if (index < 0 || input.bindings[index].kind !== "identity.oidc@v1") {
    return json({
      error: "invalid_oidc_clients",
      error_description:
        "oidcClients[].useEdge must reference an identity.oidc@v1 use edge",
    }, 422);
  }
  const binding = input.bindings[index];
  const materialized: AppBindingRecord = {
    ...binding,
    configRef: oidcBindingConfigRef({
      installationId: input.installationId,
      binding: binding.name,
      clientId: input.oidcClient.client.clientId,
    }),
    secretRefs: input.oidcClient.clientSecret
      ? [oidcBindingClientSecretRef({
        installationId: input.installationId,
        binding: binding.name,
      })]
      : [],
    updatedAt: input.now,
  };
  try {
    assertValidAppBindingRecord(materialized);
  } catch (error) {
    console.error(
      "invalid_oidc_binding",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_bindings",
      error_description: "binding record is invalid",
    }, 422);
  }
  const bindings = [...input.bindings];
  bindings[index] = materialized;
  return bindings;
}

function bindingRef(
  installationId: string,
  binding: string,
  ...segments: string[]
): string {
  const tail = segments.map((s) => encodeURIComponent(s)).join("/");
  return `takosumi-accounts://installations/${
    encodeURIComponent(installationId)
  }/use-edges/${encodeURIComponent(binding)}/${tail}`;
}

function oidcBindingConfigRef(input: {
  installationId: string;
  binding: string;
  clientId: string;
}): string {
  return bindingRef(
    input.installationId,
    input.binding,
    "oidc-client",
    input.clientId,
  );
}

function oidcBindingClientSecretRef(input: {
  installationId: string;
  binding: string;
}): string {
  return bindingRef(
    input.installationId,
    input.binding,
    "secrets",
    "client-secret",
  );
}

function materializeLaunchTokenBindings(input: {
  bindings: readonly AppBindingRecord[];
  launchTokens: LaunchTokenOptions | undefined;
  installationId: string;
  now: number;
}): {
  bindings: readonly AppBindingRecord[];
  materialized: readonly AppBindingRecord[];
} | Response {
  if (!input.launchTokens) {
    return { bindings: input.bindings, materialized: [] };
  }
  const bindings: AppBindingRecord[] = [];
  const materialized: AppBindingRecord[] = [];
  for (const binding of input.bindings) {
    if (binding.kind !== "install-launch-token@v1") {
      bindings.push(binding);
      continue;
    }
    const next: AppBindingRecord = {
      ...binding,
      configRef: launchTokenBindingConfigRef({
        installationId: input.installationId,
        binding: binding.name,
      }),
      secretRefs: [],
      updatedAt: input.now,
    };
    try {
      assertValidAppBindingRecord(next);
    } catch (error) {
      console.error(
        "invalid_launch_token_binding",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return json({
        error: "invalid_bindings",
        error_description: "binding record is invalid",
      }, 422);
    }
    if (
      next.configRef !== binding.configRef ||
      next.secretRefs.length !== binding.secretRefs.length
    ) {
      materialized.push(next);
    }
    bindings.push(next);
  }
  return { bindings, materialized };
}

function launchTokenBindingConfigRef(input: {
  installationId: string;
  binding: string;
}): string {
  return bindingRef(input.installationId, input.binding, "launch-token");
}

async function materializeConfiguredAppBindings(input: {
  bindings: readonly AppBindingRecord[];
  declarations: ReadonlyMap<string, Record<string, unknown>>;
  materializer?: AppBindingMaterializer;
  installation: InstallationRecord;
  issuer: string;
  now: number;
}): Promise<
  | {
    bindings: readonly AppBindingRecord[];
    materialized: readonly AppBindingRecord[];
    env: Record<string, string>;
  }
  | Response
> {
  if (!input.materializer) {
    return { bindings: input.bindings, materialized: [], env: {} };
  }

  const bindings: AppBindingRecord[] = [];
  const materialized: AppBindingRecord[] = [];
  const env: Record<string, string> = {};
  for (const binding of input.bindings) {
    if (isBuiltinAccountsBinding(binding.kind)) {
      bindings.push(binding);
      continue;
    }
    let result: AppBindingMaterializationResult | undefined;
    try {
      result = await input.materializer({
        installation: input.installation,
        binding,
        declaration: input.declarations.get(binding.name),
        issuer: input.issuer,
      });
    } catch (error) {
      console.error(
        "binding_materialization_failed",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return json({
        error: "invalid_binding_materialization",
        error_description: "binding materialization failed",
      }, 422);
    }
    if (!result) {
      bindings.push(binding);
      continue;
    }
    const next: AppBindingRecord = {
      ...binding,
      configRef: result.configRef,
      secretRefs: result.secretRefs ?? [],
      updatedAt: input.now,
    };
    try {
      assertValidAppBindingRecord(next);
    } catch (error) {
      console.error(
        "invalid_materialized_binding",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return json({
        error: "invalid_binding_materialization",
        error_description: "binding materialization failed",
      }, 422);
    }
    for (const [key, value] of Object.entries(result.env ?? {})) {
      if (typeof value !== "string") {
        return json({
          error: "invalid_binding_materialization",
          error_description:
            `binding ${binding.name} env ${key} must be a string`,
        }, 422);
      }
      const existingKey = Object.keys(env).find((candidate) =>
        candidate.toUpperCase() === key.toUpperCase()
      );
      if (existingKey && env[existingKey] !== value) {
        return json({
          error: "invalid_binding_materialization",
          error_description:
            `binding env ${key} is produced by more than one binding`,
        }, 422);
      }
      env[existingKey ?? key] = value;
    }
    if (
      next.configRef !== binding.configRef ||
      next.secretRefs.join("\n") !== binding.secretRefs.join("\n")
    ) {
      materialized.push(next);
    }
    bindings.push(next);
  }
  return { bindings, materialized, env };
}

function isBuiltinAccountsBinding(kind: AppBindingKind): boolean {
  return kind === "identity.oidc@v1" || kind === "install-launch-token@v1";
}

export async function handleUpdateAppInstallationStatus(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const status = appInstallationStatusValue(body.status);
  if (!status) return json({ error: "invalid_request" }, 400);
  const requestedMode = body.mode === undefined
    ? undefined
    : appInstallationModeValue(body.mode);
  if (body.mode !== undefined && !requestedMode) {
    return json({ error: "invalid_request" }, 400);
  }
  const failedOperation = body.operation === undefined
    ? undefined
    : installationFailedOperationValue(body.operation);
  if (body.operation !== undefined && !failedOperation) {
    return json({ error: "invalid_request" }, 400);
  }
  if (failedOperation && !stringValue(body.operationId)) {
    return json({
      error: "invalid_request",
      error_description: "operationId is required when operation is provided",
    }, 400);
  }
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);

  let updated;
  const now = Date.now();
  try {
    updated = transitionAppInstallationStatus(installation, status, now);
  } catch (error) {
    console.error(
      "installation_status_conflict",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "state_conflict",
      error_description: "installation status transition is not allowed",
    }, 409);
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
        return json({
          error: "operation_already_closed",
          error_description:
            "materialize operation already has a completion event",
        }, 409);
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
  if (!body) return json({ error: "invalid_request" }, 400);
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);

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
  installer?: InstallerProxyOptions;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);
  if (installation.status !== "ready") {
    return json({
      error: "state_conflict",
      error_description: `${input.operation} requires a ready AppInstallation`,
    }, 409);
  }
  if (input.installer) {
    return await handleCoreInstallerBackedRevision({
      installationId: input.installationId,
      operation: input.operation,
      body,
      store: input.store,
      installer: input.installer,
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
  const planSnapshotDigest = stringValue(source.planSnapshotDigest) ??
    stringValue(body.planSnapshotDigest);
  const artifactDigest = stringValue(source.artifactDigest) ??
    stringValue(body.artifactDigest);
  if (!sourceRef || !sourceCommit || !planSnapshotDigest) {
    return json({
      error: "invalid_request",
      error_description:
        "source.ref, source.commit, and source.planSnapshotDigest are required",
    }, 400);
  }
  if (
    normalizeSourceGitUrl(sourceGitUrl) !==
      normalizeSourceGitUrl(installation.sourceGitUrl)
  ) {
    return json({
      error: "source_mismatch",
      error_description:
        "deployment and rollback must keep the installation source git URL",
    }, 409);
  }
  const appId = stringValue(body.appId);
  if (appId && appId !== installation.appId) {
    return json({
      error: "app_mismatch",
      error_description:
        "deployment and rollback must keep the installation appId",
    }, 409);
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
    planSnapshotDigest,
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
    planSnapshotDigest,
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

async function handleCoreInstallerBackedRevision(input: {
  installationId: string;
  operation: "deployment" | "rollback";
  body: Record<string, unknown>;
  store: AccountsStore;
  installer: InstallerProxyOptions;
  installation: InstallationRecord;
}): Promise<Response> {
  const now = Date.now();
  const source = isRecord(input.body.source) ? input.body.source : undefined;
  const expected = isRecord(input.body.expected)
    ? input.body.expected
    : undefined;

  if (input.operation === "rollback") {
    const coreRollback = await rollbackCoreDeploymentForCloudProjection({
      installer: input.installer,
      installationId: input.installationId,
      deploymentId: stringValue(input.body.deploymentId) ??
        stringValue(input.body.deployment_id),
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

  const sourceGitUrl = stringValue(source?.gitUrl) ??
    stringValue(source?.url) ?? input.installation.sourceGitUrl;
  const sourceRef = stringValue(source?.ref) ?? stringValue(input.body.ref) ??
    stringValue(input.body.to);
  const sourceCommit = stringValue(expected?.commit) ??
    stringValue(source?.commit) ?? stringValue(input.body.sourceCommit);
  const planSnapshotDigest = stringValue(expected?.planSnapshotDigest) ??
    stringValue(source?.planSnapshotDigest) ??
    stringValue(input.body.planSnapshotDigest);
  const artifactDigest = stringValue(source?.artifactDigest) ??
    stringValue(input.body.artifactDigest);
  if (!sourceRef || !sourceCommit || !planSnapshotDigest) {
    return json({
      error: "invalid_request",
      error_description:
        "deployment through the Takosumi installer requires source.ref plus expected.commit and expected.planSnapshotDigest from deployment dry-run",
    }, 400);
  }
  if (
    normalizeSourceGitUrl(sourceGitUrl) !==
      normalizeSourceGitUrl(input.installation.sourceGitUrl)
  ) {
    return json({
      error: "source_mismatch",
      error_description: "deployment must keep the installation source git URL",
    }, 409);
  }
  const appId = stringValue(input.body.appId);
  if (appId && appId !== input.installation.appId) {
    return json({
      error: "app_mismatch",
      error_description: "deployment must keep the installation appId",
    }, 409);
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
    planSnapshotDigest,
    artifactDigest: artifactDigest ?? null,
    requestedBindings,
    requestedGrants,
  });
  if (confirmResult instanceof Response) return confirmResult;

  const coreDeploy = await applyCoreDeploymentForCloudProjection({
    installer: input.installer,
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
      planSnapshotDigest,
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

function installationRecordFromCoreDeploymentProjection(input: {
  installation: InstallationRecord;
  projection: CoreDeploymentProjection;
  fallback?: {
    sourceGitUrl: string;
    sourceRef: string;
    sourceCommit: string;
    planSnapshotDigest: string;
    artifactDigest?: string;
  };
  now: number;
}): InstallationRecord {
  return {
    ...input.installation,
    sourceGitUrl: input.projection.sourceUrl ??
      input.fallback?.sourceGitUrl ??
      input.installation.sourceGitUrl,
    sourceRef: input.projection.sourceRef ??
      input.fallback?.sourceRef ??
      input.installation.sourceRef,
    sourceCommit: input.projection.sourceCommit ??
      input.projection.sourceDigest ??
      input.fallback?.sourceCommit ??
      input.installation.sourceCommit,
    planSnapshotDigest: input.projection.planSnapshotDigest ??
      input.fallback?.planSnapshotDigest ??
      input.installation.planSnapshotDigest,
    artifactDigest: input.projection.artifactDigest ??
      input.fallback?.artifactDigest ??
      input.installation.artifactDigest,
    updatedAt: input.now,
  };
}

async function revisionEnvelopeResponse(input: {
  store: AccountsStore;
  installation: InstallationRecord;
  operation: "deployment" | "rollback";
  event: InstallationEventRecord;
}): Promise<Response> {
  const bindings = await input.store.listAppBindingsForInstallation(
    input.installation.installationId,
  );
  const grants = await input.store.listAppGrantsForInstallation(
    input.installation.installationId,
  );
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installation.installationId,
  );
  const runtimeBinding = input.installation.runtimeBindingId
    ? await input.store.findRuntimeBinding(input.installation.runtimeBindingId)
    : undefined;
  const events = await input.store.listInstallationEvents(
    input.installation.installationId,
  );
  return json({
    ...installationEnvelope({
      installation: input.installation,
      bindings,
      grants,
      oidcClient,
      runtimeBinding,
      activatedHttpDomain: activatedHttpDomainProjectionFromEvents(events),
      eventsUrl: takosumiAccountsInstallationEventsPath(
        input.installation.installationId,
      ),
    }),
    operation: input.operation,
    event: serializeInstallationEvent(input.event),
  });
}

export async function handleDryRunAppInstallationDeployment(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
  installer?: InstallerProxyOptions;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);
  if (installation.status !== "ready") {
    return json({
      error: "state_conflict",
      error_description: "deployment dry-run requires a ready AppInstallation",
    }, 409);
  }
  if (input.installer) {
    const source = isRecord(body.source) ? body.source : undefined;
    const coreDryRun = await dryRunCoreDeploymentForCloudProjection({
      installer: input.installer,
      installationId: input.installationId,
      source,
    });
    if (coreDryRun instanceof Response) return coreDryRun;
    const sourceGitUrl = coreDryRun.sourceUrl ??
      stringValue(source?.gitUrl) ??
      stringValue(source?.url) ??
      installation.sourceGitUrl;
    const sourceRef = coreDryRun.sourceRef ??
      stringValue(source?.ref) ??
      stringValue(body.ref) ??
      stringValue(body.to) ??
      installation.sourceRef;
    const sourceCommit = coreDryRun.sourceCommit ??
      coreDryRun.sourceDigest ??
      stringValue(source?.commit) ??
      stringValue(body.sourceCommit) ??
      installation.sourceCommit;
    const planSnapshotDigest = coreDryRun.planSnapshotDigest;
    const artifactDigest = coreDryRun.artifactDigest ??
      stringValue(source?.artifactDigest) ??
      stringValue(body.artifactDigest) ??
      null;
    if (
      normalizeSourceGitUrl(sourceGitUrl) !==
        normalizeSourceGitUrl(installation.sourceGitUrl)
    ) {
      return json({
        error: "source_mismatch",
        error_description:
          "deployment dry-run must keep the installation source git URL",
      }, 409);
    }
    const appId = stringValue(body.appId);
    if (appId && appId !== installation.appId) {
      return json({
        error: "app_mismatch",
        error_description:
          "deployment dry-run must keep the installation appId",
      }, 409);
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

    const permissionDigest = await appInstallationRevisionPermissionDigest({
      operation: "deployment",
      installationId: input.installationId,
      appId: installation.appId,
      sourceGitUrl,
      sourceRef,
      sourceCommit,
      planSnapshotDigest,
      artifactDigest,
      requestedBindings,
      requestedGrants,
    });

    return json({
      operation: "deployment",
      installationId: input.installationId,
      source: {
        gitUrl: sourceGitUrl,
        ref: sourceRef,
        commit: sourceCommit,
        planSnapshotDigest,
        artifactDigest,
      },
      requestedUseEdges: requestedBindings.map(serializeAppBinding),
      requestedPermissionScopes: requestedGrants.map(serializeAppGrant),
      changes: isRecord(coreDryRun.payload) &&
          Array.isArray(coreDryRun.payload.changes)
        ? coreDryRun.payload.changes
        : [],
      expected: {
        ...(coreDryRun.expected ?? {}),
        permissionDigest,
        costAckRequired: requestedBindings.some((binding) =>
          isMeteredBindingKind(binding.kind)
        ),
      },
    });
  }

  const source = isRecord(body.source) ? body.source : {};
  const sourceGitUrl = stringValue(source.gitUrl) ??
    stringValue(source.url) ?? installation.sourceGitUrl;
  const sourceRef = stringValue(source.ref) ?? stringValue(body.ref) ??
    stringValue(body.to);
  const sourceCommit = stringValue(source.commit) ??
    stringValue(body.sourceCommit);
  const planSnapshotDigest = stringValue(source.planSnapshotDigest) ??
    stringValue(body.planSnapshotDigest);
  const artifactDigest = stringValue(source.artifactDigest) ??
    stringValue(body.artifactDigest);
  if (!sourceRef || !sourceCommit || !planSnapshotDigest) {
    return json({
      error: "invalid_request",
      error_description:
        "source.ref, source.commit, and source.planSnapshotDigest are required",
    }, 400);
  }
  if (
    normalizeSourceGitUrl(sourceGitUrl) !==
      normalizeSourceGitUrl(installation.sourceGitUrl)
  ) {
    return json({
      error: "source_mismatch",
      error_description:
        "deployment dry-run must keep the installation source git URL",
    }, 409);
  }
  const appId = stringValue(body.appId);
  if (appId && appId !== installation.appId) {
    return json({
      error: "app_mismatch",
      error_description: "deployment dry-run must keep the installation appId",
    }, 409);
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

  const permissionDigest = await appInstallationRevisionPermissionDigest({
    operation: "deployment",
    installationId: input.installationId,
    appId: installation.appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    planSnapshotDigest,
    artifactDigest: artifactDigest ?? null,
    requestedBindings,
    requestedGrants,
  });

  return json({
    operation: "deployment",
    installationId: input.installationId,
    source: {
      gitUrl: sourceGitUrl,
      ref: sourceRef,
      commit: sourceCommit,
      planSnapshotDigest,
      artifactDigest: artifactDigest ?? null,
    },
    requestedUseEdges: requestedBindings.map(serializeAppBinding),
    requestedPermissionScopes: requestedGrants.map(serializeAppGrant),
    expected: {
      permissionDigest,
      costAckRequired: requestedBindings.some((binding) =>
        isMeteredBindingKind(binding.kind)
      ),
    },
  });
}

export async function handleRequestAppInstallationMaterialize(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
  materializeWorker?: AppInstallationMaterializeWorker;
}): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(input.request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);

  const region = stringValue(body.region);
  const plan = body.plan === undefined
    ? {}
    : isRecord(body.plan)
    ? body.plan
    : undefined;
  const cutover = body.cutover === undefined
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
    return json({
      error: "invalid_request",
      error_description:
        "materialize requires mode=dedicated, region, object plan/cutover, and confirm.costAck=true",
    }, 400);
  }
  const permissionDigest = stringValue(
    confirm.permissionDigest ?? confirm.permission_digest,
  );
  const expectedPermissionDigest = await appInstallationMaterializeDigest({
    installationId: input.installationId,
    mode: "dedicated",
    region,
    plan,
    cutover,
  });
  if (!permissionDigest || !isSha256HexDigest(permissionDigest)) {
    return json({
      error: "invalid_confirm",
      error_description:
        "materialize confirm.permissionDigest=sha256:<64-hex> is required",
    }, 400);
  }
  if (!constantTimeEqual(permissionDigest, expectedPermissionDigest)) {
    return json({
      error: "approval_digest_mismatch",
      error_description:
        "confirm.permissionDigest does not match materialize request",
    }, 409);
  }
  const requestPayload: AppInstallationMaterializeRequest = {
    mode: "dedicated",
    region,
    plan,
    cutover,
    confirm: {
      costAck: true,
      permissionDigest,
    },
  };
  const requestDigest = await installationOperationRequestDigest(
    requestPayload,
  );

  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);
  const preserve = await materializePreservationSnapshot({
    store: input.store,
    installation,
  });
  const preserveDigest = await installationOperationRequestDigest(preserve);

  const operationId = await installationOperationId({
    installationId: input.installationId,
    operation: "materialize",
    idempotencyKey,
  });
  const events = await input.store.listInstallationEvents(
    input.installationId,
  );
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
        await installationOperationRequestDigest(existingPreserve);
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
  const inFlight = findInFlightInstallationOperation(events);
  if (inFlight) {
    return json({
      error: "installation_locked",
      error_description:
        `installation already has an in-flight ${inFlight.eventType} operation`,
    }, 409);
  }
  if (installation.status !== "ready" || installation.mode !== "shared-cell") {
    return json({
      error: "state_conflict",
      error_description:
        "materialize requires a ready shared-cell AppInstallation",
    }, 409);
  }

  const now = Date.now();
  const event = await appendLedgerEvent(input.store, {
    installationId: input.installationId,
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
    const workerBody = await completeAppInstallationMaterializeWithWorker({
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
  return json({
    ...materializeAcceptedBody({
      installation,
      operationId,
      region,
      preserve,
      preserveDigest,
    }),
    event: serializeInstallationEvent(event),
  }, 202);
}

export async function handleRequestAppInstallationExport(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
  exportWorker?: AppInstallationExportWorker;
}): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(input.request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);

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
    return json({
      error: "invalid_request",
      error_description:
        "export requires format=bundle with object encryption and scope",
    }, 400);
  }
  const encryptionMethod = stringValue(encryption.method) ?? "none";
  const encryptionRecipients = stringArrayValue(encryption.recipients) ?? [];
  if (
    (encryptionMethod !== "none" && encryptionMethod !== "age") ||
    (encryptionMethod === "age" && encryptionRecipients.length === 0)
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "export encryption.method must be none or age; age requires recipients",
    }, 400);
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
  if (!installation) return json({ error: "installation_not_found" }, 404);

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
    return json({
      error: "installation_locked",
      error_description:
        `installation already has an in-flight ${inFlight.eventType} operation`,
    }, 409);
  }
  if (
    installation.status === "installing" || installation.status === "exported"
  ) {
    return json({
      error: "state_conflict",
      error_description:
        "export requires an installation that is not installing or exported",
    }, 409);
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
  if (!installation) return json({ error: "installation_not_found" }, 404);
  const events = await input.store.listInstallationEvents(input.installationId);
  const event = events.find((entry) =>
    entry.eventType === installationExportRequestedEvent &&
    entry.payload.operationId === input.operationId
  );
  if (!event) return json({ error: "export_operation_not_found" }, 404);
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

/**
 * Serve a signed redirect to the underlying export artifact.
 *
 * Instead of issuing a plain 302 to whatever `downloadUrl` the export
 * worker recorded, the handler resigns the URL with HMAC-SHA256 using the
 * operator-configured secret (`TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET`)
 * and adds a short-lived `tk_exp` (5-minute default) parameter. The
 * downstream R2 / file handler is expected to call
 * `verifyExportDownloadUrl` and reject any request that lacks a valid
 * `tk_sig` or whose `tk_exp` has elapsed.
 *
 * When the signing secret is not configured, the response is `503
 * feature_unavailable` rather than an unsigned redirect: an unsigned URL
 * to a tenant-scoped artifact is a worse failure than refusing to serve
 * it.
 */
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
  if (!installation) return json({ error: "installation_not_found" }, 404);
  const events = await input.store.listInstallationEvents(input.installationId);
  const event = events.find((entry) =>
    entry.eventType === installationExportRequestedEvent &&
    entry.payload.operationId === input.operationId
  );
  if (!event) return json({ error: "export_operation_not_found" }, 404);
  const failed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportFailedEvent],
  });
  if (failed) {
    return json({
      error: "export_failed",
      error_description: stringValue(failed.payload.error) ?? "export failed",
    }, 409);
  }
  const completed = findOperationEvent({
    events,
    operationId: input.operationId,
    eventTypes: [installationExportedEvent],
  });
  if (!completed) {
    return json({
      error: "export_not_ready",
      error_description: "export artifact is not ready for download",
    }, 409);
  }
  const downloadUrl = stringValue(completed.payload.downloadUrl);
  if (!downloadUrl) return json({ error: "export_artifact_not_found" }, 404);
  try {
    const url = new URL(downloadUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError("unsupported protocol");
    }
  } catch {
    return json({ error: "invalid_export_download_url" }, 502);
  }
  const recordedExpiresAt = stringValue(completed.payload.downloadExpiresAt);
  if (recordedExpiresAt) {
    const expiresAtMs = Date.parse(recordedExpiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return json({ error: "invalid_export_download_expiry" }, 502);
    }
    if (expiresAtMs <= Date.now()) {
      return json({ error: "export_download_expired" }, 410);
    }
  }
  const signingSecret = input.exportDownloadSigningSecret ??
    readExportDownloadSigningSecretFromEnv();
  if (!signingSecret) {
    return json({
      error: "feature_unavailable",
      error_description:
        "export download signing secret is not configured; refusing to issue an unsigned redirect",
    }, 503);
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
    return json({ error: "invalid_export_download_url" }, 502);
  }
}

function appInstallationRevisionPayload(
  installation: InstallationRecord,
): Record<string, unknown> {
  return {
    source: {
      gitUrl: installation.sourceGitUrl,
      ref: installation.sourceRef,
      commit: installation.sourceCommit,
      planSnapshotDigest: installation.planSnapshotDigest,
      artifactDigest: installation.artifactDigest ?? null,
    },
  };
}

function normalizeSourceGitUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

export async function handleReportInstallationBillingUsage(input: {
  installationId: string;
  request: Request;
  store: AccountsStore;
}): Promise<Response> {
  const auth = await requireInstallationAccessTokenCapability({
    request: input.request,
    store: input.store,
    installationId: input.installationId,
    capability: "billing.usage.report",
  });
  if (!auth.ok) return auth.response;

  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return json({ error: "installation_not_found" }, 404);
  if (installation.status !== "ready") {
    return json({
      error: "state_conflict",
      error_description: "usage reports require a ready AppInstallation",
    }, 409);
  }
  if (!installation.billingAccountId) {
    return json({
      error: "billing_account_not_configured",
      error_description:
        "usage reports require an AppInstallation billingAccountId",
    }, 409);
  }

  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  const explicitBillingAccountId = stringValue(body.billingAccountId) ??
    stringValue(body.billing_account_id);
  if (
    explicitBillingAccountId &&
    explicitBillingAccountId !== installation.billingAccountId
  ) {
    return json({
      error: "billing_account_mismatch",
      error_description:
        "usage report billing account must match the AppInstallation",
    }, 409);
  }

  const meter = stringValue(body.meter);
  const quantity = positiveNumberValue(body.quantity);
  const unit = stringValue(body.unit);
  const periodStart = optionalTimestampValue(
    body.periodStart ?? body.period_start,
  );
  const periodEnd = optionalTimestampValue(body.periodEnd ?? body.period_end);
  const metadata = body.metadata === undefined
    ? {}
    : isPlainRecord(body.metadata) && isJsonValue(body.metadata)
    ? body.metadata
    : undefined;
  const idempotencyKey = stringValue(body.idempotencyKey) ??
    stringValue(body.idempotency_key);
  const explicitReportId = stringValue(body.reportId) ??
    stringValue(body.report_id);
  // When the caller supplies an idempotencyKey but no explicit reportId, derive
  // the usageReportId deterministically from `${installationId}:${idempotencyKey}`
  // so a concurrent duplicate (same key, no reportId) claims the SAME report id
  // and is deduped ATOMICALLY by the existing usageReportId claim
  // (D1 #putIfAbsentWithIndexes / Postgres ON CONFLICT (usage_report_id)),
  // instead of the previous non-atomic list-then-insert that double-billed under
  // concurrency. A random id is only used when neither reportId nor
  // idempotencyKey is present (no idempotency semantics requested).
  const derivedIdempotentReportId = (explicitReportId === undefined &&
      idempotencyKey !== undefined)
    ? `usage_${
      (await sha256HexText(`${input.installationId}:${idempotencyKey}`)).slice(
        "sha256:".length,
      )
    }`
    : undefined;
  const usageReportId = explicitReportId ?? derivedIdempotentReportId ??
    `usage_${crypto.randomUUID()}`;
  if (
    !meter ||
    !/^[a-z][a-z0-9_.:-]{0,95}$/.test(meter) ||
    quantity === undefined ||
    !unit ||
    unit.length > 32 ||
    periodStart === "invalid" ||
    periodEnd === "invalid" ||
    (periodStart !== undefined && periodEnd !== undefined &&
      periodEnd < periodStart) ||
    metadata === undefined ||
    (idempotencyKey !== undefined && idempotencyKey.length > 160) ||
    !/^usage_[A-Za-z0-9_-]{8,160}$/.test(usageReportId)
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "reportId, meter, positive quantity, unit, optional period, idempotencyKey, and JSON metadata are required",
    }, 400);
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
  const existingUsageReport = await input.store.findBillingUsageRecord(
    usageReportId,
  );
  if (existingUsageReport) {
    if (
      existingUsageReport.installationId !== input.installationId ||
      existingUsageReport.billingAccountId !== installation.billingAccountId
    ) {
      return json({
        error: "usage_report_id_conflict",
        error_description:
          "usage report id is already owned by another AppInstallation",
      }, 409);
    }
    if (existingUsageReport.requestDigest !== requestDigest) {
      return json({
        error: "usage_report_id_conflict",
        error_description:
          "usage report id was already used with a different request body",
      }, 409);
    }
    return json({
      usage_report: serializeBillingUsageRecord(existingUsageReport),
      duplicate: true,
    }, 200);
  }

  // When the reportId was derived from the idempotencyKey above, the
  // idempotency dedup is already covered ATOMICALLY by the usageReportId claim
  // (the findBillingUsageRecord early-return handles both the duplicate 200 and
  // the different-body 409). The list-then-find scan below is only needed for
  // the residual case where the caller supplies an EXPLICIT reportId that
  // reuses an idempotencyKey already attached to a different report; that
  // best-effort scan stays non-atomic but does not gate the double-bill path.
  const existingIdempotentReport = (idempotencyKey === undefined ||
      explicitReportId === undefined)
    ? undefined
    : (await input.store
      .listBillingUsageRecordsForInstallation(input.installationId)).find(
        (record) => record.idempotencyKey === idempotencyKey,
      );
  if (existingIdempotentReport) {
    if (existingIdempotentReport.requestDigest !== requestDigest) {
      return json({
        error: "idempotency_key_conflict",
        error_description:
          "idempotencyKey was already used with a different request body",
      }, 409);
    }
    return json({
      usage_report: serializeBillingUsageRecord(existingIdempotentReport),
      duplicate: true,
    }, 200);
  }

  const record: BillingUsageRecord = {
    usageReportId,
    installationId: input.installationId,
    billingAccountId: installation.billingAccountId,
    meter,
    quantity,
    unit,
    ...(periodStart === undefined ? {} : { periodStart }),
    ...(periodEnd === undefined ? {} : { periodEnd }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    requestDigest,
    metadata,
    ...(auth.record.takosumiSubject
      ? { reportedBySubject: auth.record.takosumiSubject }
      : {}),
    reportedAt: now,
  };
  await input.store.saveBillingUsageRecord(record);
  await appendLedgerEvent(input.store, {
    installationId: input.installationId,
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

function appBindingDeclarationsFromValue(
  value: unknown,
): ReadonlyMap<string, Record<string, unknown>> | Response {
  const declarations = new Map<string, Record<string, unknown>>();
  if (value === undefined) return declarations;
  if (!Array.isArray(value)) return json({ error: "invalid_use_edges" }, 400);
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return json({ error: "invalid_use_edges" }, 400);
    const name = stringValue(entry.name);
    if (!name) continue;
    const declaration = entry.declaration ?? entry.request;
    if (declaration === undefined) continue;
    if (!isRecord(declaration)) {
      return json({
        error: "invalid_use_edges",
        error_description:
          `useEdges[${index}].declaration must be an object when present`,
      }, 400);
    }
    declarations.set(name, declaration);
  }
  return declarations;
}

function appBindingRecordsFromValue(input: {
  value: unknown;
  installationId: string;
  now: number;
}): readonly AppBindingRecord[] | Response {
  if (input.value === undefined) return [];
  if (!Array.isArray(input.value)) {
    return json({ error: "invalid_use_edges" }, 400);
  }
  const records: AppBindingRecord[] = [];
  const seenNames = new Set<string>();
  for (const [index, value] of input.value.entries()) {
    if (!isRecord(value)) return json({ error: "invalid_use_edges" }, 400);
    const name = stringValue(value.name);
    const kind = appBindingKindValue(value.kind ?? value.type);
    const configRef = stringValue(value.configRef);
    const secretRefs = value.secretRefs === undefined
      ? []
      : stringArrayValue(value.secretRefs);
    if (!name || !kind || !configRef || !secretRefs) {
      return json({
        error: "invalid_use_edges",
        error_description:
          `useEdges[${index}] requires name, kind/type, configRef, and secretRefs`,
      }, 400);
    }
    if (seenNames.has(name)) {
      return json({
        error: "invalid_use_edges",
        error_description: `duplicate use edge name: ${name}`,
      }, 400);
    }
    seenNames.add(name);
    const record: AppBindingRecord = {
      bindingId: stringValue(value.useEdgeId) ?? `bind_${crypto.randomUUID()}`,
      installationId: input.installationId,
      name,
      kind,
      configRef,
      secretRefs,
      createdAt: input.now,
      updatedAt: input.now,
    };
    try {
      assertValidAppBindingRecord(record);
    } catch (error) {
      console.error(
        "invalid_use_edge_binding",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return json({
        error: "invalid_use_edges",
        error_description: "use edge binding record is invalid",
      }, 422);
    }
    records.push(record);
  }
  return records;
}

function appGrantRecordsFromValue(input: {
  value: unknown;
  installationId: string;
  now: number;
}): readonly AppGrantRecord[] | Response {
  if (input.value === undefined) return [];
  if (!Array.isArray(input.value)) {
    return json({ error: "invalid_permission_scopes" }, 400);
  }
  const records: AppGrantRecord[] = [];
  for (const [index, value] of input.value.entries()) {
    if (!isRecord(value)) {
      return json({ error: "invalid_permission_scopes" }, 400);
    }
    const capability = stringValue(value.capability);
    const scope = value.scope === undefined
      ? {}
      : isRecord(value.scope)
      ? value.scope
      : undefined;
    if (!capability || !scope) {
      return json({
        error: "invalid_permission_scopes",
        error_description:
          `permissionScopes[${index}] requires capability and optional object scope`,
      }, 400);
    }
    if (!isAppGrantCapability(capability)) {
      return json({
        error: "invalid_permission_scopes",
        error_description:
          `permissionScopes[${index}].capability is not in the v1 permission scope catalog`,
      }, 422);
    }
    records.push({
      grantId: stringValue(value.permissionScopeId) ??
        `grant_${crypto.randomUUID()}`,
      installationId: input.installationId,
      capability,
      scope,
      grantedAt: input.now,
    });
  }
  return records;
}

async function appInstallationConfirmFromValue(input: {
  value: unknown;
  bindings: readonly AppBindingRecord[];
  grants: readonly AppGrantRecord[];
}): Promise<AppInstallationConfirmRecord | Response | undefined> {
  if (input.value === undefined) return undefined;
  if (!isRecord(input.value)) {
    return json({
      error: "invalid_confirm",
      error_description: "confirm must be an object",
    }, 400);
  }
  const permissionDigest = stringValue(
    input.value.permissionDigest ?? input.value.permission_digest,
  );
  const costAck = input.value.costAck ?? input.value.cost_ack;
  const approvalRequired = booleanValue(
    input.value.approvalRequired ?? input.value.approval_required,
  );
  const expiresAt = stringValue(
    input.value.expiresAt ?? input.value.expires_at,
  );
  if (
    !permissionDigest ||
    !/^sha256:[0-9a-f]{64}$/.test(permissionDigest) ||
    (costAck !== undefined && typeof costAck !== "boolean") ||
    (approvalRequired !== undefined &&
      typeof approvalRequired !== "boolean")
  ) {
    return json({
      error: "invalid_confirm",
      error_description:
        "confirm requires permissionDigest=sha256:<64-hex> and optional boolean costAck/approvalRequired",
    }, 400);
  }
  const expectedPermissionDigest = await appInstallationPermissionDigest(input);
  if (permissionDigest !== expectedPermissionDigest) {
    return json({
      error: "approval_digest_mismatch",
      error_description:
        "confirm.permissionDigest does not match requested use edges and permission scopes",
      expected_permission_digest: expectedPermissionDigest,
    }, 409);
  }
  if (input.bindings.some((binding) => isMeteredBindingKind(binding.kind))) {
    if (costAck !== true) {
      return json({
        error: "cost_ack_required",
        error_description:
          "confirm.costAck=true is required when requested use edges include metered provider resources",
      }, 400);
    }
  }
  return {
    permissionDigest,
    costAck: costAck === true,
    ...(approvalRequired !== undefined ? { approvalRequired } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

async function appInstallationRevisionConfirmFromValue(input: {
  value: unknown;
  operation: "deployment" | "rollback";
  installationId: string;
  appId: string;
  sourceGitUrl: string;
  sourceRef: string;
  sourceCommit: string;
  planSnapshotDigest: string;
  artifactDigest: string | null;
  requestedBindings: readonly AppBindingRecord[];
  requestedGrants: readonly AppGrantRecord[];
}): Promise<{ permissionDigest: string; costAck: boolean } | Response> {
  if (!isRecord(input.value)) {
    return json({
      error: "invalid_confirm",
      error_description: "confirm must be an object",
    }, 400);
  }
  const permissionDigest = stringValue(
    input.value.permissionDigest ?? input.value.permission_digest,
  );
  const costAck = input.value.costAck ?? input.value.cost_ack;
  if (
    !permissionDigest ||
    !isSha256HexDigest(permissionDigest) ||
    (costAck !== undefined && typeof costAck !== "boolean")
  ) {
    return json({
      error: "invalid_confirm",
      error_description:
        "confirm requires permissionDigest=sha256:<64-hex> and optional boolean costAck",
    }, 400);
  }
  const expectedPermissionDigest =
    await appInstallationRevisionPermissionDigest(
      input,
    );
  if (!constantTimeEqual(permissionDigest, expectedPermissionDigest)) {
    return json({
      error: "approval_digest_mismatch",
      error_description:
        "confirm.permissionDigest does not match revision request",
      expected_permission_digest: expectedPermissionDigest,
    }, 409);
  }
  if (
    input.requestedBindings.some((binding) =>
      isMeteredBindingKind(binding.kind)
    ) && costAck !== true
  ) {
    return json({
      error: "cost_ack_required",
      error_description:
        "confirm.costAck=true is required when requested use edges include metered provider resources",
    }, 400);
  }
  return { permissionDigest, costAck: costAck === true };
}

async function appInstallationRevisionPermissionDigest(input: {
  operation: "deployment" | "rollback";
  installationId: string;
  appId: string;
  sourceGitUrl: string;
  sourceRef: string;
  sourceCommit: string;
  planSnapshotDigest: string;
  artifactDigest: string | null;
  requestedBindings: readonly AppBindingRecord[];
  requestedGrants: readonly AppGrantRecord[];
}): Promise<string> {
  return await sha256HexText(canonicalJson({
    operation: input.operation,
    installationId: input.installationId,
    appId: input.appId,
    source: {
      gitUrl: normalizeSourceGitUrl(input.sourceGitUrl),
      ref: input.sourceRef,
      commit: input.sourceCommit,
      planSnapshotDigest: input.planSnapshotDigest,
      artifactDigest: input.artifactDigest,
    },
    requestedBindings: input.requestedBindings
      .map(appBindingApprovalPayload)
      .sort(compareCanonicalJson),
    requestedGrants: input.requestedGrants
      .map(appGrantApprovalPayload)
      .sort(compareCanonicalJson),
  }));
}

function appBindingKindValue(value: unknown): AppBindingKind | undefined {
  return isAppBindingKind(value) ? value : undefined;
}

function appInstallationModeValue(
  value: unknown,
): AppInstallationMode | undefined {
  return value === "shared-cell" || value === "dedicated" ||
      value === "self-hosted"
    ? value
    : undefined;
}

function installationFailedOperationValue(
  value: unknown,
): "materialize" | "export" | undefined {
  return value === "materialize" || value === "export" ? value : undefined;
}

function spaceKindValue(value: unknown): SpaceKind | undefined {
  return value === "personal" || value === "team" || value === "org"
    ? value
    : undefined;
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

/**
 * Block paid installs when the BillingAccount cannot honor a paid charge.
 *
 * Plan vs status policy:
 *  - Statuses that block paid plans: `canceled`, `unpaid`, `past_due`,
 *    `disputed`. These all imply the customer cannot be charged reliably
 *    (subscription gone, dunning exhausted, dunning open, or active chargeback).
 *  - Free plan / shared-cell trial: always allowed. The operator runs these on
 *    operator-funded infrastructure so a delinquent payment method is not a
 *    blocker. `mode === "shared-cell"` plus an absent `plan` is treated as
 *    the free trial / shared-cell tier.
 *  - Other statuses (`active`, `trialing`, `incomplete`, `incomplete_expired`,
 *    `paused`) are allowed: `active`/`trialing` are paid-up;
 *    `incomplete`/`paused` are recoverable without operator intervention and
 *    install is part of normal recovery flow.
 *
 * The error envelope follows the closed Cloud envelope contract:
 *   `{ "error": "billing_required", "error_description": "..." }`
 * with HTTP 402 Payment Required, per RFC 9110.
 *
 * NOTE (merge): Agent 7 owns the rest of this file. This helper is appended
 * at the bottom and only called from the single insertion point inside
 * `handleCreateAppInstallation` near the `accountId/spaceId/mode/createdBySubject`
 * validation block. Future edits should NOT relocate it into the request
 * handler body or fold it into an unrelated guard.
 */
async function assertBillingAllowsInstallationCreate(input: {
  store: AccountsStore;
  accountId: string;
  billingAccountId: string | undefined;
  plan: string | undefined;
  mode: string;
}): Promise<Response | undefined> {
  const requestedPlan = input.plan?.toLowerCase();
  const isPaidPlan = installationPlanIsPaid({
    plan: requestedPlan,
    mode: input.mode,
  });
  if (!isPaidPlan) return undefined;

  const billingAccount = await resolveBillingAccountForGuard({
    store: input.store,
    accountId: input.accountId,
    billingAccountId: input.billingAccountId,
  });
  if (!billingAccount) return undefined;

  if (BILLING_BLOCKED_STATUSES_FOR_PAID_PLANS.has(billingAccount.status)) {
    return json({
      error: "billing_required",
      error_description:
        `billing account is in status \"${billingAccount.status}\"; resolve outstanding billing before installing a paid plan`,
    }, 402);
  }
  return undefined;
}

const BILLING_BLOCKED_STATUSES_FOR_PAID_PLANS: ReadonlySet<string> = new Set([
  "canceled",
  "unpaid",
  "past_due",
  "disputed",
]);

const FREE_PLAN_CODES: ReadonlySet<string> = new Set([
  "free",
  "trial",
  "shared-cell",
  "shared_cell",
]);

function installationPlanIsPaid(input: {
  plan: string | undefined;
  mode: string;
}): boolean {
  if (input.plan && FREE_PLAN_CODES.has(input.plan)) return false;
  // Treat shared-cell installs without an explicit paid plan code as the
  // operator-funded shared-cell trial tier and let them through.
  if (!input.plan && input.mode === "shared-cell") return false;
  return Boolean(input.plan);
}

async function resolveBillingAccountForGuard(input: {
  store: AccountsStore;
  accountId: string;
  billingAccountId: string | undefined;
}) {
  if (input.billingAccountId) {
    return await input.store.findBillingAccount(input.billingAccountId);
  }
  const ledger = await input.store.findLedgerAccount(input.accountId);
  if (ledger?.billingAccountId) {
    return await input.store.findBillingAccount(ledger.billingAccountId);
  }
  return undefined;
}
