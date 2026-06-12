/**
 * Shared helpers for the installation lifecycle route families.
 *
 * This module holds the cross-cutting pieces used by more than one of the
 * installation lifecycle route modules (create/import, status/uninstall/
 * revision, plan/materialize, export): the Takosumi deploy-control proxy
 * projection helpers, the activated-HTTP-domain projection helpers, the
 * shared use-edge / permission-scope request parsers, and the revision
 * permission-digest / confirm helpers. Behavior is identical to the prior
 * single-file implementation; these are pure moves.
 */
import { takosumiAccountsInstallationEventsPath } from "@takosjp/takosumi-accounts-contract";
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
} from "./ledger.ts";
import type { AccountsStore } from "./store.ts";
import { constantTimeEqual, sha256HexText } from "./encoding.ts";
import {
  type ActivatedHttpDomainProjection,
  activatedHttpDomainProjectionFromEvents,
  appBindingApprovalPayload,
  appGrantApprovalPayload,
  canonicalJson,
  compareCanonicalJson,
  installationEnvelope,
  isMeteredBindingKind,
  isSha256HexDigest,
  serializeInstallationEvent,
} from "./installation-helpers.ts";
import {
  errorJson,
  isRecord,
  json,
  stringArrayValue,
  stringValue,
} from "./http-helpers.ts";
import {
  type DeployControlProxyOptions,
  requestDeploymentApply,
  requestDeploymentPlanRun,
  requestInstallationApply,
  requestRollback,
} from "./deploy-control-proxy.ts";

export type { ActivatedHttpDomainProjection };

/**
 * Whitelist the fields we are willing to echo from an upstream deployControl
 * error envelope back to the Cloud caller. The deployControl (Takosumi)
 * may include implementation details, stack traces, or operator-private
 * context in its `payload`; surfacing those verbatim was an information
 * leak (Round 1 finding). Only `code`, `message`, the non-sensitive
 * correlation `requestId`, and `hint` are passed through; anything else is
 * dropped. The fields are read from the nested DeployControl envelope
 * (`payload.error.*`) with a fallback to a top-level shape.
 */
export function sanitizeUpstreamErrorPayload(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload)
  ) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  // The Deploy Control API closed error envelope nests its fields under `error`:
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

export interface AppInstallationConfirmRecord {
  readonly permissionDigest: string;
  readonly costAck: boolean;
  readonly approvalRequired?: boolean;
  readonly expiresAt?: string;
}

export interface CoreInstallationProjection {
  readonly installationId: string;
  readonly appId: string;
  readonly sourceUrl: string;
  readonly sourceRef: string;
  readonly sourceCommit?: string;
  readonly sourceDigest?: string;
  readonly planDigest: string;
  readonly artifactDigest?: string;
  readonly activatedHttpDomain?: ActivatedHttpDomainProjection;
}

export interface CoreDeploymentProjection {
  readonly deploymentId: string;
  readonly sourceUrl?: string;
  readonly sourceRef?: string;
  readonly sourceCommit?: string;
  readonly sourceDigest?: string;
  readonly planDigest: string;
  readonly artifactDigest?: string;
  readonly activatedHttpDomain?: ActivatedHttpDomainProjection;
  readonly expected?: Record<string, unknown>;
  readonly payload: unknown;
}

export async function applyCoreInstallationForCloudProjection(input: {
  deployControl: DeployControlProxyOptions;
  spaceId: string | undefined;
  source: Record<string, unknown>;
  expected: Record<string, unknown> | undefined;
  planRunId: string | undefined;
}): Promise<CoreInstallationProjection | Response> {
  const source = coreDeployControlSourceFromCloudSource(input.source);
  if (source instanceof Response) return source;
  if (!input.spaceId) {
    return errorJson("invalid_request", "spaceId is required", 400);
  }
  const body: Record<string, unknown> = {
    spaceId: input.spaceId,
    source,
  };
  if (input.planRunId) {
    body.planRunId = input.planRunId;
  }
  if (!input.expected || !isRecord(input.expected)) {
    return errorJson("invalid_request", "installation apply through Takosumi deploy control requires expected review guards", 400);
  }
  body.expected = { ...input.expected };
  const result = await requestInstallationApply({
    deployControl: input.deployControl,
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return errorJson(
      "failed_precondition",
      "Takosumi installation apply failed",
      result.status,
      undefined,
      {},
      upstream ? { upstream } : undefined,
    );
  }
  const projection = coreInstallationProjectionFromApply(result.payload);
  if (projection instanceof Response) return projection;
  return projection;
}

export async function planCoreDeploymentForCloudProjection(input: {
  deployControl: DeployControlProxyOptions;
  installationId: string;
  source: Record<string, unknown> | undefined;
}): Promise<CoreDeploymentProjection | Response> {
  const body = coreDeploymentRequestBodyFromCloudBody({ source: input.source });
  if (body instanceof Response) return body;
  const result = await requestDeploymentPlanRun({
    deployControl: input.deployControl,
    installationId: input.installationId,
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return errorJson(
      "failed_precondition",
      "Takosumi deployment PlanRun failed",
      result.status,
      undefined,
      {},
      upstream ? { upstream } : undefined,
    );
  }
  return coreDeploymentProjectionFromPlanRun(result.payload);
}

export async function applyCoreDeploymentForCloudProjection(input: {
  deployControl: DeployControlProxyOptions;
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
    return errorJson("invalid_request", "deployment apply through Takosumi deploy control requires expected review guards", 400);
  }
  const result = await requestDeploymentApply({
    deployControl: input.deployControl,
    installationId: input.installationId,
    body,
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return errorJson(
      "failed_precondition",
      "Takosumi deployment apply failed",
      result.status,
      undefined,
      {},
      upstream ? { upstream } : undefined,
    );
  }
  return coreDeploymentProjectionFromApply(result.payload);
}

export async function rollbackCoreDeploymentForCloudProjection(input: {
  deployControl: DeployControlProxyOptions;
  installationId: string;
  deploymentId: string | undefined;
  planRunId: string | undefined;
  expected: Record<string, unknown> | undefined;
}): Promise<CoreDeploymentProjection | Response> {
  if (!input.deploymentId) {
    return errorJson("invalid_request", "rollback through Takosumi deploy control requires deploymentId", 400);
  }
  const result = await requestRollback({
    deployControl: input.deployControl,
    installationId: input.installationId,
    body: {
      deploymentId: input.deploymentId,
      ...(input.planRunId ? { planRunId: input.planRunId } : {}),
      ...(input.expected ? { expected: input.expected } : {}),
    },
  });
  if (result.status < 200 || result.status >= 300) {
    const upstream = sanitizeUpstreamErrorPayload(result.payload);
    return errorJson(
      "failed_precondition",
      "Takosumi rollback failed",
      result.status,
      undefined,
      {},
      upstream ? { upstream } : undefined,
    );
  }
  return coreDeploymentProjectionFromRollback(result.payload);
}

export function coreDeploymentRequestBodyFromCloudBody(input: {
  source?: Record<string, unknown>;
  expected?: Record<string, unknown>;
}): Record<string, unknown> | Response {
  const body: Record<string, unknown> = {};
  if (input.source && Object.keys(input.source).length > 0) {
    const source = coreDeployControlSourceFromCloudSource(input.source);
    if (source instanceof Response) return source;
    body.source = source;
  }
  if (input.expected) body.expected = input.expected;
  return body;
}

export function coreDeployControlSourceFromCloudSource(
  source: Record<string, unknown>,
): Record<string, unknown> | Response {
  const kind = stringValue(source.kind) ?? "git";
  const url = stringValue(source.url);
  if (!url) {
    return errorJson("invalid_request", "source.url is required", 400);
  }
  if (kind === "git") {
    const ref = stringValue(source.ref);
    if (!ref) {
      return errorJson("invalid_request", "source.ref is required for git sources", 400);
    }
    return { kind: "git", url, ref };
  }
  if (kind === "prepared") {
    const digest = stringValue(source.digest);
    if (!digest) {
      return errorJson("invalid_request", "source.digest is required for prepared sources", 400);
    }
    return { kind: "prepared", url, digest };
  }
  if (kind === "local") {
    return { kind: "local", path: url };
  }
  return errorJson("invalid_request", "source.kind must be git, prepared, or local", 400);
}

export function coreInstallationProjectionFromApply(
  payload: unknown,
): CoreInstallationProjection | Response {
  if (!isRecord(payload)) {
    return errorJson("feature_unavailable", "Takosumi installation apply returned a non-object response", 502);
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
  const sourceUrl = stringValue(source?.url) ?? stringValue(source?.path);
  const sourceKind = stringValue(source?.kind);
  const sourceRef = stringValue(source?.ref) ?? stringValue(source?.digest) ??
    (sourceKind === "local" ? "local" : undefined);
  const sourceCommit = stringValue(source?.commit) ??
    stringValue(deployment?.sourceCommit) ??
    stringValue(deployment?.source_commit);
  const sourceDigest = stringValue(source?.digest);
  const planDigest = stringValue(deployment?.planDigest) ??
    stringValue(deployment?.plan_digest);
  const artifactDigest =
    stringValue(deployment?.artifactDigest) ??
      stringValue(deployment?.artifact_digest);
  const activatedHttpDomain = activatedHttpDomainProjectionFromCoreOutputs({
    deploymentId: stringValue(deployment?.id),
    outputs: deployment?.outputs,
    now: Date.now(),
  });
  if (
    !installationId || !appId || !sourceUrl || !sourceRef || !planDigest
  ) {
    return errorJson("feature_unavailable", "Takosumi installation apply response is missing installation/deployment projection fields", 502);
  }
  return {
    installationId,
    appId,
    sourceUrl,
    sourceRef,
    sourceCommit,
    sourceDigest,
    planDigest,
    artifactDigest,
    activatedHttpDomain,
  };
}

export function coreDeploymentProjectionFromPlanRun(
  payload: unknown,
): CoreDeploymentProjection | Response {
  if (!isRecord(payload)) {
    return errorJson("feature_unavailable", "Takosumi deployment PlanRun returned a non-object response", 502);
  }
  const projection = coreDeploymentProjectionFromDeploymentLike({
    deployment: payload,
    payload,
    fallbackDeploymentId: "plan-run",
  });
  if (projection instanceof Response) return projection;
  const expected = isRecord(payload.expected) ? payload.expected : undefined;
  return { ...projection, expected };
}

export function coreDeploymentProjectionFromApply(
  payload: unknown,
): CoreDeploymentProjection | Response {
  if (!isRecord(payload)) {
    return errorJson("feature_unavailable", "Takosumi deployment apply returned a non-object response", 502);
  }
  const deployment = isRecord(payload.deployment)
    ? payload.deployment
    : undefined;
  return coreDeploymentProjectionFromDeploymentLike({ deployment, payload });
}

export function coreDeploymentProjectionFromRollback(
  payload: unknown,
): CoreDeploymentProjection | Response {
  if (!isRecord(payload)) {
    return errorJson("feature_unavailable", "Takosumi rollback returned a non-object response", 502);
  }
  const deployment = isRecord(payload.deployment)
    ? payload.deployment
    : undefined;
  return coreDeploymentProjectionFromDeploymentLike({ deployment, payload });
}

export function coreDeploymentProjectionFromDeploymentLike(input: {
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
  const planDigest = stringValue(deployment?.planDigest) ??
    stringValue(deployment?.plan_digest) ??
    (isRecord(input.payload)
      ? stringValue(input.payload.planDigest) ??
        stringValue(input.payload.plan_digest)
      : undefined);
  const artifactDigest =
    stringValue(deployment?.artifactDigest) ??
      stringValue(deployment?.artifact_digest);
  const activatedHttpDomain = activatedHttpDomainProjectionFromCoreOutputs({
    deploymentId,
    outputs: deployment?.outputs,
    now: Date.now(),
  });
  if (!deploymentId || !planDigest) {
    return errorJson("feature_unavailable", "Takosumi deployment response is missing deployment projection fields", 502);
  }
  return {
    deploymentId,
    sourceUrl: stringValue(source?.url) ?? stringValue(source?.path),
    sourceRef: stringValue(source?.ref) ?? stringValue(source?.digest),
    sourceCommit: stringValue(source?.commit) ??
      stringValue(deployment?.sourceCommit) ??
      stringValue(deployment?.source_commit),
    sourceDigest: stringValue(source?.digest),
    planDigest,
    artifactDigest,
    activatedHttpDomain,
    payload: input.payload,
  };
}

export function activatedHttpDomainProjectionFromCoreOutputs(input: {
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

export function activatedHttpDomainCandidateFromCoreOutputs(
  outputs: unknown,
): {
  readonly url: string;
  readonly deploymentOutputRef: string;
  readonly component?: string;
  readonly host?: string;
  readonly scheme?: string;
  readonly listener?: string;
} | undefined {
  if (Array.isArray(outputs)) {
    const candidates = outputs
      .filter(isRecord)
      .flatMap((output, index) => {
        const kind = stringValue(output.kind);
        const name = stringValue(output.name);
        const value = stringValue(output.value);
        if (
          !value ||
          !canonicalHttpOrigin(value) ||
          !(
            kind === "launch_url" ||
            kind === "service_url" ||
            name === "launch_url" ||
            name === "takosumi_launch_url" ||
            name === "service_url" ||
            name === "takosumi_service_url"
          )
        ) {
          return [];
        }
        return [{
          url: value,
          deploymentOutputRef: `deployment.outputs.${index}`,
          component: name ?? kind,
        }];
      });
    return candidates.sort((left, right) =>
      activatedHttpDomainCandidateScore(right) -
      activatedHttpDomainCandidateScore(left)
    )[0];
  }
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

export function activatedHttpDomainCandidateFromOutputRecord(input: {
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

export function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find(isRecord);
}

export function activatedHttpDomainCandidateScore(input: {
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

export function canonicalHttpOrigin(url: string): string | undefined {
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

export function stableProjectionIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96) || "unknown";
}

export function activatedHttpDomainEventPayload(
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

export function activatedHttpDomainInactiveEventPayload(input: {
  deploymentId: string;
  now: number;
}): Record<string, unknown> {
  return {
    activationEvidenceId: input.deploymentId,
    state: "inactive",
    verifiedAt: new Date(input.now).toISOString(),
  };
}

export function installationRecordFromCoreDeploymentProjection(input: {
  installation: InstallationRecord;
  projection: CoreDeploymentProjection;
  fallback?: {
    sourceGitUrl: string;
    sourceRef: string;
    sourceCommit: string;
    planDigest: string;
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
    planDigest: input.projection.planDigest ??
      input.fallback?.planDigest ??
      input.installation.planDigest,
    artifactDigest: input.projection.artifactDigest ??
      input.fallback?.artifactDigest ??
      input.installation.artifactDigest,
    updatedAt: input.now,
  };
}

export async function revisionEnvelopeResponse(input: {
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

export function appInstallationRevisionPayload(
  installation: InstallationRecord,
): Record<string, unknown> {
  return {
    source: {
      gitUrl: installation.sourceGitUrl,
      ref: installation.sourceRef,
      commit: installation.sourceCommit,
      planDigest: installation.planDigest,
      artifactDigest: installation.artifactDigest ?? null,
    },
  };
}

export function normalizeSourceGitUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

export function appBindingRecordsFromValue(input: {
  value: unknown;
  installationId: string;
  now: number;
}): readonly AppBindingRecord[] | Response {
  if (input.value === undefined) return [];
  if (!Array.isArray(input.value)) {
    return errorJson("invalid_use_edges", "invalid use edges", 400);
  }
  const records: AppBindingRecord[] = [];
  const seenNames = new Set<string>();
  for (const [index, value] of input.value.entries()) {
    if (!isRecord(value)) return errorJson("invalid_use_edges", "invalid use edges", 400);
    const name = stringValue(value.name);
    const kind = appBindingKindValue(value.kind ?? value.type);
    const configRef = stringValue(value.configRef);
    const secretRefs = value.secretRefs === undefined
      ? []
      : stringArrayValue(value.secretRefs);
    if (!name || !kind || !configRef || !secretRefs) {
      return errorJson("invalid_use_edges", `useEdges[${index}] requires name, kind/type, configRef, and secretRefs`, 400);
    }
    if (seenNames.has(name)) {
      return errorJson("invalid_use_edges", `duplicate use edge name: ${name}`, 400);
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
      return errorJson("invalid_use_edges", "use edge binding record is invalid", 422);
    }
    records.push(record);
  }
  return records;
}

export function appGrantRecordsFromValue(input: {
  value: unknown;
  installationId: string;
  now: number;
}): readonly AppGrantRecord[] | Response {
  if (input.value === undefined) return [];
  if (!Array.isArray(input.value)) {
    return errorJson("invalid_permission_scopes", "invalid permission scopes", 400);
  }
  const records: AppGrantRecord[] = [];
  for (const [index, value] of input.value.entries()) {
    if (!isRecord(value)) {
      return errorJson("invalid_permission_scopes", "invalid permission scopes", 400);
    }
    const capability = stringValue(value.capability);
    const scope = value.scope === undefined
      ? {}
      : isRecord(value.scope)
      ? value.scope
      : undefined;
    if (!capability || !scope) {
      return errorJson("invalid_permission_scopes", `permissionScopes[${index}] requires capability and optional object scope`, 400);
    }
    if (!isAppGrantCapability(capability)) {
      return errorJson("invalid_permission_scopes", `permissionScopes[${index}].capability is not in the v1 permission scope catalog`, 422);
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

export async function appInstallationRevisionConfirmFromValue(input: {
  value: unknown;
  operation: "deployment" | "rollback";
  installationId: string;
  appId: string;
  sourceGitUrl: string;
  sourceRef: string;
  sourceCommit: string;
  planDigest: string;
  artifactDigest: string | null;
  requestedBindings: readonly AppBindingRecord[];
  requestedGrants: readonly AppGrantRecord[];
}): Promise<{ permissionDigest: string; costAck: boolean } | Response> {
  if (!isRecord(input.value)) {
    return errorJson("invalid_confirm", "confirm must be an object", 400);
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
    return errorJson("invalid_confirm", "confirm requires permissionDigest=sha256:<64-hex> and optional boolean costAck", 400);
  }
  const expectedPermissionDigest =
    await appInstallationRevisionPermissionDigest(
      input,
    );
  if (!constantTimeEqual(permissionDigest, expectedPermissionDigest)) {
    return errorJson(
      "approval_digest_mismatch",
      "confirm.permissionDigest does not match revision request",
      409,
      undefined,
      {},
      { expected_permission_digest: expectedPermissionDigest },
    );
  }
  if (
    input.requestedBindings.some((binding) =>
      isMeteredBindingKind(binding.kind)
    ) && costAck !== true
  ) {
    return errorJson("cost_ack_required", "confirm.costAck=true is required when requested use edges include metered provider resources", 400);
  }
  return { permissionDigest, costAck: costAck === true };
}

export async function appInstallationRevisionPermissionDigest(input: {
  operation: "deployment" | "rollback";
  installationId: string;
  appId: string;
  sourceGitUrl: string;
  sourceRef: string;
  sourceCommit: string;
  planDigest: string;
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
      planDigest: input.planDigest,
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

export function appBindingKindValue(value: unknown): AppBindingKind | undefined {
  return isAppBindingKind(value) ? value : undefined;
}

export function appInstallationModeValue(
  value: unknown,
): AppInstallationMode | undefined {
  return value === "shared-cell" || value === "dedicated" ||
      value === "self-hosted"
    ? value
    : undefined;
}
