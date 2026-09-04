/**
 * Run + RunGroup contract (`runs` / `run_groups`).
 *
 * A Run is ONE execution ledger row. Most rows execute against an Capsule;
 * `source_sync` rows are Source-scoped before any Capsule exists.
 * Destroy is 2-phase (`destroy_plan` -> approval -> `destroy_apply`,
 * invariant 16). Apply-kind runs only ever execute a saved plan after
 * verifying plan digest / source snapshot / dependency snapshot / state
 * generation (invariants 6-10).
 *
 * A RunGroup orders multiple Runs across the dependency DAG (e.g. a Workspace
 * update after stale propagation); `graphJson` records the planned order.
 */

import type {
  ProviderResolution,
  PublicProviderResolution,
} from "./provider-resolution.ts";
import type { PlanResourceScope } from "./plan-scope.ts";
import type { JsonValue } from "./types.ts";
import type { CapsuleProviderRequirement } from "./capsules.ts";

export type RunType =
  | "source_sync"
  | "compatibility_check"
  /** Immutable artifact staging; it does not mutate execution state. */
  | "artifact"
  | "plan"
  | "apply"
  | "destroy_plan"
  | "destroy_apply"
  | "drift_check"
  | "backup"
  // `restore` is a destructive Backup-backed state restore. It is created in
  // `waiting_approval`; approval dispatches it to write a new StateVersion
  // generation and mark downstream consumers stale. Service-data restore is
  // opt-in and succeeds only when the runner acknowledges the service-data
  // artifact restored.
  | "restore";

/**
 * Run terminal status covers every phase pinned by the reviewed Plan. For an
 * apply with required post-apply lifecycle actions, `succeeded` means both the
 * provider apply and every action terminal-succeeded. `failed` may therefore
 * coexist with a retained provider-applied StateVersion/Output; audit/errorCode
 * distinguish that case from a provider execution failure.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * Where a Run sits in its own lifecycle, as one classification.
 *
 * WHY this exists. This partition was written three times, by negation, over
 * two different unions: `NON_TERMINAL_RUN_STATUSES` listed the in-flight
 * statuses of `RunStatus`, the Run-owner Durable Object listed them again for
 * dispatch, and its `isTerminalOwnerStatus` derived the settled half by
 * excluding two names from a separately declared owner union. Adding a status
 * to `RunStatus` therefore made it silently settled everywhere, with no
 * compile error anywhere — a run nothing would ever drive, and a terminal
 * transition allowed to fire from a state that had not finished.
 *
 * `Record<RunStatus, RunProgressPhase>` is exhaustive by construction: a new
 * status does not compile until it is classified here, and every predicate
 * derives from this one map instead of restating it.
 */
export type RunProgressPhase = "in-flight" | "settled";

export const RUN_PROGRESS_PHASE = {
  queued: "in-flight",
  running: "in-flight",
  // A plan parked for approval is not executing: the run engine has finished
  // with it and the approval is a separate act, so it is settled for every
  // question this classification answers. The internal run model does not
  // write this status at all — a plan awaiting approval stays `succeeded` —
  // and its later cancel is handled by the `succeeded`-from cancel CAS.
  waiting_approval: "settled",
  succeeded: "settled",
  failed: "settled",
  cancelled: "settled",
  expired: "settled",
} as const satisfies { readonly [S in RunStatus]: RunProgressPhase };

/**
 * The two halves of the partition, as types. Derived from the map, so a status
 * moved between phases moves in every narrowing at once.
 */
export type InFlightRunStatus = {
  [S in RunStatus]: (typeof RUN_PROGRESS_PHASE)[S] extends "in-flight"
    ? S
    : never;
}[RunStatus];
export type SettledRunStatus = Exclude<RunStatus, InFlightRunStatus>;

/** The in-flight statuses, derived. No call site writes this array. */
export const IN_FLIGHT_RUN_STATUSES: readonly InFlightRunStatus[] = Object.freeze(
  (Object.keys(RUN_PROGRESS_PHASE) as RunStatus[]).filter(
    (status): status is InFlightRunStatus =>
      RUN_PROGRESS_PHASE[status] === "in-flight",
  ),
);

export function runProgressPhase(status: RunStatus): RunProgressPhase {
  return RUN_PROGRESS_PHASE[status];
}

/** Whether a run is still worth driving: dispatching, polling, terminalizing. */
export function runIsInFlight(
  status: RunStatus | undefined,
): status is InFlightRunStatus {
  return status !== undefined && RUN_PROGRESS_PHASE[status] === "in-flight";
}

export type RunSubject =
  | { readonly kind: "capsule"; readonly id: string }
  | { readonly kind: "resource"; readonly id: string }
  | { readonly kind: "source"; readonly id: string };

/** Legacy direct-adapter operation marker retained for historical row reads. */
export type ResourceOperation =
  | "artifact"
  | "preview"
  | "apply"
  | "import"
  | "observe"
  | "refresh"
  | "form_transition"
  | "delete";

/** Default page size for a Workspace Run listing when no limit is given. */
export const RUN_LIST_DEFAULT_LIMIT = 100;
/** Maximum page size accepted on the Workspace Run listing route. */
export const RUN_LIST_MAX_LIMIT = 500;

export type RunPolicyStatus = "pass" | "warn" | "deny";

export interface RunChangeSummary {
  readonly add?: number;
  readonly change?: number;
  readonly destroy?: number;
}

/**
 * Public, value-free resource projection from `tofu show -json tfplan`.
 * It intentionally carries only address/type/action tokens and sanitized
 * provider scope metadata. Raw before/after values and provider secrets never
 * appear on Run records.
 */
export interface RunPlanResource {
  readonly address: string;
  readonly type: string;
  readonly actions: readonly string[];
  readonly scope?: PlanResourceScope;
}

export interface RunApplyExpectedGuard {
  readonly planId: string;
  readonly capsuleId?: string;
  readonly currentStateVersionId?: string | null;
  readonly runnerId: string;
  readonly sourceDigest: string;
  readonly variablesDigest: string;
  readonly policyDecisionDigest: string;
  readonly planDigest: string;
  readonly planArtifactDigest: string;
  readonly sourceCommit?: string;
  readonly providerLockDigest?: string;
  readonly resolvedProviderBindingsDigest?: string;
}

/** Non-secret service-data restore evidence recorded on restore Runs. */
export interface RunServiceDataRestoreResult {
  readonly status: "restored";
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly restoredCount?: number;
}

/** Immutable artifact identity carried by a terminal mutation receipt. */
export interface RunExecutionArtifactIdentity {
  /** Content-addressed digest of the artifact; labels and mutable refs are not accepted. */
  readonly digest: `sha256:${string}`;
  /** A literal assertion that the digest names an immutable artifact. */
  readonly immutable: true;
}

/** Provider package identity observed by the runner, sorted by source then digest. */
export interface RunExecutionProviderArtifact {
  readonly source: string;
  readonly digest: `sha256:${string}`;
  readonly attested: true;
}

/** Controller, runner, and executor authority pinned for one mutation. */
export interface RunExecutionAuthority {
  readonly controllerArtifact: RunExecutionArtifactIdentity;
  readonly runnerArtifact: RunExecutionArtifactIdentity;
  readonly runnerProfileId: string;
  readonly executorId: string;
  readonly executorArtifact: RunExecutionArtifactIdentity;
  readonly providerArtifacts: readonly RunExecutionProviderArtifact[];
}

/** State/output coordinate committed by a mutation. */
export type RunExecutionCommit =
  | {
      readonly stateVersionId: string;
      readonly outputId: string;
    }
  | {
      /** A provider failure retained state but did not produce an Output. */
      readonly stateVersionId: string;
    }
  | {
      readonly stateVersionId?: string;
      readonly destroyed: true;
    };

/** Durable acknowledgement fence for one runner operation. */
export interface RunExecutionReceipt {
  /** Must equal the ApplyRun id. */
  readonly operationId: string;
  readonly version: number;
  readonly fence: number;
}

/**
 * Closed, value-free evidence for one OpenTofu apply/destroy operation.
 * Raw state, output values, credentials, diagnostics, and URLs deliberately do
 * not fit this shape.
 */
export interface RunExecutionEvidence {
  readonly format: typeof RUN_EXECUTION_EVIDENCE_CONTRACT;
  readonly runId: string;
  readonly planRunId: string;
  readonly action: "apply" | "destroy";
  readonly outcome: "committed" | "provider_failed_state_persisted";
  readonly authority: RunExecutionAuthority;
  readonly plan: {
    readonly digest: `sha256:${string}`;
    readonly artifactDigest: `sha256:${string}`;
  };
  readonly commit: RunExecutionCommit;
  readonly receipt: RunExecutionReceipt;
  readonly committedAt: string;
}

export const RUN_EXECUTION_EVIDENCE_CONTRACT =
  "takosumi.run-execution-evidence/v1" as const;

/** Runtime validation at the Core/runner boundary. Returns the same object. */
export function assertRunExecutionEvidence(
  value: unknown,
): RunExecutionEvidence {
  const record = exactEvidenceRecord(value, [
    "format",
    "runId",
    "planRunId",
    "action",
    "outcome",
    "authority",
    "plan",
    "commit",
    "receipt",
    "committedAt",
  ]);
  if (record.format !== RUN_EXECUTION_EVIDENCE_CONTRACT) {
    throw new TypeError("run execution evidence format is invalid");
  }
  const runId = evidenceToken(record.runId, "runId");
  const planRunId = evidenceToken(record.planRunId, "planRunId");
  if (record.action !== "apply" && record.action !== "destroy") {
    throw new TypeError("run execution evidence action is invalid");
  }
  if (
    record.outcome !== "committed" &&
    record.outcome !== "provider_failed_state_persisted"
  ) {
    throw new TypeError("run execution evidence outcome is invalid");
  }
  const authority = assertRunExecutionAuthority(record.authority);
  const planRecord = exactEvidenceRecord(record.plan, [
    "digest",
    "artifactDigest",
  ]);
  const plan = {
    digest: evidenceDigest(planRecord.digest, "plan.digest"),
    artifactDigest: evidenceDigest(
      planRecord.artifactDigest,
      "plan.artifactDigest",
    ),
  } as const;
  const commit = assertRunExecutionCommit(record.commit);
  const receiptRecord = exactEvidenceRecord(record.receipt, [
    "operationId",
    "version",
    "fence",
  ]);
  const receipt = {
    operationId: evidenceToken(receiptRecord.operationId, "receipt.operationId"),
    version: evidencePositiveInteger(receiptRecord.version, "receipt.version"),
    fence: evidencePositiveInteger(receiptRecord.fence, "receipt.fence"),
  } as const;
  const committedAt = evidenceTimestamp(record.committedAt);
  return {
    format: RUN_EXECUTION_EVIDENCE_CONTRACT,
    runId,
    planRunId,
    action: record.action,
    outcome: record.outcome,
    authority,
    plan,
    commit,
    receipt,
    committedAt,
  };
}

function assertRunExecutionAuthority(value: unknown): RunExecutionAuthority {
  const record = exactEvidenceRecord(value, [
    "controllerArtifact",
    "runnerArtifact",
    "runnerProfileId",
    "executorId",
    "executorArtifact",
    "providerArtifacts",
  ]);
  const providerArtifacts = record.providerArtifacts;
  if (!Array.isArray(providerArtifacts)) {
    throw new TypeError("run execution provider artifacts are invalid");
  }
  const parsed = providerArtifacts.map((entry, index) => {
    const provider = exactEvidenceRecord(entry, ["source", "digest", "attested"]);
    if (provider.attested !== true) {
      throw new TypeError(`provider artifact ${index} is not attested`);
    }
    return {
      source: evidenceToken(provider.source, `providerArtifacts[${index}].source`),
      digest: evidenceDigest(
        provider.digest,
        `providerArtifacts[${index}].digest`,
      ),
      attested: true as const,
    };
  });
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1]!;
    const current = parsed[index]!;
    if (
      previous.source > current.source ||
      (previous.source === current.source && previous.digest > current.digest)
    ) {
      throw new TypeError("run execution provider artifacts must be sorted");
    }
  }
  return {
    controllerArtifact: assertRunExecutionArtifact(
      record.controllerArtifact,
      "authority.controllerArtifact",
    ),
    runnerArtifact: assertRunExecutionArtifact(
      record.runnerArtifact,
      "authority.runnerArtifact",
    ),
    runnerProfileId: evidenceToken(
      record.runnerProfileId,
      "authority.runnerProfileId",
    ),
    executorId: evidenceToken(record.executorId, "authority.executorId"),
    executorArtifact: assertRunExecutionArtifact(
      record.executorArtifact,
      "authority.executorArtifact",
    ),
    providerArtifacts: parsed,
  };
}

function assertRunExecutionArtifact(
  value: unknown,
  label: string,
): RunExecutionArtifactIdentity {
  const record = exactEvidenceRecord(value, ["digest", "immutable"]);
  if (record.immutable !== true) {
    throw new TypeError(`${label} must be immutable`);
  }
  return {
    digest: evidenceDigest(record.digest, `${label}.digest`),
    immutable: true,
  };
}

function assertRunExecutionCommit(value: unknown): RunExecutionCommit {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
  if (!record) throw new TypeError("run execution commit is invalid");
  if (record.destroyed === true) {
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "destroyed" && keys !== "destroyed,stateVersionId") {
      throw new TypeError("destroy commit keys are invalid");
    }
    if (
      record.stateVersionId !== undefined &&
      typeof record.stateVersionId !== "string"
    ) {
      throw new TypeError("destroy commit stateVersionId is invalid");
    }
    return {
      destroyed: true,
      ...(record.stateVersionId !== undefined
        ? { stateVersionId: evidenceToken(record.stateVersionId, "commit.stateVersionId") }
        : {}),
    };
  }
  const keys = Object.keys(record).sort().join(",");
  if (keys === "stateVersionId") {
    return {
      stateVersionId: evidenceToken(record.stateVersionId, "commit.stateVersionId"),
    };
  }
  const exact = exactEvidenceRecord(record, ["stateVersionId", "outputId"]);
  return {
    stateVersionId: evidenceToken(exact.stateVersionId, "commit.stateVersionId"),
    outputId: evidenceToken(exact.outputId, "commit.outputId"),
  };
}

function exactEvidenceRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("run execution evidence object is invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new TypeError("run execution evidence object keys are invalid");
  }
  return record;
}

function evidenceToken(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function evidenceDigest(value: unknown, label: string): `sha256:${string}` {
  if (
    typeof value !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return value as `sha256:${string}`;
}

function evidencePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function evidenceTimestamp(value: unknown): string {
  const timestamp = evidenceToken(value, "committedAt");
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new TypeError("committedAt must be a canonical UTC timestamp");
  }
  return timestamp;
}

export interface Run {
  readonly id: string;
  readonly runGroupId?: string;
  readonly workspaceId: string;
  /** Exact PlanRun id consumed by an ApplyRun, when this is an apply row. */
  readonly planRunId?: string;
  /** Present for Source-scoped rows such as `source_sync`. */
  readonly sourceId?: string;
  /** Source-scoped sync address and resolved immutable commit, when present. */
  readonly ref?: string;
  readonly resolvedCommit?: string;
  /** Explicit execution subject for non-Capsule and new generic run flows. */
  readonly subject?: RunSubject;
  /** Historical direct-adapter operation marker; no new routes create it. */
  readonly resourceOperation?: ResourceOperation;
  /** Required for Capsule-bound rows; absent for Source-scoped rows. */
  readonly capsuleId?: string;
  readonly environment?: string;
  readonly type: RunType;
  readonly status: RunStatus;
  readonly sourceSnapshotId?: string;
  readonly dependencySnapshotId?: string;
  readonly compatibilityReportId?: string;
  readonly baseStateGeneration?: number;
  readonly planDigest?: string;
  readonly planArtifactRef?: string;
  /**
   * Non-secret guard the client must echo when applying a reviewed plan.
   * Present only on plan/destroy_plan rows that have a saved immutable plan.
   */
  readonly applyExpected?: RunApplyExpectedGuard;
  /** Non-secret OpenTofu plan counts. Raw resource values stay in artifacts. */
  readonly summary?: RunChangeSummary;
  /** Non-secret resource/action review lines. No raw resource values. */
  readonly planResources?: readonly RunPlanResource[];
  readonly policyStatus?: RunPolicyStatus;
  /** Exact non-secret provider identities pinned by current Plan creation. */
  readonly requiredProviderRequirements?: readonly CapsuleProviderRequirement[];
  readonly providerResolutions?: readonly ProviderResolution[];
  readonly runEnvironmentEvidenceDigest?: string;
  readonly redactionProfileId?: string;
  /** Value-free durable runner receipt for newly terminal mutations. */
  readonly executionEvidence?: RunExecutionEvidence;
  /** True when the reviewed plan carried a human approval/destructive gate. */
  readonly requiresApproval?: boolean;
  readonly backupId?: string;
  readonly restoreStateGeneration?: number;
  readonly restoreServiceData?: boolean;
  readonly restoredStateVersionId?: string;
  readonly restoredFromStateVersionId?: string;
  readonly restoredServiceData?: RunServiceDataRestoreResult;
  readonly errorCode?: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  /**
   * Internal liveness marker refreshed while an executable Run is owned by a
   * runner. Normal public projections do not need to render it, but backup /
   * restore rows share the single runs ledger and use the same lease fencing as
   * plan/apply/source_sync.
   */
  readonly heartbeatAt?: number;
  readonly finishedAt?: string;
}

export type PublicRun = Omit<Run, "providerResolutions"> & {
  readonly providerResolutions?: readonly PublicProviderResolution[];
};

/** Body of `GET /api/v1/workspaces/:workspaceId/runs`. */
export interface ListRunsResponse {
  readonly runs: readonly PublicRun[];
}

export interface RunDiagnostic {
  readonly severity: "info" | "warning" | "error";
  /** Stable machine-readable classification; UI must not parse `message`. */
  readonly code?: string;
  readonly message: string;
  readonly detail?: string;
}

export interface RunAuditEvent {
  readonly id: string;
  readonly type: string;
  readonly at: number;
  readonly actor?: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, JsonValue>>;
}

/**
 * Body of `GET /internal/v1/runs/:runId/logs`. MVP: the run record's
 * structured diagnostics + the run-level audit trail (the per-run policy /
 * lease / dispatch trace). Logs pass through redaction (invariant 15); no
 * credential material or sensitive output values appear here.
 */
export interface RunLogsResponse {
  readonly diagnostics: readonly RunDiagnostic[];
  readonly auditEvents: readonly RunAuditEvent[];
}

/**
 * Body of `GET /internal/v1/runs/:runId/events`. MVP: the run-level audit
 * trail only.
 */
export interface RunEventsResponse {
  readonly auditEvents: readonly RunAuditEvent[];
}

/**
 * Public, non-secret showback projection for a plan Run. Core owns the stable
 * estimate/mode/decision fields. A host may attach an opaque, non-secret
 * extension object, but core and the OSS dashboard never infer commercial
 * balance, reservation, plan, or payment semantics from it.
 */
export interface RunCostInfo {
  readonly runId: string;
  readonly billingMode: "disabled" | "showback";
  readonly estimatedUsdMicros: number;
  readonly ratingStatus: "not_applicable" | "rated" | "unrated";
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly extension?: Readonly<Record<string, JsonValue>>;
}

/** Body of `GET /internal/v1/runs/:runId/cost`. */
export interface RunCostResponse {
  readonly cost: RunCostInfo;
}

export type RunGroupType =
  | "workspace_update"
  | "workspace_drift_check"
  | "capsule_install"
  | "capsule_update"
  | "capsule_destroy";

export type RunGroupStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunGroup {
  readonly id: string;
  readonly workspaceId: string;
  readonly type: RunGroupType;
  readonly status: RunGroupStatus;
  /** JSON-encoded DAG-ordered plan of member runs. */
  readonly graphJson: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

/** Internal deploy-control seam response: RunGroup plus member Runs. */
export interface RunGroupWithRuns {
  readonly runGroup: RunGroup;
  /** Member Runs, in the row's recorded topological order. */
  readonly runs: readonly Run[];
}

/** Public control surface response: RunGroup plus public-safe member Runs. */
export interface RunGroupResponse {
  readonly runGroup: RunGroup;
  /** Member Runs, in the row's recorded topological order. */
  readonly runs: readonly PublicRun[];
}

/**
 * Non-public artifact ledger row (`artifacts`).
 *
 * Artifact bytes live behind a host storage adapter. The control ledger stores
 * only an opaque reference plus integrity metadata.
 */
export interface ArtifactRecord {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}
