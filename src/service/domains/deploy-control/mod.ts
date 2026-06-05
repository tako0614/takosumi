/**
 * OpenTofu-native deployment-control-plane domain.
 *
 * Takosumi owns the API-facing ledger and policy gate. RunnerProfiles provide
 * provider allowlists, state-backend ownership, and runner substrate choice.
 * OpenTofu execution is delegated to an injected runner, normally a
 * Cloudflare Container runner in the reference distribution.
 *
 * This module hosts the controller and run-execution ceremony. Four cohesive
 * concerns live in sibling files and are composed in here:
 *   - `runner_profiles.ts` — default RunnerProfile seed data
 *   - `policy.ts`          — RunnerProfile policy engine
 *   - `validation.ts`      — request / source validation and identity guards
 *   - `projection.ts`      — output / diagnostic projection and redaction
 */

import type { JsonValue } from "takosumi-contract";
import type {
  ApplyExpectedGuard,
  ApplyRun,
  ApplyRunResponse,
  Connection,
  ConnectionResponse,
  CreateApplyRunRequest,
  CreateConnectionRequest,
  CreatePlanRunRequest,
  DeployControlAuditEvent,
  Deployment,
  DeploymentOutput,
  GetInstallationResponse,
  Installation,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListDeploymentOutputsResponse,
  ListRunnerProfilesResponse,
  OpenTofuOutputEnvelope,
  OpenTofuPlanArtifact,
  PlanRun,
  PlanRunResponse,
  PlanRunSummary,
  RunnerProfile,
  RunnerStateLockEvidence,
  RunDiagnostic,
  TestConnectionResponse,
} from "takosumi-contract/deploy-control-api";
import type {
  ConnectionVault,
  CredentialBundle,
} from "../../adapters/vault/mod.ts";
import { ConnectionVaultError } from "../../adapters/vault/mod.ts";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import {
  InMemoryOpenTofuDeploymentStore,
  InstallationPatchGuardConflict,
  type OpenTofuDeploymentStore,
} from "./store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import { createDefaultRunnerProfiles } from "./runner_profiles.ts";
import { evaluatePolicy } from "./policy.ts";
import {
  appIdFromSource,
  normalizeProviders,
  normalizeVariables,
  validateOperation,
  validateOperationInstallationShape,
  validatePlannedInstallationCurrent,
  validateSource,
  validateSourceAllowedByProfile,
} from "./validation.ts";
import {
  errorDiagnostic,
  errorMessage,
  normalizeDeploymentOutputs,
  normalizePlanArtifact,
  normalizePlanSummary,
  redactRunDiagnostics,
  stateLockEvidence,
} from "./projection.ts";

// Re-export the shared error primitive and the four decomposed concerns so the
// domain's public entry point stays `./mod.ts` for importers and tests.
export {
  OpenTofuControllerError,
  type OpenTofuControllerErrorCode,
} from "./errors.ts";
export {
  createDefaultRunnerProfiles,
  parseEnabledRunnerProfileIds,
  resolveEnabledRunnerProfiles,
} from "./runner_profiles.ts";
export { providerMatches } from "./policy.ts";
export { deploymentOutputsFromOpenTofu } from "./projection.ts";

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
  /**
   * Credential Vault broker. When present, the controller exposes the
   * Connection lifecycle (`createConnection` / `listConnections` /
   * `testConnection` / `deleteConnection`) and `mintCredentialBundle`. When
   * absent, those methods throw `not_implemented`. The Vault is intentionally
   * NOT wired into plan/apply dispatch here — that is Phase 1B.
   */
  readonly vault?: ConnectionVault;
}

export interface DeployControlActorContext {
  readonly actor?: string;
}

export class OpenTofuDeploymentController {
  readonly #store: OpenTofuDeploymentStore;
  readonly #runner?: OpenTofuRunner;
  readonly #vault?: ConnectionVault;
  readonly #defaultRunnerProfileId: string;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => number;
  readonly #seededProfiles: Promise<void>;
  readonly #mutationChains = new Map<string, Promise<void>>();

  constructor(dependencies: OpenTofuDeploymentControllerDependencies = {}) {
    this.#store = dependencies.store ?? new InMemoryOpenTofuDeploymentStore();
    this.#runner = dependencies.runner;
    this.#vault = dependencies.vault;
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
    // SECURITY (apply-once / idempotency): a `create` plan never carries an
    // installationId, so without this guard each apply allocates a brand-new
    // Installation + Deployment (and real cloud resources). Reject any apply of a
    // PlanRun that has already been successfully applied. (update/destroy were
    // already replay-protected by the installation currentDeploymentId guard.)
    if (planRun.appliedApplyRunId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has already been applied by apply run ${planRun.appliedApplyRunId}`,
      );
    }
    await checkApplyExpected(request.expected, planRun);
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

  // --- Connections (provider credential registration; Phase 1A) -------------

  async createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse> {
    const vault = this.#requireVault();
    try {
      const connection = await vault.register(request);
      return { connection };
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  async listConnections(spaceId: string): Promise<ListConnectionsResponse> {
    requireNonEmptyString(spaceId, "spaceId");
    return { connections: await this.#store.listConnections(spaceId) };
  }

  async getConnection(connectionId: string): Promise<Connection> {
    requireNonEmptyString(connectionId, "connectionId");
    const connection = await this.#store.getConnection(connectionId);
    if (!connection) {
      throw new OpenTofuControllerError(
        "not_found",
        `connection ${connectionId} not found`,
      );
    }
    return connection;
  }

  async testConnection(
    connectionId: string,
  ): Promise<TestConnectionResponse> {
    const vault = this.#requireVault();
    requireNonEmptyString(connectionId, "connectionId");
    try {
      return await vault.test(connectionId);
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  async deleteConnection(connectionId: string): Promise<boolean> {
    const vault = this.#requireVault();
    requireNonEmptyString(connectionId, "connectionId");
    try {
      return await vault.revoke(connectionId);
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  /**
   * Mints a credential bundle for a space + providers. Exposed for Phase 1B
   * dispatch; NOT wired into plan/apply here. Returns an opaque
   * {@link CredentialBundle} that never serializes its values.
   */
  async mintCredentialBundle(
    spaceId: string,
    providers: readonly string[],
  ): Promise<CredentialBundle> {
    const vault = this.#requireVault();
    try {
      return await vault.mint(spaceId, providers);
    } catch (error) {
      throw mapVaultError(error);
    }
  }

  #requireVault(): ConnectionVault {
    if (!this.#vault) {
      throw new OpenTofuControllerError(
        "not_implemented",
        "connection vault is not configured",
      );
    }
    return this.#vault;
  }

  // Status-transition ceremony shared by the three execute paths: clone the run
  // into `running`, append the phase `started` audit event, persist, and return
  // the running run.
  async #markPlanRunning(planRun: PlanRun): Promise<PlanRun> {
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
    return running;
  }

  async #markApplyRunning(
    applyRun: ApplyRun,
    profile: RunnerProfile,
    startedAt: number,
  ): Promise<ApplyRun> {
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
    return running;
  }

  // Failure ceremony shared by the three catch bodies: clone the running run
  // into `failed`, attach the redacted error diagnostic and the phase `failed`
  // audit event, persist, and return the failed run.
  async #failPlanRun(running: PlanRun, error: unknown): Promise<PlanRun> {
    const now = this.#now();
    const failed: PlanRun = {
      ...running,
      status: "failed",
      diagnostics: [errorDiagnostic(error)],
      auditEvents: [
        ...running.auditEvents,
        auditEvent(running.id, "plan.failed", now, {
          message: errorMessage(error),
        }),
      ],
      updatedAt: now,
      finishedAt: now,
    };
    await this.#store.putPlanRun(failed);
    return failed;
  }

  async #failApplyRun(
    running: ApplyRun,
    profile: RunnerProfile,
    startedAt: number,
    eventType: "apply.failed" | "destroy.failed",
    error: unknown,
  ): Promise<ApplyRun> {
    const now = this.#now();
    const failed: ApplyRun = {
      ...running,
      status: "failed",
      stateLock: stateLockEvidence(profile.stateBackend, startedAt, now, "recorded"),
      diagnostics: [errorDiagnostic(error)],
      auditEvents: [
        ...running.auditEvents,
        auditEvent(running.id, eventType, now, {
          message: errorMessage(error),
        }),
      ],
      updatedAt: now,
      finishedAt: now,
    };
    await this.#store.putApplyRun(failed);
    return failed;
  }

  async #executePlan(
    planRun: PlanRun,
    profile: RunnerProfile,
    variables: Readonly<Record<string, JsonValue>>,
  ): Promise<PlanRun> {
    const running = await this.#markPlanRunning(planRun);
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
      return await this.#failPlanRun(running, error);
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
    // Apply-once re-check inside the serialized section: a concurrent apply of the
    // same PlanRun is serialized on its id, so re-read the persisted PlanRun here
    // to observe a sibling apply that already completed and marked it applied.
    const persistedPlan = await this.#store.getPlanRun(planRun.id);
    if (persistedPlan?.appliedApplyRunId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `plan run ${planRun.id} has already been applied by apply run ${persistedPlan.appliedApplyRunId}`,
      );
    }
    const plannedInstallation = planRun.installationId
      ? await this.#requireCurrentPlannedInstallation(planRun)
      : undefined;
    const startedAt = this.#now();
    const running = await this.#markApplyRunning(applyRun, profile, startedAt);
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
      // Mark the PlanRun applied so it cannot be applied again (apply-once).
      await this.#store.putPlanRun({
        ...planRun,
        appliedApplyRunId: applyRun.id,
        updatedAt: now,
      });
      return {
        applyRun: completed,
        installation: patched ?? installation,
        deployment,
      };
    } catch (error) {
      const failed = await this.#failApplyRun(
        running,
        profile,
        startedAt,
        "apply.failed",
        error,
      );
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
      if (typeof this.#runner!.destroy !== "function") {
        // Without a real teardown the Installation must NOT be marked
        // destroyed: doing so would record a successful destroy in the ledger
        // while the underlying cloud resources keep running (silent leak).
        throw new OpenTofuControllerError(
          "failed_precondition",
          "runner does not implement destroy; refusing to mark installation destroyed without teardown",
        );
      }
      const result = await this.#runner!.destroy({
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
      // Mark the PlanRun applied so a destroy plan cannot be re-applied.
      await this.#store.putPlanRun({
        ...planRun,
        appliedApplyRunId: running.id,
        updatedAt: now,
      });
      return { applyRun: completed, installation: patched ?? installation };
    } catch (error) {
      if (error instanceof InstallationPatchGuardConflict) {
        throw new OpenTofuControllerError("failed_precondition", error.message);
      }
      const failed = await this.#failApplyRun(
        running,
        profile,
        startedAt,
        "destroy.failed",
        error,
      );
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

async function checkApplyExpected(
  expected: CreateApplyRunRequest["expected"],
  planRun: PlanRun,
): Promise<void> {
  if (!expected) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "apply requires expected guard from the reviewed PlanRun",
    );
  }
  const reviewed = applyExpectedGuardFromPlanRun(planRun);
  // Structural compare: the request guard must reproduce the reviewed guard
  // exactly. Both sides are projected onto the same fixed guard key set (absent
  // optional keys normalized to `undefined`) before digesting, so this is
  // equivalent to the prior per-field equality over every known guard field —
  // including the directions where one side omits an optional field.
  const [reviewedHash, expectedHash] = await Promise.all([
    stableJsonDigest(projectApplyExpectedGuard(reviewed)),
    stableJsonDigest(projectApplyExpectedGuard(expected)),
  ]);
  if (reviewedHash !== expectedHash) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "expected guard does not match the reviewed PlanRun",
    );
  }
}

// Canonical key order for the ApplyExpectedGuard structural compare. Listing the
// fixed field set (instead of an object's own keys) keeps the digest comparison
// equivalent to the prior per-field equality: every known guard field is
// compared in both directions, and absent optional fields read as `undefined`.
const APPLY_EXPECTED_GUARD_KEYS = [
  "planRunId",
  "installationId",
  "currentDeploymentId",
  "runnerProfileId",
  "sourceDigest",
  "variablesDigest",
  "policyDecisionDigest",
  "planDigest",
  "planArtifactDigest",
  "sourceCommit",
  "providerLockDigest",
] as const satisfies readonly (keyof ApplyExpectedGuard)[];

function projectApplyExpectedGuard(
  guard: ApplyExpectedGuard,
): Record<string, JsonValue | null | undefined> {
  const projection: Record<string, JsonValue | null | undefined> = {};
  for (const key of APPLY_EXPECTED_GUARD_KEYS) {
    projection[key] = guard[key];
  }
  return projection;
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

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// Translate a Vault error into the controller error vocabulary. Missing env
// groups (no values) are appended to the message so callers can fix their
// registration without the Vault ever exposing secret material.
function mapVaultError(error: unknown): unknown {
  if (!(error instanceof ConnectionVaultError)) return error;
  const groups = error.missingEnvGroups;
  const suffix = groups && groups.length > 0
    ? `: provide one of [${groups.map((group) => group.join("+")).join(", ")}]`
    : "";
  return new OpenTofuControllerError(error.code, `${error.message}${suffix}`);
}
