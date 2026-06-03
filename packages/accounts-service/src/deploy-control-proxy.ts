import type { JsonValue } from "takosumi-contract";
import {
  APPLY_RUNS_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_PATH,
  PLAN_RUN_PATH,
  PLAN_RUNS_PATH,
} from "takosumi-contract/deploy-control-api";
import type {
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  Deployment,
  DeploymentOutput,
  GetInstallationResponse,
  Installation,
  ListDeploymentsResponse,
  OpenTofuModuleSource,
  PlanRun,
  PlanRunResponse,
} from "takosumi-contract/deploy-control-api";

export interface DeployControlProxyOptions {
  url: string;
  token?: string;
  fetch?: typeof fetch;
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
      source: target.source,
      planRunId,
      ...(isRecord(input.body.expected) ? { expected: input.body.expected } : {}),
    },
  });
  if (isRecord(applied.payload)) {
    applied.payload.rollback = { targetDeploymentId };
  }
  return applied;
}

export async function requestDestroy(input: {
  deployControl: DeployControlProxyOptions;
  installationId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await resolveReviewedPlanRunForFacadeApply({
    deployControl: input.deployControl,
    body: input.body,
    operation: "destroy",
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

  const source = openTofuSourceFromRequestSource({
    source: isRecord(input.body.source) ? input.body.source : undefined,
    fallback: installation?.source,
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
  const deployment = response.deployment
    ? deploymentProjection(response.deployment)
    : undefined;
  return {
    ...input,
    payload: {
      kind: "takosumi.deploy-control.apply-run@v1",
      ...input.payload,
      applyRun: response.applyRun,
      ...(response.installation ? { installation: response.installation } : {}),
      ...(deployment ? { deployment } : {}),
      ...(deployment ? { source: deployment.source } : {}),
      ...(deployment?.planDigest
        ? {
          planDigest: deployment.planDigest,
        }
        : {}),
      ...(deployment ? launchProjection(deployment.outputs) : {}),
      response: {
        status: input.status,
      },
    },
  };
}

function deploymentProjection(deployment: Deployment): Deployment & {
  readonly planDigest?: string;
  readonly source: OpenTofuModuleSource & {
    readonly url?: string;
    readonly commit?: string;
  };
} {
  return {
    ...deployment,
    planDigest: deployment.planDigest,
    source: sourceProjection(deployment.source, deployment.sourceCommit),
  };
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
  const response = await (input.deployControl.fetch ?? fetch)(
    new URL(input.path, input.deployControl.url),
    {
      method: input.method,
      headers: {
        "accept": "application/json",
        ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
        ...(input.deployControl.token
          ? { authorization: `Bearer ${input.deployControl.token}` }
          : {}),
      },
      ...(input.method === "POST"
        ? { body: JSON.stringify(stripUndefined(input.body ?? {})) }
        : {}),
    },
  );
  const contentType = response.headers.get("content-type") ??
    "application/json; charset=utf-8";
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }
  return { status: response.status, contentType, payload };
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

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefined(entry)]),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
