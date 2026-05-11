// Deploy orchestrator — Deployment-centric port.
//
// Composes Deployment resolution + apply with the auxiliary phase-boundary
// checks (package conformance, approvals, migration) that historically sat
// between Plan and Apply. The orchestrator no longer threads through a
// separate Plan/ApplyRun pair: a single `Deployment` carries the
// resolution + apply state, and provider operation progress is tracked via
// `Deployment.conditions[]` (see Phase 1 spec § 13).
//
// Runtime materialization, supply-chain artifact preparation, and group
// status projection that used to live inside this orchestrator have moved
// into separate Phase 3 streams (Agent C runtime, dedicated supply-chain
// service, status projector). This file now focuses solely on the
// resolve -> phase-boundary check -> apply sequencing.

import type { Deployment, GroupHead } from "takosumi-contract";
import type {
  DeployBlockerSource,
  DeploySourceRef,
  PublicDeployManifest,
} from "../../domains/deploy/types.ts";
import type { ApprovalGateDecision } from "../approvals/mod.ts";
import type { PackageConformanceResult } from "../conformance/mod.ts";
import type {
  PreparedArtifactPreApplyValidationInput,
  PreparedArtifactPreApplyValidationResult,
} from "../supply-chain/mod.ts";

export type DeploymentPhase = "resolve" | "apply";

export type DeploymentPhaseBoundaryCheckSource =
  | DeployBlockerSource
  | "read-set";

export interface DeploymentPhaseBlocker {
  readonly phase: DeploymentPhase;
  readonly source: DeploymentPhaseBoundaryCheckSource;
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly metadata?: Record<string, unknown>;
}

export type DeploymentPhaseBoundaryCheckResult =
  | void
  | DeploymentPhaseBlocker
  | readonly DeploymentPhaseBlocker[];

export interface DeploymentPhaseBoundaryCheck {
  readonly phase: DeploymentPhase;
  readonly source: DeploymentPhaseBoundaryCheckSource;
  readonly code?: string;
  readonly subject?: string;
  readonly check: () =>
    | DeploymentPhaseBoundaryCheckResult
    | Promise<DeploymentPhaseBoundaryCheckResult>;
}

export class DeploymentPhaseBlockedError extends Error {
  readonly blockers: readonly DeploymentPhaseBlocker[];

  constructor(blockers: readonly DeploymentPhaseBlocker[]) {
    super(
      `deployment phase blocked: ${
        blockers.map((blocker) => `${blocker.phase}/${blocker.code}`).join(", ")
      }`,
    );
    this.name = "DeploymentPhaseBlockedError";
    this.blockers = Object.freeze([...blockers]);
  }
}

export interface OrchestrateDeploymentInput {
  readonly spaceId: string;
  readonly manifest: PublicDeployManifest;
  readonly source?: DeploySourceRef;
  readonly groupId?: string;
  readonly deploymentId?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly phaseBlockers?: readonly DeploymentPhaseBlocker[];
  readonly packageConformance?:
    | PackageConformanceResult
    | readonly PackageConformanceResult[];
  readonly approvalDecision?: ApprovalGateDecision;
  readonly phaseBoundaryChecks?: readonly DeploymentPhaseBoundaryCheck[];
  readonly preparedArtifactExpectations?:
    readonly PreparedArtifactPreApplyExpectation[];
}

export interface DeploymentOrchestrationResult {
  readonly deployment: Deployment;
  readonly groupHead: GroupHead;
}

export type PreparedArtifactPreApplyExpectation =
  & Omit<PreparedArtifactPreApplyValidationInput, "deploymentId" | "now">
  & {
    readonly deploymentId?: string;
    readonly now?: PreparedArtifactPreApplyValidationInput["now"];
  };

/**
 * Subset of the deploy-domain `DeploymentService` used by the orchestrator.
 * Kept as a structural interface so the orchestrator stays decoupled from the
 * concrete `DeploymentService` class while Phase 3 Agent A finalises it.
 */
export interface OrchestratorDeploymentClient {
  resolveDeployment(input: OrchestratorResolveInput): Promise<Deployment>;
  applyDeployment(deploymentId: string): Promise<DeploymentOrchestrationResult>;
}

export interface OrchestratorResolveInput {
  readonly spaceId: string;
  readonly groupId?: string;
  readonly manifest: PublicDeployManifest;
  readonly source?: DeploySourceRef;
  readonly mode?: "resolve" | "apply";
  readonly deploymentId?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
}

export interface DeploymentOrchestratorOptions {
  readonly deploymentService: OrchestratorDeploymentClient;
  readonly supplyChain?: PreparedArtifactPreApplyValidator;
  readonly clock?: () => Date;
}

export interface PreparedArtifactPreApplyValidator {
  requirePreparedArtifactForApply(
    input: PreparedArtifactPreApplyValidationInput,
  ): Promise<PreparedArtifactPreApplyValidationResult>;
}

/**
 * Sequences Deployment resolve + phase-boundary checks + apply in a single
 * call. Phase boundaries are evaluated against the resolved Deployment — if
 * any blocker is found, the apply step is skipped and a structured
 * `DeploymentPhaseBlockedError` is raised so callers can surface the
 * underlying conformance / approval / migration reason.
 */
export class DeploymentOrchestrator {
  readonly #deployments: OrchestratorDeploymentClient;
  readonly #supplyChain?: PreparedArtifactPreApplyValidator;
  readonly #clock: () => Date;

  constructor(options: DeploymentOrchestratorOptions) {
    this.#deployments = options.deploymentService;
    this.#supplyChain = options.supplyChain;
    this.#clock = options.clock ?? (() => new Date());
  }

  async orchestrate(
    input: OrchestrateDeploymentInput,
  ): Promise<DeploymentOrchestrationResult> {
    // Pre-resolve checks — these fail before any record is written.
    const preResolveBlockers = await collectPhaseBlockers(input, "resolve");
    if (preResolveBlockers.length > 0) {
      throw new DeploymentPhaseBlockedError(preResolveBlockers);
    }

    const resolved = await this.#deployments.resolveDeployment({
      spaceId: input.spaceId,
      groupId: input.groupId,
      manifest: input.manifest,
      source: input.source,
      mode: "resolve",
      deploymentId: input.deploymentId,
      createdAt: input.createdAt ?? this.#now(),
      createdBy: input.createdBy,
    });

    const preApplyBlockers = [
      ...await this.#collectPreparedArtifactBlockers(input, resolved.id),
      ...await collectPhaseBlockers(input, "apply"),
    ];
    if (preApplyBlockers.length > 0) {
      throw new DeploymentPhaseBlockedError(preApplyBlockers);
    }

    return await this.#deployments.applyDeployment(resolved.id);
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  async #collectPreparedArtifactBlockers(
    input: OrchestrateDeploymentInput,
    deploymentId: string,
  ): Promise<readonly DeploymentPhaseBlocker[]> {
    const expectations = input.preparedArtifactExpectations ?? [];
    if (expectations.length === 0) return [];
    if (!this.#supplyChain) {
      return expectations.map((expectation) =>
        preparedArtifactBlocker(
          "PreparedArtifact pre-Apply validator is not configured",
          expectation,
          {
            deploymentId,
            artifactDigest: expectation.artifactDigest,
            rejectionReasons: ["validator-missing"],
          },
        )
      );
    }

    const blockers: DeploymentPhaseBlocker[] = [];
    for (const expectation of expectations) {
      try {
        await this.#supplyChain.requirePreparedArtifactForApply({
          ...expectation,
          deploymentId,
          now: expectation.now ?? this.#now(),
        });
      } catch (error) {
        blockers.push(
          preparedArtifactBlocker(
            error instanceof Error ? error.message : String(error),
            expectation,
            preparedArtifactErrorMetadata(error, expectation, deploymentId),
          ),
        );
      }
    }
    return blockers;
  }
}

async function collectPhaseBlockers(
  input: OrchestrateDeploymentInput,
  phase: DeploymentPhase,
): Promise<readonly DeploymentPhaseBlocker[]> {
  const blockers: DeploymentPhaseBlocker[] = [];

  for (const blocker of input.phaseBlockers ?? []) {
    if (blocker.phase === phase) blockers.push(blocker);
  }

  if (phase === "resolve") {
    const conformanceResults = input.packageConformance
      ? Array.isArray(input.packageConformance)
        ? input.packageConformance
        : [input.packageConformance]
      : [];
    for (const result of conformanceResults) {
      blockers.push(...blockersFromConformanceResult(result));
    }
  }

  if (phase === "apply") {
    if (input.approvalDecision && !input.approvalDecision.allowed) {
      blockers.push(blockerFromApprovalDecision(input.approvalDecision));
    }
  }

  for (const check of input.phaseBoundaryChecks ?? []) {
    if (check.phase !== phase) continue;
    try {
      blockers.push(...toBlockers(await check.check()));
    } catch (error) {
      blockers.push(blockerFromThrownError(error, check));
    }
  }

  return blockers;
}

function blockersFromConformanceResult(
  result: PackageConformanceResult,
): readonly DeploymentPhaseBlocker[] {
  if (result.accepted) return [];
  return result.issues
    .filter((issue) =>
      issue.severity === "blocked" || issue.acceptanceSeverity === "blocker"
    )
    .map((issue) => ({
      phase: "resolve" as const,
      source: conformanceBlockerSource(issue.code),
      code: issue.code,
      message: issue.message,
      subject: issue.packageRef ?? result.packageRef,
      metadata: {
        packageKind: result.packageKind,
        trustStatus: result.trustStatus,
        conformanceTier: result.conformanceTier,
        acceptanceSeverity: issue.acceptanceSeverity,
      },
    }));
}

function conformanceBlockerSource(
  code: string,
): DeploymentPhaseBoundaryCheckSource {
  if (code.startsWith("trust-")) return "registry-trust";
  if (
    code.startsWith("capability-") ||
    code.startsWith("provider-") ||
    code.startsWith("required-feature-") ||
    code.startsWith("support-report-")
  ) {
    return "provider-support";
  }
  return "conformance";
}

function blockerFromApprovalDecision(
  decision: ApprovalGateDecision,
): DeploymentPhaseBlocker {
  return {
    phase: "apply",
    source: "approval",
    code: decision.reason.replaceAll(" ", "-"),
    message: `Approval gate denied ${decision.operation}: ${decision.reason}`,
    subject: decision.operation,
    metadata: {
      subjectDigest: decision.subjectDigest,
      missingRoles: decision.missingRoles ? [...decision.missingRoles] : [],
      ...(decision.approval ? { approvalId: decision.approval.id } : {}),
    },
  };
}

function toBlockers(
  result: DeploymentPhaseBoundaryCheckResult,
): readonly DeploymentPhaseBlocker[] {
  if (!result) return [];
  return Array.isArray(result)
    ? result as readonly DeploymentPhaseBlocker[]
    : [result as DeploymentPhaseBlocker];
}

function blockerFromThrownError(
  error: unknown,
  check: DeploymentPhaseBoundaryCheck,
): DeploymentPhaseBlocker {
  const message = error instanceof Error ? error.message : String(error);
  return {
    phase: check.phase,
    source: check.source,
    code: check.code ?? codeFromErrorMessage(message),
    message,
    subject: check.subject,
  };
}

function codeFromErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("migration") && lower.includes("checksum")) {
    return "migration-checksum-changed";
  }
  return lower.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "") ||
    "phase-boundary-check-failed";
}

function preparedArtifactBlocker(
  message: string,
  expectation: PreparedArtifactPreApplyExpectation,
  metadata: Record<string, unknown>,
): DeploymentPhaseBlocker {
  return {
    phase: "apply",
    source: "read-set",
    code: "prepared-artifact-pre-apply-validation-failed",
    message,
    subject: expectation.artifactDigest,
    metadata,
  };
}

function preparedArtifactErrorMetadata(
  error: unknown,
  expectation: PreparedArtifactPreApplyExpectation,
  deploymentId: string,
): Record<string, unknown> {
  const details = errorDetails(error);
  return {
    deploymentId,
    artifactDigest: expectation.artifactDigest,
    ...details,
    rejectionReasons: stringArray(details.rejectionReasons),
  };
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return {};
  }
  const details = (error as { readonly details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
