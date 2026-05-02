// Rollout canary service — Deployment-centric port.
//
// Each canary step generates a fresh Deployment whose
// `desired.activation_envelope.rollout_strategy` carries the HTTP-weighted
// assignment model for the step. We resolve+apply the Deployment via the
// canonical `DeploymentService`, which atomically advances the GroupHead
// pointer on success.

import type {
  Deployment,
  DeploymentCondition,
  GroupHead,
  JsonObject,
  JsonValue,
} from "takosumi-contract";
import type { PublicDeployManifest } from "../../domains/deploy/types.ts";
import type { DriftSample, DriftWatcher } from "./drift_watcher.ts";
import type {
  HttpWeightedAssignmentModelDto,
  RolloutRun,
  RolloutRunInput,
  RolloutRunStepInput,
  RolloutStepDriftAbort,
  RolloutStepResult,
  SideEffectPolicyReport,
} from "./types.ts";

/**
 * Subset of the deploy-domain `DeploymentService` used by rollout. Kept as a
 * structural interface so the rollout service stays decoupled from the
 * concrete `DeploymentService` class while Phase 3 Agent A finalises it.
 *
 * Phase 18.3: `rollbackGroup` is exposed (optional) so the rollout service
 * can auto-revert the GroupHead when a canary step is aborted on drift and
 * the operator policy has opted in via `autoRollbackOnDrift`. It mirrors
 * `DeploymentService.rollbackGroup` but is kept structural so tests can
 * inject a stub without depending on the full deploy domain.
 */
export interface RolloutDeploymentClient {
  resolveDeployment(input: RolloutResolveInput): Promise<Deployment>;
  applyDeployment(deploymentId: string): Promise<RolloutApplyOutcome>;
  /**
   * Append a condition record to an existing Deployment. Used by the rollout
   * service to stamp `CanaryAbortedOnDrift` on the step Deployment when
   * drift is detected. Implementations SHOULD leave the Deployment status
   * untouched — the condition is purely audit / observability metadata.
   */
  appendDeploymentCondition?(
    input: RolloutAppendConditionInput,
  ): Promise<Deployment>;
  /**
   * Auto-rollback hook used when `autoRollbackOnDrift` is enabled. Reverts
   * the GroupHead pointer to a previously-applied Deployment (typically the
   * pre-canary head) so the canary slice of traffic stops being routed to
   * the drifted release.
   */
  rollbackGroup?(input: RolloutRollbackInput): Promise<GroupHead>;
}

export interface RolloutAppendConditionInput {
  readonly deploymentId: string;
  readonly condition: DeploymentCondition;
}

export interface RolloutRollbackInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly targetDeploymentId: string;
  readonly reason?: string;
  readonly advancedAt?: string;
}

export interface RolloutResolveInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly manifest: PublicDeployManifest;
  readonly mode?: "resolve" | "apply";
  readonly deploymentId?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
}

export interface RolloutApplyOutcome {
  readonly deployment: Deployment;
  readonly groupHead: GroupHead;
}

/**
 * Operator policy controlling auto-mitigation behaviour when a canary step
 * detects drift. `autoRollbackOnDrift` is opt-in: the default is `false` so
 * existing rollouts keep their previous semantics (abort + surface the
 * condition, but leave the GroupHead alone).
 */
export interface RolloutCanaryPolicy {
  readonly autoRollbackOnDrift?: boolean;
}

export const DEFAULT_ROLLOUT_CANARY_POLICY: Required<RolloutCanaryPolicy> = {
  autoRollbackOnDrift: false,
};

export interface RolloutCanaryServiceOptions {
  readonly deploymentService: RolloutDeploymentClient;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  /**
   * Optional drift sampler invoked once per step after `applyDeployment`
   * resolves. When omitted the service skips drift checks and behaves the
   * same as the pre-Phase-18.3 implementation.
   */
  readonly driftWatcher?: DriftWatcher;
  /** Operator policy for drift-driven auto-rollback. */
  readonly policy?: RolloutCanaryPolicy;
}

export class RolloutCanaryService {
  readonly #deployments: RolloutDeploymentClient;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #driftWatcher: DriftWatcher | undefined;
  readonly #policy: Required<RolloutCanaryPolicy>;

  constructor(options: RolloutCanaryServiceOptions) {
    this.#deployments = options.deploymentService;
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
    this.#driftWatcher = options.driftWatcher;
    this.#policy = {
      ...DEFAULT_ROLLOUT_CANARY_POLICY,
      ...(options.policy ?? {}),
    };
  }

  /**
   * Applies every canary step as a distinct Deployment. Each step is resolved
   * + applied immediately so subsequent steps observe the GroupHead advanced
   * by the previous step. Returns the chain of Deployments plus per-step
   * results.
   *
   * Phase 18.3: after each step's `applyDeployment` resolves, the drift
   * watcher (if configured) samples `ProviderObservation` records scoped to
   * the step's materializations. When the sample's verdict is `abort`, the
   * step is marked `aborted`, a `CanaryAbortedOnDrift` condition is appended
   * to the step Deployment, and — if the operator policy has opted in via
   * `autoRollbackOnDrift` — the GroupHead is reverted to the configured
   * rollback target (or the previous step's Deployment).
   */
  async run(input: RolloutRunInput): Promise<RolloutRun> {
    const createdAt = input.createdAt ?? this.#now();
    const runId = input.runId ?? this.#idFactory();
    const groupId = input.groupId ?? input.manifest.name;
    const stepResults: RolloutStepResult[] = [];
    const deployments: Deployment[] = [];
    let updatedAt = createdAt;
    let driftAbort: RolloutStepDriftAbort | undefined;

    for (const [index, step] of input.steps.entries()) {
      const appliedAt = this.#now();
      let outcomeDeploymentId: string | undefined;
      try {
        const assignmentModel = buildHttpWeightedAssignmentModel({
          manifest: input.manifest,
          primaryAppReleaseId: input.primaryAppReleaseId,
          step,
        });
        const stepManifest = withRolloutAssignment(
          input.manifest,
          assignmentModel,
        );
        const resolved = await this.#deployments.resolveDeployment({
          spaceId: input.spaceId,
          groupId,
          manifest: stepManifest,
          mode: "apply",
          deploymentId: input.deploymentIdFactory?.(step, index),
          createdAt: appliedAt,
          createdBy: input.createdBy,
        });
        const outcome = await this.#deployments.applyDeployment(resolved.id);
        outcomeDeploymentId = outcome.deployment.id;
        deployments.push(outcome.deployment);
        updatedAt = appliedAt;

        // Phase 18.3 — sample drift after the step is applied. If the
        // verdict is `abort`, halt the run and mark the step `aborted`.
        const sample = await this.#sampleDrift({
          watcher: this.#driftWatcher,
          step,
          deploymentId: outcome.deployment.id,
          sampledSince: appliedAt,
        });
        if (sample?.verdict === "abort") {
          const abortAt = this.#now();
          updatedAt = abortAt;
          driftAbort = await this.#handleDriftAbort({
            input,
            groupId,
            step,
            stepIndex: index,
            stepDeploymentId: outcome.deployment.id,
            previousStepResults: stepResults,
            sample,
            abortAt,
          });
          stepResults.push(Object.freeze({
            id: step.id,
            name: step.name,
            status: "aborted" as const,
            canaryAppReleaseId: step.canaryAppReleaseId,
            canaryWeightPermille: step.canaryWeightPermille,
            deploymentId: outcome.deployment.id,
            groupHead: outcome.groupHead,
            appliedAt,
            driftAbort,
          }));
          break;
        }

        stepResults.push(Object.freeze({
          id: step.id,
          name: step.name,
          status: "applied" as const,
          canaryAppReleaseId: step.canaryAppReleaseId,
          canaryWeightPermille: step.canaryWeightPermille,
          deploymentId: outcome.deployment.id,
          groupHead: outcome.groupHead,
          appliedAt,
        }));
      } catch (error) {
        updatedAt = appliedAt;
        stepResults.push(Object.freeze({
          id: step.id,
          name: step.name,
          status: "failed" as const,
          canaryAppReleaseId: step.canaryAppReleaseId,
          canaryWeightPermille: step.canaryWeightPermille,
          deploymentId: outcomeDeploymentId,
          appliedAt,
          error: error instanceof Error ? error.message : String(error),
        }));
        break;
      }
    }

    const latestStep = input.steps[input.steps.length - 1];
    const assignmentModel = buildHttpWeightedAssignmentModel({
      manifest: input.manifest,
      primaryAppReleaseId: input.primaryAppReleaseId,
      step: latestStep,
    });
    const failed = stepResults.some((step) => step.status === "failed");
    const aborted = stepResults.some((step) => step.status === "aborted");
    const complete = stepResults.length === input.steps.length && !failed &&
      !aborted;

    return deepFreeze({
      id: runId,
      spaceId: input.spaceId,
      groupId,
      primaryAppReleaseId: input.primaryAppReleaseId,
      status: aborted
        ? "aborted"
        : failed
        ? "failed"
        : complete
        ? "succeeded"
        : "pending",
      steps: stepResults,
      deployments,
      assignmentModel,
      sideEffectPolicyReport: buildSideEffectPolicyReport(),
      createdAt,
      updatedAt,
      driftAbort,
    });
  }

  async #sampleDrift(args: {
    readonly watcher: DriftWatcher | undefined;
    readonly step: RolloutRunStepInput;
    readonly deploymentId: string;
    readonly sampledSince: string;
  }): Promise<DriftSample | undefined> {
    if (!args.watcher) return undefined;
    const materializationIds = args.step.materializationIds ?? [];
    return await args.watcher.sample({
      deploymentId: args.deploymentId,
      stepId: args.step.id,
      materializationIds,
      sampledSince: args.sampledSince,
    });
  }

  /**
   * Phase 18.3 — handle a drift-driven abort:
   *   1. Stamp `CanaryAbortedOnDrift` on the step Deployment via the
   *      optional `appendDeploymentCondition` hook.
   *   2. If `policy.autoRollbackOnDrift` is true and the deployment client
   *      exposes `rollbackGroup`, revert the GroupHead to the configured
   *      rollback target. The target defaults to the previous step's
   *      Deployment id; when there is no previous step the run skips
   *      rollback (the GroupHead is whatever was current before the run).
   *   3. Build the `RolloutStepDriftAbort` audit record returned to the
   *      caller and surfaced on the step + run summary.
   */
  async #handleDriftAbort(args: {
    readonly input: RolloutRunInput;
    readonly groupId: string;
    readonly step: RolloutRunStepInput;
    readonly stepIndex: number;
    readonly stepDeploymentId: string;
    readonly previousStepResults: readonly RolloutStepResult[];
    readonly sample: DriftSample;
    readonly abortAt: string;
  }): Promise<RolloutStepDriftAbort> {
    const observation = args.sample.observation;
    const reason = observation?.driftReason ?? "ProviderDrift";
    const condition: DeploymentCondition = {
      type: "CanaryAbortedOnDrift",
      status: "true",
      reason: driftReasonToConditionReason(reason),
      message: buildDriftAbortMessage({
        stepId: args.step.id,
        reason,
        materializationId: observation?.materializationId,
        providerId: observation?.providerId,
      }),
      observed_generation: args.stepIndex + 1,
      last_transition_time: args.abortAt,
      scope: { kind: "deployment" },
    };

    if (typeof this.#deployments.appendDeploymentCondition === "function") {
      try {
        await this.#deployments.appendDeploymentCondition({
          deploymentId: args.stepDeploymentId,
          condition,
        });
      } catch (_error) {
        // Condition stamping is observability metadata. A failure here MUST
        // not mask the abort itself — the run still terminates with the
        // `aborted` status and the rollback decision is independent.
      }
    }

    let autoRollbackTriggered = false;
    let rolledBackToDeploymentId: string | undefined;
    if (
      this.#policy.autoRollbackOnDrift &&
      typeof this.#deployments.rollbackGroup === "function"
    ) {
      const target = resolveRollbackTarget({
        explicit: args.input.rollbackTargetDeploymentId,
        previousStepResults: args.previousStepResults,
      });
      if (target) {
        try {
          await this.#deployments.rollbackGroup({
            spaceId: args.input.spaceId,
            groupId: args.groupId,
            targetDeploymentId: target,
            reason: "CanaryAbortedOnDrift",
            advancedAt: args.abortAt,
          });
          autoRollbackTriggered = true;
          rolledBackToDeploymentId = target;
        } catch (_error) {
          // Auto-rollback is best-effort. When it fails the abort still
          // stands and the operator can manually rollback using the
          // standard `rollbackGroup` flow.
          autoRollbackTriggered = false;
        }
      }
    }

    return Object.freeze({
      reason,
      materializationId: observation?.materializationId,
      observedAt: observation?.observedAt,
      observedDigest: observation?.observedDigest,
      providerId: observation?.providerId,
      autoRollbackTriggered,
      rolledBackToDeploymentId,
    });
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function resolveRollbackTarget(args: {
  readonly explicit: string | undefined;
  readonly previousStepResults: readonly RolloutStepResult[];
}): string | undefined {
  if (args.explicit) return args.explicit;
  for (let i = args.previousStepResults.length - 1; i >= 0; i--) {
    const candidate = args.previousStepResults[i];
    if (candidate.status === "applied" && candidate.deploymentId) {
      return candidate.deploymentId;
    }
  }
  return undefined;
}

function driftReasonToConditionReason(reason: string): string {
  switch (reason) {
    case "security-drift":
      return "ProviderSecurityDrift";
    case "config-drift":
      return "ProviderConfigDrift";
    case "status-drift":
      return "ProviderStatusDrift";
    case "ownership-drift":
      return "ProviderOwnershipDrift";
    case "cache-drift":
      return "ProviderCacheDrift";
    case "provider-object-missing":
      return "ProviderObjectMissing";
    default:
      return "ProviderDrift";
  }
}

function buildDriftAbortMessage(args: {
  readonly stepId: string;
  readonly reason: string;
  readonly materializationId?: string;
  readonly providerId?: string;
}): string {
  const parts = [
    `canary step '${args.stepId}' aborted on ${args.reason}`,
  ];
  if (args.providerId) parts.push(`provider=${args.providerId}`);
  if (args.materializationId) {
    parts.push(`materialization=${args.materializationId}`);
  }
  return parts.join("; ");
}

export function buildHttpWeightedAssignmentModel(input: {
  readonly manifest: PublicDeployManifest;
  readonly primaryAppReleaseId: string;
  readonly step?: RolloutRunStepInput;
}): HttpWeightedAssignmentModelDto {
  const canaryWeightPermille = input.step?.canaryWeightPermille ?? 0;
  assertPermille(canaryWeightPermille);
  const canaryAppReleaseId = input.step?.canaryAppReleaseId ??
    input.primaryAppReleaseId;
  const routes = routeEntries(input.manifest).filter((route) =>
    isHttpProtocol(route.protocol)
  );

  return Object.freeze({
    kind: "http_weighted",
    primaryAppReleaseId: input.primaryAppReleaseId,
    routes: Object.freeze(routes.map((route) =>
      Object.freeze({
        routeName: route.name,
        protocol: normalizeHttpProtocol(route.protocol),
        assignments: Object.freeze([
          Object.freeze({
            appReleaseId: input.primaryAppReleaseId,
            weightPermille: 1000 - canaryWeightPermille,
          }),
          Object.freeze({
            appReleaseId: canaryAppReleaseId,
            weightPermille: canaryWeightPermille,
          }),
        ]),
      })
    )),
    nonHttpDefaults: Object.freeze({
      events: Object.freeze({
        defaultAppReleaseId: input.primaryAppReleaseId,
        reason: "http-only-canary" as const,
      }),
      publications: Object.freeze({
        defaultAppReleaseId: input.primaryAppReleaseId,
        reason: "http-only-canary" as const,
      }),
    }),
  });
}

export function buildSideEffectPolicyReport(): SideEffectPolicyReport {
  return Object.freeze({
    status: "passed",
    summary:
      "non-HTTP side-effect surfaces are pinned to the primary release during HTTP canary rollout",
    checks: Object.freeze([
      Object.freeze({
        id: "non_http_side_effects",
        status: "passed" as const,
        message: "events and publications are pinned to primaryAppReleaseId",
        enforcementPoint: "rollout.assignment.nonHttpDefaults",
      }),
    ]),
  });
}

function withRolloutAssignment(
  manifest: PublicDeployManifest,
  assignmentModel: HttpWeightedAssignmentModelDto,
): PublicDeployManifest {
  return {
    ...structuredClone(manifest),
    overrides: {
      ...(structuredClone(manifest.overrides ?? {})),
      rollout: toJsonObject(assignmentModel),
    },
  };
}

function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new TypeError("rollout assignment model must be a JSON object");
  }
  return json;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null || typeof value === "string" ||
    typeof value === "number" || typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value !== "object") {
    throw new TypeError("rollout assignment model must be JSON-serializable");
  }
  const object: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) object[key] = toJsonValue(child);
  }
  return object;
}

function routeEntries(manifest: PublicDeployManifest): readonly {
  readonly name: string;
  readonly protocol?: string;
}[] {
  const routes = manifest.routes ?? {};
  if (Array.isArray(routes)) {
    return routes.map((route, index) => ({
      name: `route-${index}`,
      protocol: route.protocol,
    }));
  }
  return Object.entries(routes).map(([name, route]) => ({
    name,
    protocol: route.protocol,
  }));
}

function isHttpProtocol(protocol: string | undefined): boolean {
  const normalized = protocol?.toLowerCase() ?? "http";
  return normalized === "http" || normalized === "https";
}

function normalizeHttpProtocol(protocol: string | undefined): "http" | "https" {
  return protocol?.toLowerCase() === "https" ? "https" : "http";
}

function assertPermille(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new RangeError(
      "canaryWeightPermille must be an integer from 0 to 1000",
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
