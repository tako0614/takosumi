import type { JsonValue } from "takosumi-contract";
import { INTERNAL_V1_PREFIX } from "takosumi-contract/api-surface";
import {
  APPLY_RUNS_PATH,
  CAPSULE_PATH,
  CAPSULE_STATE_VERSIONS_PATH,
  DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE,
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
  GetCapsuleResponse,
  Capsule,
  ListDeploymentsResponse,
  OpenTofuModuleSource,
  PlanRun,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";

/**
 * In-process typed deploy-control operations the facade depends on. This is the
 * contract-DTO subset of the host's `TakosumiOperations` facade (the wired
 * OpenTofu controller); the facade calls these typed operations directly instead
 * of building a synthetic Request and dialing it back through the embedded Hono
 * router inside the same worker. Per AGENTS.md the control-plane and
 * account-plane handlers are composed in-process by both build targets, so this
 * is the only transport — there is no remote deploy-control origin.
 */
export interface DeployControlOperations {
  createPlanRun(request: CreatePlanRunRequest): Promise<PlanRunResponse>;
  getPlanRun(id: string): Promise<PlanRunResponse>;
  createApplyRun(request: CreateApplyRunRequest): Promise<ApplyRunResponse>;
  getCapsule(id: string): Promise<GetCapsuleResponse>;
  listDeployments(capsuleId: string): Promise<ListDeploymentsResponse>;
  /**
   * Idempotent personal-Workspace creation for the account-plane first-login hook
   * (spec §4: "初回ログイン時に個人 Workspace を自動作成する"). Exposed on the
   * operations facade so the session-me route can call it fire-and-forget after
   * sign-in. The OAuth identity resolver intentionally stays side-effect free;
   * it does not own Workspace creation. `handle` must satisfy the spaces handle rule;
   * the account's username/slug if one exists, else `u-<short id>`.
   */
  ensurePersonalWorkspace?(
    ownerUserId: string,
    handle: string,
  ): Promise<{ readonly id: string }>;
}

export interface DeployControlFacadeOptions {
  /**
   * In-process deploy-control facade. The facade calls these typed operations
   * directly (no self-issued Bearer handshake, no JSON serialize/parse round-trip
   * through the embedded router) — the single-worker default and only transport.
   */
  operations: DeployControlOperations;
}

export async function handleCapsulePlanRunFacade(input: {
  request: Request;
  deployControl: DeployControlFacadeOptions;
}): Promise<Response> {
  const bodyText = await input.request.text();
  const body = bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : {};
  const result = await requestCapsulePlanRun({
    deployControl: input.deployControl,
    body: isRecord(body) ? body : {},
  });
  return responseFromFacadeResult(result);
}

export async function requestCapsulePlanRun(input: {
  deployControl: DeployControlFacadeOptions;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await createPlanRunForFacadeRequest({
    deployControl: input.deployControl,
    body: input.body,
    operation: "create",
  });
  return adaptPlanRunResult(plan);
}

export async function requestCapsuleApply(input: {
  deployControl: DeployControlFacadeOptions;
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
  deployControl: DeployControlFacadeOptions;
  capsuleId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await createPlanRunForFacadeRequest({
    deployControl: input.deployControl,
    body: input.body,
    operation: "update",
    capsuleId: input.capsuleId,
  });
  return adaptPlanRunResult(plan);
}

export async function requestDeploymentApply(input: {
  deployControl: DeployControlFacadeOptions;
  capsuleId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const plan = await resolveReviewedPlanRunForFacadeApply({
    deployControl: input.deployControl,
    body: input.body,
    operation: "update",
    capsuleId: input.capsuleId,
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
  deployControl: DeployControlFacadeOptions;
  capsuleId: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const targetDeploymentId =
    stringValue(input.body.deploymentId) ??
    stringValue(input.body.deployment_id);
  const planRunId =
    stringValue(input.body.planRunId) ??
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
    path: CAPSULE_STATE_VERSIONS_PATH(input.capsuleId),
  });
  if (deployments.status < 200 || deployments.status >= 300) return deployments;
  const target = isRecord(deployments.payload)
    ? (
        deployments.payload.deployments as readonly Deployment[] | undefined
      )?.find((deployment) => deployment.id === targetDeploymentId)
    : undefined;
  if (!target) {
    return {
      status: 404,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "not_found",
        error_description: `Deployment ${targetDeploymentId} was not found in Capsule ${input.capsuleId}`,
      },
    };
  }
  const applied = await requestDeploymentApply({
    deployControl: input.deployControl,
    capsuleId: input.capsuleId,
    body: {
      // The Workspace-direct Deployment no longer carries a `source`; the source
      // identity comes from the reviewed PlanRun (resolved by planRunId inside
      // requestDeploymentApply), so the rollback apply body only needs the
      // planRunId + the optional expected guard.
      planRunId,
      ...(isRecord(input.body.expected)
        ? { expected: input.body.expected }
        : {}),
    },
  });
  if (isRecord(applied.payload)) {
    applied.payload.rollback = { targetDeploymentId };
  }
  return applied;
}

async function resolveReviewedPlanRunForFacadeApply(input: {
  deployControl: DeployControlFacadeOptions;
  body: Record<string, unknown>;
  operation: "create" | "update" | "destroy";
  capsuleId?: string;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const planRunId =
    stringValue(input.body.planRunId) ??
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
        error_description: `PlanRun ${planRun.id} operation is ${planRun.operation}; expected ${input.operation}`,
        planRun,
      },
    };
  }
  if (input.capsuleId && planRun.capsuleId !== input.capsuleId) {
    return {
      status: 409,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "failed_precondition",
        error_description: `PlanRun ${planRun.id} is not for Capsule ${input.capsuleId}`,
        planRun,
      },
    };
  }
  return result;
}

async function createPlanRunForFacadeRequest(input: {
  deployControl: DeployControlFacadeOptions;
  body: Record<string, unknown>;
  operation: "create" | "update" | "destroy";
  capsuleId?: string;
}): Promise<{ status: number; contentType: string; payload: unknown }> {
  const capsuleId =
    input.capsuleId ?? stringValue(input.body.capsuleId);
  let installation: Capsule | undefined;
  if (capsuleId) {
    const installationResult =
      await requestDeployControlJson<GetCapsuleResponse>({
        deployControl: input.deployControl,
        method: "GET",
        path: CAPSULE_PATH(capsuleId),
      });
    if (installationResult.status < 200 || installationResult.status >= 300) {
      return installationResult;
    }
    installation = isRecord(installationResult.payload)
      ? (installationResult.payload.installation as Capsule | undefined)
      : undefined;
  }

  // The Workspace-direct Capsule no longer carries a `source` (its source
  // identity lives in the control plane behind `sourceId`, not resolvable
  // in-process here). The plan source must therefore come from the request
  // body; there is no Capsule-derived fallback.
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
  const workspaceId =
    stringValue(input.body.workspaceId) ??
    stringValue(input.body.space_id) ??
    installation?.workspaceId;
  if (!workspaceId) {
    return {
      status: 400,
      contentType: "application/json; charset=utf-8",
      payload: {
        error: "invalid_request",
        error_description: "workspaceId is required",
      },
    };
  }

  const request: CreatePlanRunRequest = {
    workspaceId,
    source,
    operation: input.operation,
    ...(capsuleId ? { capsuleId } : {}),
    ...((stringValue(input.body.runnerId) ??
    stringValue(input.body.runnerProfileId))
      ? {
          runnerProfileId:
            stringValue(input.body.runnerId) ??
            stringValue(input.body.runnerProfileId)!,
        }
      : {}),
    ...(isRecord(input.body.variables)
      ? {
          variables: input.body.variables as Readonly<
            Record<string, JsonValue>
          >,
        }
      : {}),
    ...(Array.isArray(input.body.requiredProviders)
      ? {
          requiredProviders: input.body.requiredProviders.filter(
            (entry): entry is string => typeof entry === "string",
          ),
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
      currentStateVersionId: installation.currentStateVersionId ?? null,
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
      readonly result: {
        status: number;
        contentType: string;
        payload: unknown;
      };
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
          error_description:
            error instanceof Error ? error.message : String(error),
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
    throw new Error(
      "apply requires expected guard fields from the reviewed PlanRun",
    );
  }
  const sourceCommit = input.planRun.sourceCommit
    ? requiredExpectedString(expected, "sourceCommit")
    : undefined;
  const providerLockDigest = input.planRun.providerLockDigest
    ? requiredExpectedString(expected, "providerLockDigest")
    : undefined;
  const resolvedProviderEnvBindingsDigest = input.planRun
    .resolvedProviderEnvBindingsDigest
    ? requiredExpectedString(expected, "resolvedProviderEnvBindingsDigest")
    : undefined;
  const capsuleId = input.planRun.capsuleId
    ? requiredExpectedString(expected, "capsuleId")
    : undefined;
  const currentStateVersionId = input.planRun.capsuleId
    ? requiredExpectedNullableString(expected, "currentStateVersionId")
    : undefined;
  return {
    planRunId: input.planRun.id,
    ...(input.approval ? { approval: input.approval } : {}),
    expected: {
      planRunId: requiredExpectedString(expected, "planRunId"),
      ...(capsuleId ? { capsuleId } : {}),
      ...(input.planRun.capsuleId ? { currentStateVersionId } : {}),
      runnerProfileId: requiredExpectedString(expected, "runnerProfileId"),
      sourceDigest: requiredExpectedString(expected, "sourceDigest"),
      variablesDigest: requiredExpectedString(expected, "variablesDigest"),
      policyDecisionDigest: requiredExpectedString(
        expected,
        "policyDecisionDigest",
      ),
      planDigest: requiredExpectedString(expected, "planDigest"),
      planArtifactDigest: requiredExpectedString(
        expected,
        "planArtifactDigest",
      ),
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(providerLockDigest ? { providerLockDigest } : {}),
      ...(resolvedProviderEnvBindingsDigest
        ? { resolvedProviderEnvBindingsDigest }
        : {}),
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
    const url =
      stringValue(input.source.url) ??
      (input.fallback?.kind === "git" ? input.fallback.url : undefined);
    if (!url) return undefined;
    return {
      kind: "git",
      url,
      ref:
        stringValue(input.source.ref) ??
        (input.fallback?.kind === "git" ? input.fallback.ref : undefined),
      commit:
        stringValue(input.source.commit) ??
        (input.fallback?.kind === "git" ? input.fallback.commit : undefined),
      ...(modulePath ? { modulePath } : {}),
    };
  }
  if (kind === "prepared") {
    const url =
      stringValue(input.source.url) ??
      (input.fallback?.kind === "prepared" ? input.fallback.url : undefined);
    const digest =
      stringValue(input.source.digest) ??
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
    const path =
      stringValue(input.source.path) ??
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
  const currentStateVersionId = isRecord(input.payload)
    ? (stringValue(input.payload.currentStateVersionId) ??
      planRun.capsuleCurrentStateVersionId ??
      undefined)
    : undefined;
  const hasCapsuleGuard =
    planRun.capsuleId !== undefined &&
    planRun.capsuleCurrentStateVersionId !== undefined;
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
        ...(planRun.capsuleId
          ? { capsuleId: planRun.capsuleId }
          : {}),
        ...(hasCapsuleGuard
          ? {
              currentStateVersionId:
                planRun.capsuleCurrentStateVersionId ?? null,
            }
          : currentStateVersionId
            ? { currentStateVersionId }
            : {}),
        runnerProfileId: planRun.runnerProfileId,
        sourceDigest: planRun.sourceDigest,
        variablesDigest: planRun.variablesDigest,
        policyDecisionDigest: planRun.policyDecisionDigest,
        planDigest: planRun.planDigest,
        planArtifactDigest: planRun.planArtifact?.digest,
        sourceCommit: planRun.sourceCommit,
        providerLockDigest: planRun.providerLockDigest,
        resolvedProviderEnvBindingsDigest:
          planRun.resolvedProviderEnvBindingsDigest,
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
  // The Workspace-direct Deployment dropped its embedded `source` / `planDigest` /
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
 * Projects the Workspace-direct Deployment's `outputsPublic` map into the legacy
 * {@link DeploymentOutput} list shape the launch projection consumes. The
 * Workspace-direct model only retains the public (allowlisted) outputs as a plain
 * record; sensitivity and typed kinds are no longer carried here, so `kind`
 * mirrors the output name and `sensitive` is always false.
 */
function deploymentOutputsFromPublic(
  outputsPublic: Readonly<Record<string, unknown>> | undefined,
): readonly DeploymentOutput[] {
  // The wire Deployment may omit `outputsPublic` (no allowlisted outputs, or a
  // control-plane response that has not yet adopted the field); tolerate it
  // rather than throw, matching the forgiving wire-reading style of this facade.
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

function repoProjection(source: OpenTofuModuleSource): {
  id: string;
  name: string;
} {
  const seed = source.kind === "local" ? source.path : source.url;
  const name =
    seed
      .split(/[/?#]/)[0]
      ?.split(/[/:]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/, "") || "opentofu-module";
  return { id: name.toLowerCase(), name };
}

function launchProjection(outputs: readonly DeploymentOutput[]): {
  launch?: { url: string };
} {
  const output = outputs.find(
    (entry) =>
      (entry.kind === "launch_url" ||
        entry.name === "launch_url" ||
        entry.name === "takosumi_launch_url") &&
      typeof entry.value === "string",
  );
  return output && typeof output.value === "string"
    ? { launch: { url: output.value } }
    : {};
}

function planRunFromPayload(payload: unknown): PlanRun | undefined {
  return isRecord(payload) && isRecord(payload.planRun)
    ? (payload.planRun as unknown as PlanRun)
    : undefined;
}

async function requestDeployControlJson<TPayload = unknown>(input: {
  deployControl: DeployControlFacadeOptions;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}): Promise<{
  status: number;
  contentType: string;
  payload: TPayload | unknown;
}> {
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
 * deploy-control router: the same `{ method, path }` the facade was written
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
      const deploymentsId = idFromPath(
        input.path,
        CAPSULE_STATE_VERSIONS_PATH,
      );
      if (deploymentsId !== undefined) {
        const payload = await input.operations.listDeployments(deploymentsId);
        return { status: 200, contentType: JSON_CONTENT_TYPE, payload };
      }
      const capsuleId = idFromPath(input.path, CAPSULE_PATH);
      if (capsuleId !== undefined) {
        const payload = await input.operations.getCapsule(capsuleId);
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
  // by trying the decoded segment(s) of the request path. Both state-history and
  // single-Capsule paths share a prefix; resolve by exact reconstruction. These
  // prefixes mirror the `/internal/v1` deploy-control seam the contract path
  // builders (`CAPSULE_PATH` / `PLAN_RUN_PATH`) emit.
  const capsulesPrefix = `${INTERNAL_V1_PREFIX}/capsules/`;
  if (path.startsWith(capsulesPrefix)) {
    const remainder = path.slice(capsulesPrefix.length);
    const stateVersionsSuffix = "/state-versions";
    if (build === CAPSULE_STATE_VERSIONS_PATH) {
      if (!remainder.endsWith(stateVersionsSuffix)) return undefined;
      const encoded = remainder.slice(0, -stateVersionsSuffix.length);
      if (encoded.length === 0 || encoded.includes("/")) return undefined;
      return decodeURIComponent(encoded);
    }
    if (build === CAPSULE_PATH) {
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
    ? (code as DeployControlErrorCode)
    : undefined;
}

function deployControlErrorResult(
  code: DeployControlErrorCode,
  message: string,
): {
  status: number;
  contentType: string;
  payload: DeployControlErrorEnvelope;
} {
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

function responseFromFacadeResult(input: {
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
