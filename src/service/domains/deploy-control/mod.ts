/**
 * OpenTofu-native deployment-control-plane domain.
 *
 * Takosumi owns the API-facing ledger and policy gate. RunnerProfiles provide
 * provider allowlists, state-backend ownership, and runner substrate choice.
 * OpenTofu execution is delegated to an injected runner, normally a
 * Cloudflare Container runner in the reference distribution.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  ApplyExpectedGuard,
  ApplyRun,
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  DeployControlAuditEvent,
  Deployment,
  DeploymentOutput,
  GetInstallationResponse,
  Installation,
  DeployControlErrorCode,
  ListDeploymentsResponse,
  ListDeploymentOutputsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  OpenTofuOutputEnvelope,
  OpenTofuOperation,
  OpenTofuPlanArtifact,
  PlanRun,
  PlanRunResponse,
  PlanRunSummary,
  PolicyDecision,
  RunnerProfile,
  RunnerStateBackend,
  RunnerStateLockEvidence,
  RunDiagnostic,
} from "takosumi-contract/deploy-control-api";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import {
  InMemoryOpenTofuDeploymentStore,
  InstallationPatchGuardConflict,
  type OpenTofuDeploymentStore,
} from "./store.ts";
import { redactString } from "../../services/observability/redaction.ts";
import {
  assertHostNotBlocked,
  BlockedHostError,
} from "../../../deploy-control/host-blocklist.ts";

export type OpenTofuControllerErrorCode = DeployControlErrorCode;

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export class OpenTofuControllerError extends Error {
  readonly code: OpenTofuControllerErrorCode;

  constructor(code: OpenTofuControllerErrorCode, message: string) {
    super(message);
    this.name = "OpenTofuControllerError";
    this.code = code;
  }
}

export interface OpenTofuPlanJob {
  readonly planRun: PlanRun;
  readonly runnerProfile: RunnerProfile;
  readonly variables: Readonly<Record<string, JsonValue>>;
}

export interface OpenTofuApplyJob {
  readonly applyRun: ApplyRun;
  readonly planRun: PlanRun;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly runnerProfile: RunnerProfile;
}

export interface OpenTofuDestroyJob {
  readonly applyRun: ApplyRun;
  readonly planRun: PlanRun;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly installation: Installation;
  readonly runnerProfile: RunnerProfile;
}

export interface OpenTofuPlanResult {
  readonly planDigest: string;
  readonly planArtifact: OpenTofuPlanArtifact;
  readonly requiredProviders?: readonly string[];
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly summary?: PlanRunSummary;
  readonly diagnostics?: readonly RunDiagnostic[];
}

export interface OpenTofuApplyResult {
  readonly outputs?: OpenTofuOutputEnvelope | readonly DeploymentOutput[];
  readonly stateLock?: RunnerStateLockEvidence;
  readonly diagnostics?: readonly RunDiagnostic[];
}

export interface OpenTofuDestroyResult {
  readonly diagnostics?: readonly RunDiagnostic[];
}

export interface OpenTofuRunner {
  plan(job: OpenTofuPlanJob): Promise<OpenTofuPlanResult>;
  apply(job: OpenTofuApplyJob): Promise<OpenTofuApplyResult>;
  destroy?(job: OpenTofuDestroyJob): Promise<OpenTofuDestroyResult>;
}

export interface OpenTofuDeploymentControllerDependencies {
  readonly store?: OpenTofuDeploymentStore;
  readonly runner?: OpenTofuRunner;
  readonly runnerProfiles?: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => number;
}

export interface DeployControlActorContext {
  readonly actor?: string;
}

export class OpenTofuDeploymentController {
  readonly #store: OpenTofuDeploymentStore;
  readonly #runner?: OpenTofuRunner;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #seededProfiles: Promise<void>;
  readonly #mutationChains = new Map<string, Promise<void>>();

  constructor(dependencies: OpenTofuDeploymentControllerDependencies = {}) {
    this.#store = dependencies.store ?? new InMemoryOpenTofuDeploymentStore();
    this.#runner = dependencies.runner;
    this.#defaultRunnerProfileId = dependencies.defaultRunnerProfileId ??
      "cloudflare-default";
    this.#newId = dependencies.newId ?? newId;
    this.#now = dependencies.now ?? (() => Date.now());
    this.#seededProfiles = this.#seedRunnerProfiles(
      dependencies.runnerProfiles ?? createDefaultRunnerProfiles(this.#now()),
    );
  }

  async listRunnerProfiles(): Promise<ListRunnerProfilesResponse> {
    await this.#seededProfiles;
    return { runnerProfiles: await this.#store.listRunnerProfiles() };
  }

  async createPlanRun(
    request: CreatePlanRunRequest,
    context: DeployControlActorContext = {},
  ): Promise<PlanRunResponse> {
    await this.#seededProfiles;
    requireNonEmptyString(request.spaceId, "spaceId");
    validateSource(request.source);
    const profile = await this.#requireRunnerProfile(
      request.runnerProfileId ?? this.#defaultRunnerProfileId,
    );
    const operation = request.operation ?? (request.installationId
      ? "update"
      : "create");
    validateOperation(operation);
    const installation = request.installationId !== undefined
      ? await this.#requireInstallation(request.installationId)
      : undefined;
    validateOperationInstallationShape({
      operation,
      installation,
      requestedSpaceId: request.spaceId,
      requestedSource: request.source,
      runnerProfileId: profile.id,
    });
    validateSourceAllowedByProfile(request.source, profile);
    const now = this.#now();
    const variables = normalizeVariables(request.variables);
    const declaredProviders = normalizeProviders(request.requiredProviders ?? []);
    const policy = evaluatePolicy({
      profile,
      requiredProviders: declaredProviders,
      checkedAt: now,
    });
    const sourceDigest = await stableJsonDigest(request.source);
    const variablesDigest = await stableJsonDigest(variables);
    const policyDecisionDigest = await stableJsonDigest(policy);
    let planRun: PlanRun = {
      id: this.#newId("plan"),
      spaceId: request.spaceId,
      ...(request.installationId ? { installationId: request.installationId } : {}),
      ...(installation
        ? { installationCurrentDeploymentId: installation.currentDeploymentId }
        : {}),
      source: request.source,
      sourceDigest,
      operation,
      runnerProfileId: profile.id,
      variablesDigest,
      requiredProviders: declaredProviders,
      status: policy.status === "passed" ? "queued" : "blocked",
      policy,
      policyDecisionDigest,
      auditEvents: [
        auditEvent("plan", "plan.requested", now, {
          sourceDigest,
          variablesDigest,
          runnerProfileId: profile.id,
        }, context.actor),
        auditEvent("plan", "plan.policy_evaluated", now, {
          policyDecisionDigest,
          status: policy.status,
        }, context.actor),
      ],
      createdAt: now,
      updatedAt: now,
      ...(policy.status === "blocked" ? { finishedAt: now } : {}),
    };
    await this.#store.putPlanRun(planRun);
    if (policy.status === "passed" && this.#runner) {
      planRun = await this.#executePlan(planRun, profile, variables);
    }
    return { planRun };
  }

  async getPlanRun(id: string): Promise<PlanRunResponse> {
    requireNonEmptyString(id, "planRunId");
    const planRun = await this.#store.getPlanRun(id);
    if (!planRun) {
      throw new OpenTofuControllerError("not_found", `plan run ${id} not found`);
    }
    return { planRun };
  }

  async createApplyRun(
    request: CreateApplyRunRequest,
    context: DeployControlActorContext = {},
  ): Promise<ApplyRunResponse> {
    await this.#seededProfiles;
    requireNonEmptyString(request.planRunId, "planRunId");
    const planRun = await this.#requirePlanRun(request.planRunId);
    if (planRun.status !== "succeeded") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} is ${planRun.status}; apply requires a succeeded plan`,
      );
    }
    if (planRun.policy.status !== "passed") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} did not pass policy`,
      );
    }
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable plan artifact`,
      );
    }
    checkApplyExpected(request.expected, planRun);
    if (planRun.installationId) {
      await this.#requireCurrentPlannedInstallation(planRun);
    }
    const profile = await this.#requireRunnerProfile(planRun.runnerProfileId);
    const now = this.#now();
    const applyRun: ApplyRun = {
      id: this.#newId("apply"),
      planRunId: planRun.id,
      spaceId: planRun.spaceId,
      ...(planRun.installationId ? { installationId: planRun.installationId } : {}),
      operation: planRun.operation,
      runnerProfileId: profile.id,
      status: "queued",
      ...(request.approval ? { approval: request.approval } : {}),
      expected: request.expected,
      stateBackend: profile.stateBackend,
      stateLock: stateLockEvidence(profile.stateBackend, now, now, "pending"),
      auditEvents: [
        auditEvent("apply", "apply.queued", now, {
          planRunId: planRun.id,
          runnerProfileId: profile.id,
        }, context.actor),
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.putApplyRun(applyRun);
    if (!this.#runner) return { applyRun };
    const key = planRun.installationId ?? planRun.id;
    return await this.#runSerialized(
      key,
      () => this.#executeApply(applyRun, planRun, profile),
    );
  }

  async getApplyRun(id: string): Promise<ApplyRunResponse> {
    requireNonEmptyString(id, "applyRunId");
    const applyRun = await this.#store.getApplyRun(id);
    if (!applyRun) {
      throw new OpenTofuControllerError("not_found", `apply run ${id} not found`);
    }
    const installation = applyRun.installationId
      ? await this.#store.getInstallation(applyRun.installationId)
      : undefined;
    const deployment = applyRun.deploymentId
      ? await this.#store.getDeployment(applyRun.deploymentId)
      : undefined;
    return {
      applyRun,
      ...(installation ? { installation } : {}),
      ...(deployment ? { deployment } : {}),
    };
  }

  async getInstallation(id: string): Promise<GetInstallationResponse> {
    return { installation: await this.#requireInstallation(id) };
  }

  async listDeployments(
    installationId: string,
  ): Promise<ListDeploymentsResponse> {
    await this.#requireInstallation(installationId);
    return {
      deployments: await this.#store.listDeployments(installationId),
    };
  }

  async listDeploymentOutputs(
    installationId: string,
  ): Promise<ListDeploymentOutputsResponse> {
    const installation = await this.#requireInstallation(installationId);
    if (!installation.currentDeploymentId) return { outputs: [] };
    const deployment = await this.#store.getDeployment(
      installation.currentDeploymentId,
    );
    return { outputs: deployment?.outputs ?? [] };
  }

  async #executePlan(
    planRun: PlanRun,
    profile: RunnerProfile,
    variables: Readonly<Record<string, JsonValue>>,
  ): Promise<PlanRun> {
    const startedAt = this.#now();
    const running: PlanRun = {
      ...planRun,
      status: "running",
      auditEvents: [
        ...planRun.auditEvents,
        auditEvent(planRun.id, "plan.started", startedAt),
      ],
      updatedAt: startedAt,
    };
    await this.#store.putPlanRun(running);
    try {
      const result = await this.#runner!.plan({
        planRun: running,
        runnerProfile: profile,
        variables,
      });
      const now = this.#now();
      const diagnostics = redactRunDiagnostics(result.diagnostics);
      const requiredProviders = normalizeProviders(
        result.requiredProviders ?? running.requiredProviders,
      );
      const policy = evaluatePolicy({
        profile,
        requiredProviders,
        checkedAt: now,
      });
      const policyDecisionDigest = await stableJsonDigest(policy);
      const planArtifact = normalizePlanArtifact({
        artifact: result.planArtifact,
        planDigest: result.planDigest,
        now,
      });
      const summary = normalizePlanSummary(result.summary);
      const updated: PlanRun = {
        ...running,
        status: policy.status === "passed" ? "succeeded" : "blocked",
        requiredProviders,
        policy,
        policyDecisionDigest,
        planDigest: result.planDigest,
        planArtifact,
        ...(result.sourceCommit ? { sourceCommit: result.sourceCommit } : {}),
        ...(result.providerLockDigest
          ? { providerLockDigest: result.providerLockDigest }
          : {}),
        ...(summary ? { summary } : {}),
        ...(diagnostics ? { diagnostics } : {}),
        auditEvents: [
          ...running.auditEvents,
          auditEvent(planRun.id, "plan.policy_evaluated", now, {
            policyDecisionDigest,
            status: policy.status,
            observedProviderCount: requiredProviders.length,
          }),
          auditEvent(planRun.id, "plan.completed", now, {
            planDigest: result.planDigest,
            planArtifactDigest: planArtifact.digest,
            providerLockDigest: result.providerLockDigest ?? "",
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      await this.#store.putPlanRun(updated);
      return updated;
    } catch (error) {
      const now = this.#now();
      const failed: PlanRun = {
        ...running,
        status: "failed",
        diagnostics: [errorDiagnostic(error)],
        auditEvents: [
          ...running.auditEvents,
          auditEvent(planRun.id, "plan.failed", now, {
            message: errorMessage(error),
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      await this.#store.putPlanRun(failed);
      return failed;
    }
  }

  async #executeApply(
    applyRun: ApplyRun,
    planRun: PlanRun,
    profile: RunnerProfile,
  ): Promise<ApplyRunResponse> {
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable plan artifact`,
      );
    }
    const plannedInstallation = planRun.installationId
      ? await this.#requireCurrentPlannedInstallation(planRun)
      : undefined;
    const startedAt = this.#now();
    const running: ApplyRun = {
      ...applyRun,
      status: "running",
      stateLock: stateLockEvidence(profile.stateBackend, startedAt, startedAt, "pending"),
      auditEvents: [
        ...applyRun.auditEvents,
        auditEvent(applyRun.id, "apply.started", startedAt),
      ],
      updatedAt: startedAt,
    };
    await this.#store.putApplyRun(running);
    if (planRun.operation === "destroy") {
      return await this.#executeDestroyApply(
        running,
        planRun,
        profile,
        startedAt,
        plannedInstallation,
      );
    }
    try {
      const result = await this.#runner!.apply({
        applyRun: running,
        planRun,
        planArtifact: planRun.planArtifact,
        runnerProfile: profile,
      });
      const now = this.#now();
      const outputs = normalizeDeploymentOutputs(result.outputs);
      const installation = await this.#upsertInstallationFromApply({
        planRun,
        profile,
        now,
        plannedInstallation,
      });
      const deployment: Deployment = {
        id: this.#newId("dep"),
        installationId: installation.id,
        planRunId: planRun.id,
        applyRunId: applyRun.id,
        source: planRun.source,
        runnerProfileId: profile.id,
        status: "succeeded",
        ...(planRun.planDigest ? { planDigest: planRun.planDigest } : {}),
        ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
        ...(planRun.providerLockDigest
          ? { providerLockDigest: planRun.providerLockDigest }
          : {}),
        outputs,
        auditEvents: [
          auditEvent("deployment", "deployment.recorded", now, {
            applyRunId: applyRun.id,
            outputCount: outputs.length,
          }),
        ],
        createdAt: now,
        completedAt: now,
      };
      await this.#store.putDeployment(deployment);
      const patched = await this.#store.patchInstallation(installation.id, {
        currentDeploymentId: deployment.id,
        status: "ready",
        updatedAt: now,
        source: planRun.source,
        runnerProfileId: profile.id,
      }, planRun.installationId
        ? {
          currentDeploymentId: planRun.installationCurrentDeploymentId ?? null,
          status: plannedInstallation?.status,
        }
        : undefined);
      const diagnostics = redactRunDiagnostics(result.diagnostics);
      const completed: ApplyRun = {
        ...running,
        installationId: installation.id,
        deploymentId: deployment.id,
        status: "succeeded",
        stateLock: result.stateLock ??
          stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
        outputs,
        ...(diagnostics ? { diagnostics } : {}),
        auditEvents: [
          ...running.auditEvents,
          auditEvent(applyRun.id, "apply.completed", now, {
            deploymentId: deployment.id,
            outputCount: outputs.length,
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      await this.#store.putApplyRun(completed);
      return {
        applyRun: completed,
        installation: patched ?? installation,
        deployment,
      };
    } catch (error) {
      const now = this.#now();
      const failed: ApplyRun = {
        ...running,
        status: "failed",
        stateLock: stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
        diagnostics: [errorDiagnostic(error)],
        auditEvents: [
          ...running.auditEvents,
          auditEvent(applyRun.id, "apply.failed", now, {
            message: errorMessage(error),
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      await this.#store.putApplyRun(failed);
      return { applyRun: failed };
    }
  }

  async #executeDestroyApply(
    running: ApplyRun,
    planRun: PlanRun,
    profile: RunnerProfile,
    startedAt: number,
    plannedInstallation: Installation | undefined,
  ): Promise<ApplyRunResponse> {
    if (!planRun.installationId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "destroy apply requires a PlanRun with installationId",
      );
    }
    if (!planRun.planArtifact) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has no immutable destroy plan artifact`,
      );
    }
    const installation = plannedInstallation ??
      await this.#requireCurrentPlannedInstallation(planRun);
    try {
      const result = await this.#runner!.destroy?.({
        applyRun: running,
        planRun,
        planArtifact: planRun.planArtifact,
        installation,
        runnerProfile: profile,
      });
      const now = this.#now();
      const patched = await this.#store.patchInstallation(installation.id, {
        currentDeploymentId: null,
        status: "destroyed",
        updatedAt: now,
      }, {
        currentDeploymentId: planRun.installationCurrentDeploymentId ?? null,
        status: installation.status,
      });
      const diagnostics = redactRunDiagnostics(result?.diagnostics);
      const completed: ApplyRun = {
        ...running,
        status: "succeeded",
        stateLock: stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
        ...(diagnostics ? { diagnostics } : {}),
        auditEvents: [
          ...running.auditEvents,
          auditEvent(running.id, "destroy.completed", now, {
            installationId: installation.id,
          }),
          auditEvent(running.id, "apply.completed", now, {
            operation: "destroy",
            installationId: installation.id,
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      await this.#store.putApplyRun(completed);
      return { applyRun: completed, installation: patched ?? installation };
    } catch (error) {
      if (error instanceof InstallationPatchGuardConflict) {
        throw new OpenTofuControllerError("failed_precondition", error.message);
      }
      const now = this.#now();
      const failed: ApplyRun = {
        ...running,
        status: "failed",
        stateLock: stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
        diagnostics: [errorDiagnostic(error)],
        auditEvents: [
          ...running.auditEvents,
          auditEvent(running.id, "destroy.failed", now, {
            message: errorMessage(error),
          }),
        ],
        updatedAt: now,
        finishedAt: now,
      };
      await this.#store.putApplyRun(failed);
      return { applyRun: failed, installation };
    }
  }

  async #upsertInstallationFromApply(input: {
    readonly planRun: PlanRun;
    readonly profile: RunnerProfile;
    readonly now: number;
    readonly plannedInstallation?: Installation;
  }): Promise<Installation> {
    if (input.planRun.installationId) {
      const existing = input.plannedInstallation ??
        await this.#requireCurrentPlannedInstallation(input.planRun);
      return {
        ...existing,
        source: input.planRun.source,
        runnerProfileId: input.profile.id,
        status: "installing",
        updatedAt: input.now,
      };
    }
    const installation: Installation = {
      id: this.#newId("ins"),
      spaceId: input.planRun.spaceId,
      appId: appIdFromSource(input.planRun.source),
      source: input.planRun.source,
      runnerProfileId: input.profile.id,
      currentDeploymentId: null,
      status: "installing",
      createdAt: input.now,
      updatedAt: input.now,
    };
    await this.#store.putInstallation(installation);
    return installation;
  }

  async #requireRunnerProfile(id: string): Promise<RunnerProfile> {
    requireNonEmptyString(id, "runnerProfileId");
    const profile = await this.#store.getRunnerProfile(id);
    if (!profile) {
      throw new OpenTofuControllerError(
        "not_found",
        `runner profile ${id} not found`,
      );
    }
    return profile;
  }

  async #requirePlanRun(id: string): Promise<PlanRun> {
    const planRun = await this.#store.getPlanRun(id);
    if (!planRun) {
      throw new OpenTofuControllerError("not_found", `plan run ${id} not found`);
    }
    return planRun;
  }

  async #requireInstallation(id: string): Promise<Installation> {
    requireNonEmptyString(id, "installationId");
    const installation = await this.#store.getInstallation(id);
    if (!installation) {
      throw new OpenTofuControllerError(
        "not_found",
        `installation ${id} not found`,
      );
    }
    return installation;
  }

  async #requireCurrentPlannedInstallation(
    planRun: PlanRun,
  ): Promise<Installation> {
    if (!planRun.installationId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "PlanRun does not target an existing Installation",
      );
    }
    const installation = await this.#requireInstallation(planRun.installationId);
    validatePlannedInstallationCurrent({ planRun, installation });
    return installation;
  }

  async #seedRunnerProfiles(
    profiles: readonly RunnerProfile[],
  ): Promise<void> {
    for (const profile of profiles) {
      await this.#store.putRunnerProfile(profile);
    }
  }

  #runSerialized<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#mutationChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => next, () => next);
    this.#mutationChains.set(key, chain);
    return previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        release();
        if (this.#mutationChains.get(key) === chain) {
          this.#mutationChains.delete(key);
        }
      });
  }
}

export function createDefaultRunnerProfiles(now = Date.now()): readonly RunnerProfile[] {
  const cloudflareProvider = "registry.opentofu.org/cloudflare/cloudflare";
  const awsProvider = "registry.opentofu.org/hashicorp/aws";
  const gcpProvider = "registry.opentofu.org/hashicorp/google";
  const azureProvider = "registry.opentofu.org/hashicorp/azurerm";
  const kubernetesProvider = "registry.opentofu.org/hashicorp/kubernetes";
  const helmProvider = "registry.opentofu.org/hashicorp/helm";
  const dockerProvider = "registry.opentofu.org/kreuzwerker/docker";
  const githubProvider = "registry.opentofu.org/integrations/github";
  const digitalOceanProvider = "registry.opentofu.org/digitalocean/digitalocean";

  return [
    defaultProviderRunnerProfile(now, {
      id: "cloudflare-default",
      name: "Cloudflare default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Cloudflare resources.",
      allowedProviders: [cloudflareProvider],
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "api.cloudflare.com",
        ],
      },
      cloudflareWorkersForPlatforms: {
        dispatchNamespace: "takosumi-tenants",
        dispatchWorkerBinding: "TAKOSUMI_TENANT_DISPATCH",
        outboundWorker: {
          serviceBinding: "TAKOSUMI_OUTBOUND_WORKER",
          enforceNetworkPolicy: true,
        },
        userWorkerBindings: {
          mode: "tenant-scoped-only",
          allowedBindingKinds: [
            "kv_namespace",
            "durable_object_namespace",
            "queue",
            "r2_bucket",
            "d1_database",
          ],
        },
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "aws-default",
      name: "AWS default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use AWS resources.",
      allowedProviders: [awsProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "sts.amazonaws.com",
          "iam.amazonaws.com",
          "route53.amazonaws.com",
        ],
        allowedHostPatterns: [
          "*.amazonaws.com",
          "*.api.aws",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "gcp-default",
      name: "GCP default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Google Cloud resources.",
      allowedProviders: [gcpProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "oauth2.googleapis.com",
          "cloudresourcemanager.googleapis.com",
          "serviceusage.googleapis.com",
          "iam.googleapis.com",
        ],
        allowedHostPatterns: [
          "*.googleapis.com",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "azure-default",
      name: "Azure default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use Azure resources.",
      allowedProviders: [azureProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "login.microsoftonline.com",
          "management.azure.com",
          "graph.microsoft.com",
        ],
        allowedHostPatterns: [
          "*.azure.com",
          "*.windows.net",
          "*.microsoftonline.com",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "kubernetes-default",
      name: "Kubernetes default",
      description:
        "Operator-managed OpenTofu runner for Kubernetes and Helm modules.",
      allowedProviders: [kubernetesProvider, helmProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "operator-managed",
        allowedHosts: [
          "registry.opentofu.org",
          "kubernetes.default.svc",
        ],
        allowedHostPatterns: [
          "*.svc",
          "*.cluster.local",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "github-default",
      name: "GitHub default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use GitHub resources.",
      allowedProviders: [githubProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "api.github.com",
          "uploads.github.com",
        ],
        allowedHostPatterns: [
          "*.githubusercontent.com",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "digitalocean-default",
      name: "DigitalOcean default",
      description:
        "Reference Cloudflare Container runner for OpenTofu modules that use DigitalOcean resources.",
      allowedProviders: [digitalOceanProvider],
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "egress-allowlist",
        allowedHosts: [
          "registry.opentofu.org",
          "api.digitalocean.com",
        ],
      },
    }),
    defaultProviderRunnerProfile(now, {
      id: "docker-local",
      name: "Docker local",
      substrate: "local",
      description:
        "Local runner profile for OpenTofu modules that use a host Docker daemon.",
      allowedProviders: [dockerProvider],
      credentialRefs: [],
      cloudflareContainer: false,
      labels: templateRunnerProfileLabels(),
      networkPolicy: {
        mode: "operator-managed",
        allowedHosts: [
          "registry.opentofu.org",
        ],
      },
    }),
  ];
}

interface DefaultProviderRunnerProfileOptions {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly allowedProviders: readonly string[];
  readonly substrate?: string;
  readonly credentialRefs?: RunnerProfile["credentialRefs"];
  readonly cloudflareContainer?: RunnerProfile["cloudflareContainer"] | false;
  readonly cloudflareWorkersForPlatforms?: RunnerProfile["cloudflareWorkersForPlatforms"];
  readonly networkPolicy: NonNullable<RunnerProfile["networkPolicy"]>;
  readonly labels?: RunnerProfile["labels"];
}

const DEFAULT_CLOUDFLARE_CONTAINER_EXECUTION: NonNullable<
  RunnerProfile["cloudflareContainer"]
> = {
  image: "ghcr.io/takosjp/takosumi-opentofu-runner:1",
  queueName: "takosumi-opentofu-runs",
  durableObjectBinding: "TAKOS_OPENTOFU_RUNNER",
  workDir: "/workspace",
};

const DEFAULT_RESOURCE_LIMITS: NonNullable<RunnerProfile["resourceLimits"]> = {
  maxRunSeconds: 900,
  maxSourceArchiveBytes: 100 * 1024 * 1024,
  maxSourceDecompressedBytes: 1000 * 1024 * 1024,
  cpu: "1",
  memoryMb: 1024,
};

const DEFAULT_SECRET_EXPOSURE_POLICY: NonNullable<
  RunnerProfile["secretExposurePolicy"]
> = {
  providerCredentials: "runner-only",
  tenantWorkerOperatorSecrets: "forbidden",
  redactLogs: true,
  blockSensitiveOutputs: true,
};

function defaultProviderRunnerProfile(
  now: number,
  options: DefaultProviderRunnerProfileOptions,
): RunnerProfile {
  const credentialRefs = options.credentialRefs ??
    credentialRefsForProfile(options.id, options.allowedProviders);
  return {
    id: options.id,
    name: options.name,
    substrate: options.substrate ?? "cloudflare-containers",
    description: options.description,
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "operator-managed",
      ref: `state://takosumi/${options.id}`,
      lock: {
        kind: "operator",
        ref: `lock://takosumi/${options.id}`,
      },
    },
    allowedProviders: options.allowedProviders,
    ...(credentialRefs.length > 0 ? { credentialRefs } : {}),
    requireCredentialRefs: credentialRefs.length > 0,
    resourceLimits: DEFAULT_RESOURCE_LIMITS,
    networkPolicy: options.networkPolicy,
    ...(options.cloudflareContainer === false
      ? {}
      : {
        cloudflareContainer: options.cloudflareContainer ??
          DEFAULT_CLOUDFLARE_CONTAINER_EXECUTION,
      }),
    ...(options.cloudflareWorkersForPlatforms
      ? { cloudflareWorkersForPlatforms: options.cloudflareWorkersForPlatforms }
      : {}),
    secretExposurePolicy: DEFAULT_SECRET_EXPOSURE_POLICY,
    ...(options.labels ? { labels: options.labels } : {}),
    createdAt: now,
  };
}

function templateRunnerProfileLabels(): Readonly<Record<string, string>> {
  return {
    "takosumi.com/profile-state": "template",
  };
}

function credentialRefsForProfile(
  profileId: string,
  providers: readonly string[],
): NonNullable<RunnerProfile["credentialRefs"]> {
  return providers.map((provider) => ({
    provider,
    ref: `secret://takosumi/${profileId}`,
    required: true,
  }));
}

export function deploymentOutputsFromOpenTofu(
  outputs: OpenTofuOutputEnvelope,
): readonly DeploymentOutput[] {
  const result: DeploymentOutput[] = [];
  for (const [name, output] of Object.entries(outputs)) {
    if (output.sensitive === true) continue;
    const kind = outputKindFromName(name);
    if (!kind) continue;
    if (!isPublishableDeploymentOutputValue(name, kind, output.value)) continue;
    result.push({
      name,
      kind,
      value: output.value,
      sensitive: false,
    });
  }
  return result;
}

function normalizeDeploymentOutputs(
  outputs: OpenTofuApplyResult["outputs"],
): readonly DeploymentOutput[] {
  if (!outputs) return [];
  if (Array.isArray(outputs as unknown)) {
    return (outputs as readonly DeploymentOutput[]).filter((output) =>
      output.sensitive === false &&
      isPublishableDeploymentOutputValue(output.name, output.kind, output.value)
    );
  }
  return deploymentOutputsFromOpenTofu(outputs as OpenTofuOutputEnvelope);
}

function normalizePlanArtifact(input: {
  readonly artifact: OpenTofuPlanArtifact;
  readonly planDigest: string;
  readonly now: number;
}): OpenTofuPlanArtifact {
  requireNonEmptyString(input.artifact.ref, "planArtifact.ref");
  requireNonEmptyString(input.artifact.digest, "planArtifact.digest");
  if (input.artifact.digest !== input.planDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "planArtifact.digest must match planDigest",
    );
  }
  return {
    kind: input.artifact.kind || "runner-local",
    ref: input.artifact.ref,
    digest: input.artifact.digest,
    ...(input.artifact.contentType
      ? { contentType: input.artifact.contentType }
      : {}),
    ...(input.artifact.sizeBytes !== undefined
      ? { sizeBytes: input.artifact.sizeBytes }
      : {}),
    createdAt: input.artifact.createdAt ?? input.now,
  };
}

function normalizePlanSummary(
  summary: PlanRunSummary | undefined,
): PlanRunSummary | undefined {
  if (!summary) return undefined;
  const normalized: PlanRunSummary = {
    ...(typeof summary.add === "number" ? { add: summary.add } : {}),
    ...(typeof summary.change === "number" ? { change: summary.change } : {}),
    ...(typeof summary.destroy === "number" ? { destroy: summary.destroy } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function outputKindFromName(name: string): DeploymentOutput["kind"] | undefined {
  const normalized = name.replace(/^takosumi_/, "");
  switch (normalized) {
    case "launch_url":
    case "admin_url":
    case "health_url":
    case "docs_url":
    case "service_url":
      return normalized;
    default:
      return undefined;
  }
}

const SECRET_OUTPUT_NAME_RE =
  /(?:^|[_-])(token|secret|password|passwd|credential|auth|bearer|session|cookie|key)(?:$|[_-])/i;
const SECRET_QUERY_RE =
  /(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key)/i;

function isPublishableDeploymentOutputValue(
  name: string,
  kind: DeploymentOutput["kind"],
  value: JsonValue,
): boolean {
  if (SECRET_OUTPUT_NAME_RE.test(name)) return false;
  if (typeof value !== "string") return true;
  if (!kind.endsWith("_url")) return !SECRET_QUERY_RE.test(value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) return false;
  }
  return true;
}

function evaluatePolicy(input: {
  readonly profile: RunnerProfile;
  readonly requiredProviders: readonly string[];
  readonly checkedAt: number;
}): PolicyDecision {
  const reasons: string[] = [];
  const templateReason = templateProfileDisabledReason(input.profile);
  if (templateReason) reasons.push(templateReason);
  if (
    input.profile.allowedProviders.length > 0 &&
    input.requiredProviders.length === 0
  ) {
    reasons.push(
      `runner profile ${input.profile.id} requires requiredProviders before OpenTofu init`,
    );
  }
  for (const provider of input.requiredProviders) {
    if (providerDenied(provider, input.profile.deniedProviders ?? [])) {
      reasons.push(`provider ${provider} is denied by runner profile ${input.profile.id}`);
      continue;
    }
    if (!providerAllowed(provider, input.profile.allowedProviders)) {
      reasons.push(`provider ${provider} is not allowed by runner profile ${input.profile.id}`);
    }
    if (
      input.profile.requireCredentialRefs === true &&
      !credentialRefPresent(provider, input.profile.credentialRefs ?? [])
    ) {
      reasons.push(
        `credential reference for provider ${provider} is missing from runner profile ${input.profile.id}`,
      );
    }
  }
  return {
    status: reasons.length === 0 ? "passed" : "blocked",
    reasons,
    checkedAt: input.checkedAt,
  };
}

function validateOperationInstallationShape(input: {
  readonly operation: OpenTofuOperation;
  readonly installation?: Installation;
  readonly requestedSpaceId: string;
  readonly requestedSource: OpenTofuModuleSource;
  readonly runnerProfileId: string;
}): void {
  if (input.operation === "create" && input.installation) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "create PlanRun must not target an existing installationId",
    );
  }
  if (
    (input.operation === "update" || input.operation === "destroy") &&
    !input.installation
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${input.operation} PlanRun requires installationId`,
    );
  }
  if (
    input.installation &&
    input.installation.spaceId !== input.requestedSpaceId
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} belongs to space ${input.installation.spaceId}, not ${input.requestedSpaceId}`,
    );
  }
  if (!input.installation) return;
  if (
    (input.operation === "update" || input.operation === "destroy") &&
    input.installation.currentDeploymentId === null
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `${input.operation} PlanRun requires an Installation with a current Deployment`,
    );
  }
  if (input.installation.runnerProfileId !== input.runnerProfileId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} uses runner profile ${input.installation.runnerProfileId}, not ${input.runnerProfileId}`,
    );
  }
  if (!sourceIdentityMatches(input.installation.source, input.requestedSource)) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} source identity does not match the requested OpenTofu module source`,
    );
  }
}

function validatePlannedInstallationCurrent(input: {
  readonly planRun: PlanRun;
  readonly installation: Installation;
}): void {
  if (input.installation.spaceId !== input.planRun.spaceId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} no longer belongs to PlanRun space ${input.planRun.spaceId}`,
    );
  }
  if (input.installation.runnerProfileId !== input.planRun.runnerProfileId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} runner profile changed since PlanRun ${input.planRun.id}`,
    );
  }
  if (
    !sourceIdentityMatches(input.installation.source, input.planRun.source)
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} source identity changed since PlanRun ${input.planRun.id}`,
    );
  }
  const expectedCurrentDeploymentId =
    input.planRun.installationCurrentDeploymentId ?? null;
  if (input.installation.currentDeploymentId !== expectedCurrentDeploymentId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} current Deployment changed since PlanRun ${input.planRun.id}`,
    );
  }
}

function sourceIdentityMatches(
  existing: OpenTofuModuleSource,
  requested: OpenTofuModuleSource,
): boolean {
  if (existing.kind !== requested.kind) return false;
  if ((existing.modulePath ?? "") !== (requested.modulePath ?? "")) return false;
  if (existing.kind === "git" && requested.kind === "git") {
    return existing.url === requested.url;
  }
  if (existing.kind === "prepared" && requested.kind === "prepared") {
    return existing.url === requested.url;
  }
  if (existing.kind === "local" && requested.kind === "local") {
    return existing.path === requested.path;
  }
  return false;
}

function validateSourceAllowedByProfile(
  source: OpenTofuModuleSource,
  profile: RunnerProfile,
): void {
  if (source.kind !== "local") return;
  if (profile.sourcePolicy?.allowLocalSource === true) return;
  throw new OpenTofuControllerError(
    "failed_precondition",
    `runner profile ${profile.id} does not allow local source paths`,
  );
}

function templateProfileDisabledReason(profile: RunnerProfile): string | undefined {
  if (profile.labels?.["takosumi.com/profile-state"] !== "template") {
    return undefined;
  }
  if (profile.labels?.["takosumi.com/profile-enabled"] === "true") {
    return undefined;
  }
  return `runner profile ${profile.id} is a disabled template; clone it or set takosumi.com/profile-enabled=true after operator validation`;
}

function credentialRefPresent(
  provider: string,
  refs: NonNullable<RunnerProfile["credentialRefs"]>,
): boolean {
  return refs.some((ref) => providerMatches(provider, ref.provider));
}

function providerAllowed(
  provider: string,
  allowedProviders: readonly string[],
): boolean {
  return allowedProviders.some((allowed) =>
    allowed === "*" || providerMatches(provider, allowed)
  );
}

function providerDenied(
  provider: string,
  deniedProviders: readonly string[],
): boolean {
  return deniedProviders.some((denied) => providerMatches(provider, denied));
}

export function providerMatches(provider: string, rule: string): boolean {
  // Hierarchical, one-directional: a fully-qualified provider address
  // (`registry/namespace/type`) matches a short allowlist rule (its trailing
  // type), e.g. `registry.opentofu.org/cloudflare/cloudflare` matches rule
  // `cloudflare`. The reverse must NOT hold — a specific fully-qualified RULE
  // must not admit an ambiguous bare provider name (e.g. rule
  // `registry.opentofu.org/hashicorp/aws` must not match provider `aws`), which
  // would silently widen the allowlist (and inconsistently narrow the denylist).
  return provider === rule || provider.endsWith(`/${rule}`);
}

function checkApplyExpected(
  expected: CreateApplyRunRequest["expected"],
  planRun: PlanRun,
): void {
  if (!expected) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "apply requires expected guard from the reviewed PlanRun",
    );
  }
  const reviewed = applyExpectedGuardFromPlanRun(planRun);
  if (expected.planRunId !== reviewed.planRunId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected planRunId does not match the PlanRun",
    );
  }
  if (expected.installationId !== reviewed.installationId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected installationId does not match the PlanRun",
    );
  }
  if (expected.currentDeploymentId !== reviewed.currentDeploymentId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected currentDeploymentId does not match the PlanRun",
    );
  }
  if (expected.runnerProfileId !== reviewed.runnerProfileId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected runnerProfileId does not match the PlanRun",
    );
  }
  if (expected.sourceDigest !== reviewed.sourceDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected sourceDigest does not match the PlanRun",
    );
  }
  if (expected.variablesDigest !== reviewed.variablesDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected variablesDigest does not match the PlanRun",
    );
  }
  if (expected.policyDecisionDigest !== reviewed.policyDecisionDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected policyDecisionDigest does not match the PlanRun",
    );
  }
  if (expected.planDigest !== reviewed.planDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected planDigest does not match the PlanRun",
    );
  }
  if (expected.planArtifactDigest !== reviewed.planArtifactDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected planArtifactDigest does not match the PlanRun",
    );
  }
  if (expected.sourceCommit !== reviewed.sourceCommit) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected sourceCommit does not match the PlanRun",
    );
  }
  if (expected.providerLockDigest !== reviewed.providerLockDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected providerLockDigest does not match the PlanRun",
    );
  }
}

export function applyExpectedGuardFromPlanRun(planRun: PlanRun): ApplyExpectedGuard {
  if (!planRun.planDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "PlanRun has no planDigest; apply requires a completed OpenTofu plan",
    );
  }
  if (!planRun.planArtifact) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "PlanRun has no planArtifact; apply requires an immutable plan artifact",
    );
  }
  if (
    planRun.installationId &&
    planRun.installationCurrentDeploymentId === undefined
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "PlanRun has no installation current Deployment guard",
    );
  }
  return {
    planRunId: planRun.id,
    ...(planRun.installationId ? { installationId: planRun.installationId } : {}),
    ...(planRun.installationId
      ? { currentDeploymentId: planRun.installationCurrentDeploymentId ?? null }
      : {}),
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest,
    planArtifactDigest: planRun.planArtifact.digest,
    ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
    ...(planRun.providerLockDigest
      ? { providerLockDigest: planRun.providerLockDigest }
      : {}),
  };
}

function stateLockEvidence(
  stateBackend: RunnerStateBackend,
  acquiredAt: number,
  releasedAt: number,
  status: RunnerStateLockEvidence["status"],
): RunnerStateLockEvidence {
  const backendRef = stateBackend.ref ?? stateBackend.kind;
  const lock = stateBackend.lock;
  if (!lock || lock.kind === "none") {
    return {
      status: "not_required",
      backendRef,
      acquiredAt,
      releasedAt,
    };
  }
  return {
    status,
    backendRef,
    ...(lock.ref ? { lockRef: lock.ref } : {}),
    acquiredAt,
    ...(status === "recorded" ? { releasedAt } : {}),
  };
}

function auditEvent(
  ownerId: string,
  type: string,
  at: number,
  data?: Readonly<Record<string, JsonValue>>,
  actor?: string,
): DeployControlAuditEvent {
  return {
    id: `${ownerId}:${type}:${at}`,
    type,
    at,
    ...(actor ? { actor } : {}),
    ...(data ? { data } : {}),
  };
}

function normalizeProviders(
  providers: readonly string[],
): readonly string[] {
  return providers.map((provider) => {
    requireNonEmptyString(provider, "requiredProviders[]");
    return provider;
  });
}

function normalizeVariables(
  variables: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> {
  if (variables === undefined) return {};
  if (!isRecord(variables) || Array.isArray(variables)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "variables must be a JSON object",
    );
  }
  return variables;
}

function validateOperation(operation: OpenTofuOperation): void {
  if (operation === "create" || operation === "update" || operation === "destroy") {
    return;
  }
  throw new OpenTofuControllerError(
    "invalid_argument",
    "operation must be create, update, or destroy",
  );
}

function validateSource(source: OpenTofuModuleSource): void {
  if (!isRecord(source)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "source must be a JSON object",
    );
  }
  switch (source.kind) {
    case "git":
      requireNonEmptyString(source.url, "source.url");
      validateHttpsSourceUrl(source.url, "git source url");
      if (source.ref !== undefined) requireNonEmptyString(source.ref, "source.ref");
      if (source.commit !== undefined) {
        requireNonEmptyString(source.commit, "source.commit");
        if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(source.commit)) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "source.commit must be a full git object id",
          );
        }
      }
      if (source.ref !== undefined) validateSafeGitSelector(source.ref, "source.ref");
      break;
    case "prepared":
      requireNonEmptyString(source.url, "source.url");
      validateHttpsSourceUrl(source.url, "prepared source url");
      requireNonEmptyString(source.digest, "source.digest");
      if (!SHA256_DIGEST_RE.test(source.digest)) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "prepared source digest must be sha256:<64 lowercase hex>",
        );
      }
      break;
    case "local":
      requireNonEmptyString(source.path, "source.path");
      break;
    default:
      throw new OpenTofuControllerError(
        "invalid_argument",
        "source.kind must be git, prepared, or local",
      );
  }
  if (source.modulePath !== undefined) {
    requireNonEmptyString(source.modulePath, "source.modulePath");
    validateSafeModulePath(source.modulePath);
  }
}

function validateHttpsSourceUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must be a valid URL`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must use https://`,
    );
  }
  if (!parsed.hostname) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must include a host`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must not embed credentials`,
    );
  }
  try {
    assertHostNotBlocked(parsed.hostname, `${label} host`);
  } catch (error) {
    if (error instanceof BlockedHostError) {
      throw new OpenTofuControllerError("invalid_argument", error.message);
    }
    throw error;
  }
}

function validateSafeGitSelector(value: string, label: string): void {
  if (value.startsWith("-") || /[\r\n\0]/.test(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must not start with '-' or contain control characters`,
    );
  }
}

function validateSafeModulePath(modulePath: string): void {
  if (
    modulePath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(modulePath) ||
    modulePath.split(/[\\/]+/).some((part) => part === "..")
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "source.modulePath must stay inside the source root",
    );
  }
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${field} must be a non-empty string`,
    );
  }
}

function appIdFromSource(source: OpenTofuModuleSource): string {
  const seed = source.kind === "local" ? source.path : source.url;
  const withoutQuery = seed.split(/[?#]/)[0] ?? seed;
  const parts = withoutQuery.split(/[/:]/).filter((part) => part.length > 0);
  const name = (parts[parts.length - 1] ?? source.kind).replace(/\.git$/, "");
  const moduleSuffix = source.modulePath
    ? `-${source.modulePath.replace(/[^a-zA-Z0-9._-]+/g, "-")}`
    : "";
  return `${name}${moduleSuffix}`.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "opentofu-module";
}

function errorDiagnostic(error: unknown): RunDiagnostic {
  return {
    severity: "error",
    message: errorMessage(error),
  };
}

function errorMessage(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

function redactRunDiagnostics(
  diagnostics: readonly RunDiagnostic[] | undefined,
): readonly RunDiagnostic[] | undefined {
  if (!diagnostics) return undefined;
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: redactString(diagnostic.message),
    ...(diagnostic.detail === undefined
      ? {}
      : { detail: redactString(diagnostic.detail) }),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
