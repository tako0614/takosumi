import type { JsonValue } from "takosumi-contract";
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import {
  APPLY_RUNS_PATH,
  DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_PATH,
  PLAN_RUN_PATH,
  PLAN_RUNS_PATH,
} from "@takosumi/internal/deploy-control-api";
import type {
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  DeployControlErrorCode,
  DeployControlErrorEnvelope,
  Deployment,
  DeploymentOutput,
  GetInstallationResponse,
  Installation,
  ListDeploymentsResponse,
  OpenTofuModuleSource,
  PlanRun,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";

/**
 * In-process typed deploy-control operations the facade depends on. This is the
 * contract-DTO subset of the host's `TakosumiOperations` facade (the wired
 * OpenTofu controller); the proxy calls these typed operations directly instead
 * of building a synthetic Request and dialing it back through the embedded Hono
 * router inside the same worker. Per AGENTS.md the control-plane and
 * account-plane handlers are composed in-process by both build targets, so this
 * is the only transport — there is no remote deploy-control origin.
 */
export interface DeployControlOperations {
  createPlanRun(request: CreatePlanRunRequest): Promise<PlanRunResponse>;
  getPlanRun(id: string): Promise<PlanRunResponse>;
  createApplyRun(request: CreateApplyRunRequest): Promise<ApplyRunResponse>;
  getInstallation(id: string): Promise<GetInstallationResponse>;
  listDeployments(installationId: string): Promise<ListDeploymentsResponse>;
  /**
   * Idempotent personal-Space creation for the account-plane first-login hook
   * (spec §4: "初回ログイン時に個人 Space を自動作成する"). Exposed on the
   * operations facade so the session-me route can call it fire-and-forget after
   * sign-in. The OAuth identity resolver intentionally stays side-effect free;
   * it does not own Space creation. `handle` must satisfy the spaces handle rule;
   * the account's username/slug if one exists, else `u-<short id>`.
   */
  ensurePersonalSpace?(
    ownerUserId: string,
    handle: string,
  ): Promise<{ readonly id: string }>;
}

export interface DeployControlProxyOptions {
  /**
   * In-process deploy-control facade. The proxy calls these typed operations
   * directly (no self-issued Bearer handshake, no JSON serialize/parse round-trip
   * through the embedded router) — the single-worker default and only transport.
   */
  operations: DeployControlOperations;
}

export async function handleInstallationPlanRunProxy(input: {
  request: Request;
  deployControl: DeployControlProxyOptions;
}): Promise<Response> {
  const bodyText = await input.request.text();
  const body = bodyText.length > 0
    ? JSON.parse(bodyText) as unknown
    : {};
  const result = await requestInstallationPlanRun({
    deployControl: input.deployControl,
    body: isRecord(body) ? body : {},
  });
  return responseFromProxyResult(result);
}

export async function requestInstallationPlanRun(input: {
  deployControl: DeployControlProxyOptions;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await createPlanRunForFacadeRequest({
    deployControl: input.deployControl,
    body: input.body,
    operation: "create",
  });
  return adaptPlanRunResult(plan);
}

export async function requestInstallationApply(input: {
  deployControl: DeployControlProxyOptions;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await resolveReviewedPlanRunForFacadeApply({
    deployControl: input.deployControl,
    body: input.body,
    operation: "create",
  });
  if (plan.status < 200 || plan.status >= 300) return plan;
  const planRun = planRunFromPayload(plan.payload);
  if (!planRun) return plan;
  if (planRun.status !== "succeeded") {
    return {
      status: 409,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "failed_precondition",
        error_description: `PlanRun ${planRun.id} is ${planRun.status}`,
        planRun,
      },
    };
  }
  const applyBody = applyRequestFromExpectedGuardResult({
    planRun,
    approval: isRecord(input.body.approval) ? input.body.approval : undefined,
    expected: isRecord(input.body.expected) ? input.body.expected : undefined,
  });
  if (!applyBody.ok) return applyBody.result;
  const apply = await requestDeployControlJson({
    deployControl: input.deployControl,
    method: "POST",
    path: APPLY_RUNS_PATH,
    body: applyBody.request,
  });
  return adaptApplyRunResult(apply);
}

export async function requestDeploymentPlanRun(input: {
  deployControl: DeployControlProxyOptions;
  installationId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await createPlanRunForFacadeRequest({
    deployControl: input.deployControl,
    body: input.body,
    operation: "update",
    installationId: input.installationId,
  });
  return adaptPlanRunResult(plan);
}

export async function requestDeploymentApply(input: {
  deployControl: DeployControlProxyOptions;
  installationId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await resolveReviewedPlanRunForFacadeApply({
    deployControl: input.deployControl,
    body: input.body,
    operation: "update",
    installationId: input.installationId,
  });
  if (plan.status < 200 || plan.status >= 300) return plan;
  const planRun = planRunFromPayload(plan.payload);
  if (!planRun) return plan;
  if (planRun.status !== "succeeded") {
    return {
      status: 409,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "failed_precondition",
        error_description: `PlanRun ${planRun.id} is ${planRun.status}`,
        planRun,
      },
    };
  }
  const applyBody = applyRequestFromExpectedGuardResult({
    planRun,
    expected: isRecord(input.body.expected) ? input.body.expected : undefined,
  });
  if (!applyBody.ok) return applyBody.result;
  const apply = await requestDeployControlJson({
    deployControl: input.deployControl,
    method: "POST",
    path: APPLY_RUNS_PATH,
    body: applyBody.request,
  });
  return adaptApplyRunResult(apply);
}

export async function requestRollback(input: {
  deployControl: DeployControlProxyOptions;
  installationId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const targetDeploymentId = stringValue(input.body.deploymentId) ??
    stringValue(input.body.deployment_id);
  const planRunId = stringValue(input.body.planRunId) ??
    stringValue(input.body.plan_run_id) ??
    (isRecord(input.body.expected)
      ? stringValue(input.body.expected.planRunId)
      : undefined);
  if (!targetDeploymentId) {
    return {
      status: 400,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "invalid_request",
        error_description:
          "rollback compatibility requires deploymentId for target redeploy",
      },
    };
  }
  if (!planRunId) {
    return {
      status: 400,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "invalid_request",
        error_description:
          "rollback apply requires reviewed planRunId from a reviewed PlanRun",
      },
    };
  }
  const deployments = await requestDeployControlJson<ListDeploymentsResponse>({
    deployControl: input.deployControl,
    method: "GET",
    path: INSTALLATION_DEPLOYMENTS_PATH(input.installationId),
  });
  if (deployments.status < 200 || deployments.status >= 300) return deployments;
  const target = isRecord(deployments.payload)
    ? (deployments.payload.deployments as readonly Deployment[] | undefined)
      ?.find((deployment) => deployment.id === targetDeploymentId)
    : undefined;
  if (!target) {
    return {
      status: 404,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "not_found",
        error_description:
          `Deployment ${targetDeploymentId} was not found in Installation ${input.installationId}`,
      },
    };
  }
  const applied = await requestDeploymentApply({
    deployControl: input.deployControl,
    installationId: input.installationId,
    body: {
      // The Space-direct Deployment no longer carries a `source`; the source
      // identity comes from the reviewed PlanRun (resolved by planRunId inside
      // requestDeploymentApply), so the rollback apply body only needs the
      // planRunId + the optional expected guard.
      planRunId,
      ...(isRecord(input.body.expected) ? { expected: input.body.expected } : {}),
    },
  });
  if (isRecord(applied.payload)) {
    applied.payload.rollback = { targetDeploymentId };
  }
  return applied;
}

async function resolveReviewedPlanRunForFacadeApply(input: {
  deployControl: DeployControlProxyOptions;
  body: Record<string, unknown>;
  operation: "create" | "update" | "destroy";
  installationId?: string;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const planRunId = stringValue(input.body.planRunId) ??
    stringValue(input.body.plan_run_id) ??
    (isRecord(input.body.expected)
      ? stringValue(input.body.expected.planRunId)
      : undefined);
  if (!planRunId) {
    return {
      status: 400,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "invalid_request",
        error_description:
          "apply requires reviewed planRunId from a reviewed PlanRun",
      },
    };
  }
  const result = await requestDeployControlJson<PlanRunResponse>({
    deployControl: input.deployControl,
    method: "GET",
    path: PLAN_RUN_PATH(planRunId),
  });
  if (result.status < 200 || result.status >= 300) return result;
  const planRun = planRunFromPayload(result.payload);
  if (!planRun) return result;
  if (planRun.operation !== input.operation) {
    return {
      status: 409,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "failed_precondition",
        error_description:
          `PlanRun ${planRun.id} operation is ${planRun.operation}; expected ${input.operation}`,
        planRun,
      },
    };
  }
  if (
    input.installationId &&
    planRun.installationId !== input.installationId
  ) {
    return {
      status: 409,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "failed_precondition",
        error_description:
          `PlanRun ${planRun.id} is not for Installation ${input.installationId}`,
        planRun,
      },
    };
  }
  return result;
}

async function createPlanRunForFacadeRequest(input: {
  deployControl: DeployControlProxyOptions;
  body: Record<string, unknown>;
  operation: "create" | "update" | "destroy";
  installationId?: string;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  let installation: Installation | undefined;
  if (input.installationId) {
    const installationResult = await requestDeployControlJson<GetInstallationResponse>({
      deployControl: input.deployControl,
      method: "GET",
      path: INSTALLATION_PATH(input.installationId),
    });
    if (
      installationResult.status < 200 ||
      installationResult.status >= 300
    ) {
      return installationResult;
    }
    installation = isRecord(installationResult.payload)
      ? installationResult.payload.installation as Installation | undefined
      : undefined;
  }

  // The Space-direct Installation no longer carries a `source` (its source
  // identity lives in the control plane behind `sourceId`, not resolvable
  // in-process here). The plan source must therefore come from the request
  // body; there is no Installation-derived fallback.
  const source = openTofuSourceFromRequestSource({
    source: isRecord(input.body.source) ? input.body.source : undefined,
  });
  if (!source) {
    return {
      status: 400,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "invalid_request",
        error_description: "source is required",
      },
    };
  }
  const spaceId = stringValue(input.body.spaceId) ??
    stringValue(input.body.space_id) ??
    installation?.spaceId;
  if (!spaceId) {
    return {
      status: 400,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "invalid_request",
        error_description: "spaceId is required",
      },
    };
  }

  const request: CreatePlanRunRequest = {
    spaceId,
    source,
    operation: input.operation,
    ...(input.installationId ? { installationId: input.installationId } : {}),
    ...(stringValue(input.body.runnerProfileId)
      ? { runnerProfileId: stringValue(input.body.runnerProfileId) }
      : {}),
    ...(isRecord(input.body.variables)
      ? {
        variables: input.body.variables as Readonly<Record<string, JsonValue>>,
      }
      : {}),
    ...(Array.isArray(input.body.requiredProviders)
      ? {
        requiredProviders: input.body.requiredProviders
          .filter((entry): entry is string => typeof entry === "string"),
      }
      : {}),
  };
  const response = await requestDeployControlJson<PlanRunResponse>({
    deployControl: input.deployControl,
    method: "POST",
    path: PLAN_RUNS_PATH,
    body: request,
  });
  if (installation && isRecord(response.payload)) {
    response.payload = {
      ...response.payload,
      currentDeploymentId: installation.currentDeploymentId,
    };
  }
  return response;
}

function applyRequestFromExpectedGuardResult(input: {
  planRun: PlanRun;
  approval?: Record<string, unknown>;
  expected?: Record<string, unknown>;
}):
  | { readonly ok: true; readonly request: CreateApplyRunRequest }
  | {
    readonly ok: false;
    readonly result: { status: number; contentType: string; payload: unknown };
  } {
  try {
    return {
      ok: true,
      request: applyRequestFromExpectedGuard(input),
    };
  } catch (error) {
    return {
      ok: false,
      result: {
        status: 400,
        contentType: "application/json; charset=utf-8",
        payload: {
          error: "invalid_request",
          error_description: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

function applyRequestFromExpectedGuard(input: {
  planRun: PlanRun;
  approval?: Record<string, unknown>;
  expected?: Record<string, unknown>;
}): CreateApplyRunRequest {
  const expected = input.expected;
  if (!expected) {
    throw new Error("apply requires expected guard fields from the reviewed PlanRun");
  }
  const sourceCommit = input.planRun.sourceCommit
    ? requiredExpectedString(expected, "sourceCommit")
    : undefined;
  const providerLockDigest = input.planRun.providerLockDigest
    ? requiredExpectedString(expected, "providerLockDigest")
    : undefined;
  const installationId = input.planRun.installationId
    ? requiredExpectedString(expected, "installationId")
    : undefined;
  const currentDeploymentId = input.planRun.installationId
    ? requiredExpectedNullableString(expected, "currentDeploymentId")
    : undefined;
  return {
    planRunId: input.planRun.id,
    ...(input.approval ? { approval: input.approval } : {}),
    expected: {
      planRunId: requiredExpectedString(expected, "planRunId"),
      ...(installationId ? { installationId } : {}),
      ...(input.planRun.installationId ? { currentDeploymentId } : {}),
      runnerProfileId: requiredExpectedString(expected, "runnerProfileId"),
      sourceDigest: requiredExpectedString(expected, "sourceDigest"),
      variablesDigest: requiredExpectedString(expected, "variablesDigest"),
      policyDecisionDigest: requiredExpectedString(expected, "policyDecisionDigest"),
      planDigest: requiredExpectedString(expected, "planDigest"),
      planArtifactDigest: requiredExpectedString(expected, "planArtifactDigest"),
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(providerLockDigest ? { providerLockDigest } : {}),
    },
  };
}

function requiredExpectedString(
  expected: Record<string, unknown>,
  key: string,
): string {
  const value = stringValue(expected[key]);
  if (!value) {
    throw new Error(`apply requires expected.${key} from the reviewed PlanRun`);
  }
  return value;
}

function requiredExpectedNullableString(
  expected: Record<string, unknown>,
  key: string,
): string | null {
  if (expected[key] === null) return null;
  return requiredExpectedString(expected, key);
}

function openTofuSourceFromRequestSource(input: {
  source: Record<string, unknown> | undefined;
  fallback?: OpenTofuModuleSource;
}): OpenTofuModuleSource | undefined {
  if (!input.source) return input.fallback;
  const kind = stringValue(input.source.kind) ?? input.fallback?.kind ?? "git";
  const modulePath = stringValue(input.source.modulePath);
  if (kind === "git") {
    const url = stringValue(input.source.url) ??
      (input.fallback?.kind === "git" ? input.fallback.url : undefined);
    if (!url) return undefined;
    return {
      kind: "git",
      url,
      ref: stringValue(input.source.ref) ??
        (input.fallback?.kind === "git" ? input.fallback.ref : undefined),
      commit: stringValue(input.source.commit) ??
        (input.fallback?.kind === "git" ? input.fallback.commit : undefined),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  if (kind === "prepared") {
    const url = stringValue(input.source.url) ??
      (input.fallback?.kind === "prepared" ? input.fallback.url : undefined);
    const digest = stringValue(input.source.digest) ??
      (input.fallback?.kind === "prepared" ? input.fallback.digest : undefined);
    if (!url || !digest) return undefined;
    return {
      kind: "prepared",
      url,
      digest,
      ...(modulePath ? { modulePath } : {}),
    };
  }
  if (kind === "local") {
    const path = stringValue(input.source.path) ??
      (input.fallback?.kind === "local" ? input.fallback.path : undefined);
    if (!path) return undefined;
    return {
      kind: "local",
      path,
      ...(modulePath ? { modulePath } : {}),
    };
  }
  return undefined;
}

function adaptPlanRunResult(input: {
  status: number;
  contentType: string;
  payload: unknown;
}): { status: number; contentType: string; payload: unknown } {
  const planRun = planRunFromPayload(input.payload);
  if (!planRun) return input;
  const currentDeploymentId = isRecord(input.payload)
    ? stringValue(input.payload.currentDeploymentId) ??
      (planRun.installationCurrentDeploymentId ?? undefined)
    : undefined;
  const hasInstallationGuard = planRun.installationId !== undefined &&
    planRun.installationCurrentDeploymentId !== undefined;
  return {
    ...input,
    payload: {
      kind: "takosumi.deploy-control.plan-run@v1",
      planRun,
      planRunId: planRun.id,
      source: sourceProjection(planRun.source, planRun.sourceCommit),
      repo: repoProjection(planRun.source),
      planDigest: planRun.planDigest,
      providerLockDigest: planRun.providerLockDigest,
      expected: {
        planRunId: planRun.id,
        ...(planRun.installationId ? { installationId: planRun.installationId } : {}),
        ...(hasInstallationGuard
          ? { currentDeploymentId: planRun.installationCurrentDeploymentId }
          : currentDeploymentId ? { currentDeploymentId } : {}),
        runnerProfileId: planRun.runnerProfileId,
        sourceDigest: planRun.sourceDigest,
        variablesDigest: planRun.variablesDigest,
        policyDecisionDigest: planRun.policyDecisionDigest,
        planDigest: planRun.planDigest,
        planArtifactDigest: planRun.planArtifact?.digest,
        sourceCommit: planRun.sourceCommit,
        providerLockDigest: planRun.providerLockDigest,
      },
      changes: [
        {
          operation: planRun.operation,
          subject: repoProjection(planRun.source).name,
          kind: "opentofu-module",
        },
      ],
      cost: {
        meteredBindingCount: 0,
      },
    },
  };
}

function adaptApplyRunResult(input: {
  status: number;
  contentType: string;
  payload: unknown;
}): { status: number; contentType: string; payload: unknown } {
  if (!isRecord(input.payload)) return input;
  const response = input.payload as Partial<ApplyRunResponse>;
  if (!response.applyRun) return input;
  const deployment = response.deployment;
  // The Space-direct Deployment dropped its embedded `source` / `planDigest` /
  // `sourceCommit` projections (those now live on the reviewed PlanRun and in
  // the control-plane SourceSnapshot, not on the Deployment row). The only
  // public payload still derivable from the Deployment is the launch URL, which
  // comes from the projected outputsPublic map.
  const outputs = deployment
    ? deploymentOutputsFromPublic(deployment.outputsPublic)
    : undefined;
  return {
    ...input,
    payload: {
      kind: "takosumi.deploy-control.apply-run@v1",
      ...input.payload,
      applyRun: response.applyRun,
      ...(response.installation ? { installation: response.installation } : {}),
      ...(deployment ? { deployment } : {}),
      ...(outputs ? launchProjection(outputs) : {}),
      response: {
        status: input.status,
      },
    },
  };
}

/**
 * Projects the Space-direct Deployment's `outputsPublic` map into the legacy
 * {@link DeploymentOutput} list shape the launch projection consumes. The
 * Space-direct model only retains the public (allowlisted) outputs as a plain
 * record; sensitivity and typed kinds are no longer carried here, so `kind`
 * mirrors the output name and `sensitive` is always false.
 */
function deploymentOutputsFromPublic(
  outputsPublic: Readonly<Record<string, unknown>> | undefined,
): readonly DeploymentOutput[] {
  // The wire Deployment may omit `outputsPublic` (no allowlisted outputs, or a
  // control-plane response that has not yet adopted the field); tolerate it
  // rather than throw, matching the forgiving wire-reading style of this proxy.
  if (!isRecord(outputsPublic)) return [];
  return Object.entries(outputsPublic).map(([name, value]) => ({
    name,
    kind: name as DeploymentOutput["kind"],
    value: value as DeploymentOutput["value"],
    sensitive: false,
  }));
}

function sourceProjection(
  source: OpenTofuModuleSource,
  sourceCommit?: string,
): OpenTofuModuleSource & { readonly url?: string; readonly commit?: string } {
  if (source.kind === "local") {
    return {
      ...source,
      url: source.path,
      ...(sourceCommit ? { commit: sourceCommit } : {}),
    };
  }
  return {
    ...source,
    ...(sourceCommit ? { commit: sourceCommit } : {}),
  };
}

function repoProjection(
  source: OpenTofuModuleSource,
): { id: string; name: string } {
  const seed = source.kind === "local" ? source.path : source.url;
  const name = seed.split(/[/?#]/)[0]?.split(/[/:]/).filter(Boolean).pop()
    ?.replace(/\.git$/, "") || "opentofu-module";
  return { id: name.toLowerCase(), name };
}

function launchProjection(
  outputs: readonly DeploymentOutput[],
): { launch?: { url: string } } {
  const output = outputs.find((entry) =>
    (entry.kind === "launch_url" || entry.name === "launch_url" ||
      entry.name === "takosumi_launch_url") &&
    typeof entry.value === "string"
  );
  return output && typeof output.value === "string"
    ? { launch: { url: output.value } }
    : {};
}

function planRunFromPayload(payload: unknown): PlanRun | undefined {
  return isRecord(payload) && isRecord(payload.planRun)
    ? payload.planRun as unknown as PlanRun
    : undefined;
}

async function requestDeployControlJson<TPayload = unknown>(input: {
  deployControl: DeployControlProxyOptions;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}): Promise<{ status: number; contentType: string; payload: TPayload | unknown }> {
  return await requestDeployControlInProcess({
    operations: input.deployControl.operations,
    method: input.method,
    path: input.path,
    body: input.body,
  });
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * In-process dispatch for the deploy-control transport. Mirrors the embedded
 * deploy-control router: the same `{ method, path }` the proxy was written
 * against maps to a typed controller operation and the same success status
 * (201 create / 200 read). Controller errors are rendered as the deploy-control
 * error envelope with the contract's code→HTTP-status mapping, identical to the
 * router's `runHandler`, so every caller of {@link requestDeployControlJson}
 * sees the same `{ status, contentType, payload }` it would over HTTP.
 */
async function requestDeployControlInProcess(input: {
  operations: DeployControlOperations;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  try {
    if (input.method === "POST" && input.path === PLAN_RUNS_PATH) {
      const payload = await input.operations.createPlanRun(
        input.body as CreatePlanRunRequest,
      );
      return { status: 201, contentType: JSON_CONTENT_TYPE, payload };
    }
    if (input.method === "POST" && input.path === APPLY_RUNS_PATH) {
      const payload = await input.operations.createApplyRun(
        input.body as CreateApplyRunRequest,
      );
      return { status: 201, contentType: JSON_CONTENT_TYPE, payload };
    }
    if (input.method === "GET") {
      const planRunId = idFromPath(input.path, PLAN_RUN_PATH);
      if (planRunId !== undefined) {
        const payload = await input.operations.getPlanRun(planRunId);
        return { status: 200, contentType: JSON_CONTENT_TYPE, payload };
      }
      const deploymentsId = idFromPath(input.path, INSTALLATION_DEPLOYMENTS_PATH);
      if (deploymentsId !== undefined) {
        const payload = await input.operations.listDeployments(deploymentsId);
        return { status: 200, contentType: JSON_CONTENT_TYPE, payload };
      }
      const installationId = idFromPath(input.path, INSTALLATION_PATH);
      if (installationId !== undefined) {
        const payload = await input.operations.getInstallation(installationId);
        return { status: 200, contentType: JSON_CONTENT_TYPE, payload };
      }
    }
    return deployControlErrorResult(
      "not_found",
      `deploy control route ${input.method} ${input.path} not found`,
    );
  } catch (error) {
    const code = controllerErrorCode(error);
    if (code) {
      return deployControlErrorResult(
        code,
        error instanceof Error ? error.message : String(error),
      );
    }
    return deployControlErrorResult("internal_error", "internal error");
  }
}

function idFromPath(
  path: string,
  build: (id: string) => string,
): string | undefined {
  // The contract path helpers encodeURIComponent the id, so reverse the build
  // by trying the decoded segment(s) of the request path. Both deployments and
  // single-installation paths share a prefix; resolve by exact reconstruction.
  // These prefixes mirror the `/internal/v1` deploy-control seam the contract
  // path builders (`INSTALLATION_PATH` / `PLAN_RUN_PATH`) emit.
  const installationsPrefix = `${INTERNAL_V1_PREFIX}/installations/`;
  if (path.startsWith(installationsPrefix)) {
    const remainder = path.slice(installationsPrefix.length);
    const deploymentsSuffix = "/deployments";
    if (build === INSTALLATION_DEPLOYMENTS_PATH) {
      if (!remainder.endsWith(deploymentsSuffix)) return undefined;
      const encoded = remainder.slice(0, -deploymentsSuffix.length);
      if (encoded.length === 0 || encoded.includes("/")) return undefined;
      return decodeURIComponent(encoded);
    }
    if (build === INSTALLATION_PATH) {
      if (remainder.length === 0 || remainder.includes("/")) return undefined;
      return decodeURIComponent(remainder);
    }
    return undefined;
  }
  const planRunPrefix = `${INTERNAL_V1_PREFIX}/plan-runs/`;
  if (build === PLAN_RUN_PATH && path.startsWith(planRunPrefix)) {
    const remainder = path.slice(planRunPrefix.length);
    if (remainder.length === 0 || remainder.includes("/")) return undefined;
    return decodeURIComponent(remainder);
  }
  return undefined;
}

function controllerErrorCode(
  error: unknown,
): DeployControlErrorCode | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return typeof code === "string" &&
      code in DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE
    ? code as DeployControlErrorCode
    : undefined;
}

function deployControlErrorResult(
  code: DeployControlErrorCode,
  message: string,
): { status: number; contentType: string; payload: DeployControlErrorEnvelope } {
  return {
    status: DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[code],
    contentType: JSON_CONTENT_TYPE,
    payload: {
      error: {
        code,
        message,
        requestId: "in-process",
      },
    },
  };
}

function responseFromProxyResult(input: {
  status: number;
  contentType: string;
  payload: unknown;
}): Response {
  return new Response(JSON.stringify(input.payload), {
    status: input.status,
    headers: { "content-type": input.contentType },
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
