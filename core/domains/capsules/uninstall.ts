/**
 * Two-stage uninstall vocabulary shared by the Capsule service, the scheduled
 * finalizer, and the hosts that configure the grace period.
 *
 * Stage one parks an applied Capsule in `uninstalled` for a grace period. Its
 * provider resources and data are untouched and the owner may cancel. Stage two
 * runs after `scheduledDestroyAt`: the finalizer attempts one data export,
 * records the outcome, and only then tears the resources down through the
 * ordinary destroy Plan/Apply pipeline.
 */

import type {
  Capsule,
  CapsuleUninstall,
  CapsuleUninstallRequester,
  CapsuleUninstallRestorableStatus,
} from "takosumi-contract/capsules";

/** OSS default grace period, in days, when no operator value is configured. */
export const DEFAULT_UNINSTALL_GRACE_DAYS = 7;

/** Upper bound for an operator-configured grace period, in days. */
export const MAX_UNINSTALL_GRACE_DAYS = 365;

/** Operator setting that overrides {@link DEFAULT_UNINSTALL_GRACE_DAYS}. */
export const UNINSTALL_GRACE_DAYS_ENV = "TAKOSUMI_UNINSTALL_GRACE_DAYS";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stable reasons returned by uninstall admission. */
export const CAPSULE_UNINSTALL_REASONS = {
  /** A short-lived OAuth access token cannot authorize a durable reservation. */
  oauthUnsupported: "capsule_uninstall_oauth_unsupported",
  /** Accounts cannot confirm the exact PAT remains valid at the deadline. */
  patDeadlineUnverified: "capsule_uninstall_pat_deadline_unverified",
  /** The Capsule is not in a status a scheduled uninstall can start from. */
  unavailable: "capsule_uninstall_unavailable",
  /** Nothing was ever applied; the abandonment path closes it instead. */
  notApplied: "capsule_uninstall_not_applied",
  /** A cancel arrived for a Capsule that is not uninstalled. */
  notUninstalled: "capsule_not_uninstalled",
  /** The finalizer already approved the teardown; it can no longer be undone. */
  destroyStarted: "capsule_uninstall_destroy_started",
  /** Plan/Apply admission refused because the Capsule is uninstalled. */
  uninstalled: "capsule_uninstalled",
} as const;

export type UninstallGraceSetting =
  | { readonly ok: true; readonly days: number; readonly configured: boolean }
  | { readonly ok: false; readonly days: number; readonly value: string };

/**
 * Reads `TAKOSUMI_UNINSTALL_GRACE_DAYS`: whole days from 0 to 365. Unset or
 * blank means the OSS default. Any other value is reported as invalid; the
 * caller logs it and uses the default rather than refusing to serve.
 */
export function uninstallGraceSettingFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): UninstallGraceSetting {
  const raw = env[UNINSTALL_GRACE_DAYS_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, days: DEFAULT_UNINSTALL_GRACE_DAYS, configured: false };
  }
  const value = raw.trim();
  if (!/^\d{1,3}$/u.test(value)) {
    return { ok: false, days: DEFAULT_UNINSTALL_GRACE_DAYS, value };
  }
  const days = Number(value);
  if (days > MAX_UNINSTALL_GRACE_DAYS) {
    return { ok: false, days: DEFAULT_UNINSTALL_GRACE_DAYS, value };
  }
  return { ok: true, days, configured: true };
}

export function uninstallGraceMs(days: number): number {
  if (
    !Number.isSafeInteger(days) ||
    days < 0 ||
    days > MAX_UNINSTALL_GRACE_DAYS
  ) {
    throw new RangeError(
      `uninstall grace must be 0-${MAX_UNINSTALL_GRACE_DAYS} whole days`,
    );
  }
  return days * DAY_MS;
}

export function isUninstallRestorableStatus(
  status: Capsule["status"],
): status is CapsuleUninstallRestorableStatus {
  return status === "active" || status === "stale" || status === "error";
}

/** First record of a new uninstall request, replacing any earlier one. */
export function scheduledUninstallRecord(input: {
  readonly id: string;
  readonly previous: CapsuleUninstall | undefined;
  readonly previousStatus: CapsuleUninstallRestorableStatus;
  readonly now: Date;
  readonly graceMs: number;
  readonly requester?: CapsuleUninstallRequester;
}): CapsuleUninstall {
  return {
    id: input.id,
    revision: (input.previous?.revision ?? 0) + 1,
    phase: "scheduled",
    requestedAt: input.now.toISOString(),
    ...(input.requester ? { requester: structuredClone(input.requester) } : {}),
    scheduledDestroyAt: new Date(
      input.now.getTime() + input.graceMs,
    ).toISOString(),
    previousStatus: input.previousStatus,
  };
}

/**
 * Next revision of the same request. `undefined` in `changes` cannot clear a
 * field: records only gain evidence until the next request replaces them.
 */
export function advancedUninstallRecord(
  current: CapsuleUninstall,
  changes: Partial<
    Omit<
      CapsuleUninstall,
      "id" | "revision" | "requestedAt" | "scheduledDestroyAt" | "previousStatus" | "requester"
    >
  >,
): CapsuleUninstall {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "requester") throw new TypeError("uninstall requester is immutable");
    if (value !== undefined) next[key] = value;
  }
  next.revision = current.revision + 1;
  return next as unknown as CapsuleUninstall;
}

/** The part of a Capsule's runtime safety projection uninstall admission reads. */
export type UninstallRuntimeSafety =
  | { readonly phase: "safe" | "unknown" | "terminating" | "retired" }
  | undefined;

/** Why uninstall admission refuses, in the commands' own words. */
export interface UninstallAdmissionRefusal {
  readonly reason: string;
  readonly message: string;
}

function teardownStarted(safety: UninstallRuntimeSafety): boolean {
  return safety?.phase === "terminating" || safety?.phase === "retired";
}

/**
 * State admission for scheduling a new uninstall, after the replay case (an
 * already `uninstalled` Capsule returns unchanged). Shared by the schedule
 * command and the read-only app view so both apply the same rules. The
 * runtime safety projection is read only when the earlier rules pass.
 */
export async function capsuleUninstallScheduleRefusal(
  capsule: Capsule,
  readRuntimeSafety: () => Promise<UninstallRuntimeSafety>,
): Promise<UninstallAdmissionRefusal | undefined> {
  if (capsule.status === "destroyed") {
    return {
      reason: CAPSULE_UNINSTALL_REASONS.unavailable,
      message: `capsule ${capsule.id} is already destroyed`,
    };
  }
  if (!isUninstallRestorableStatus(capsule.status)) {
    return {
      reason: CAPSULE_UNINSTALL_REASONS.unavailable,
      message: `capsule ${capsule.id} is ${capsule.status}; only an active, stale, or error Capsule can be uninstalled`,
    };
  }
  if (!capsule.currentStateVersionId && capsule.currentStateGeneration === 0) {
    return {
      reason: CAPSULE_UNINSTALL_REASONS.notApplied,
      message: `capsule ${capsule.id} was never applied; abandon it instead`,
    };
  }
  if (teardownStarted(await readRuntimeSafety())) {
    return {
      reason: CAPSULE_UNINSTALL_REASONS.destroyStarted,
      message: `capsule ${capsule.id} is already being deleted`,
    };
  }
  return undefined;
}

/**
 * State admission for cancelling an uninstall, after the replay case (a
 * cancel that already took effect). A queued or running teardown cannot be
 * undone; once the finalizer is `destroying`, cancel is possible only if it
 * blocked and nothing of the teardown reached the provider.
 */
export async function capsuleUninstallCancelRefusal(
  capsule: Capsule,
  readRuntimeSafety: () => Promise<UninstallRuntimeSafety>,
): Promise<UninstallAdmissionRefusal | undefined> {
  const record = capsule.uninstall;
  if (capsule.status !== "uninstalled" || record === undefined) {
    return {
      reason: CAPSULE_UNINSTALL_REASONS.notUninstalled,
      message: `capsule ${capsule.id} is not uninstalled`,
    };
  }
  const runtimeSafety = await readRuntimeSafety();
  const blockedBeforeDispatch = record.phase === "destroying" &&
    record.blockedReason !== undefined &&
    (runtimeSafety === undefined || runtimeSafety.phase === "safe");
  if (
    teardownStarted(runtimeSafety) ||
    (record.phase !== "scheduled" && !blockedBeforeDispatch)
  ) {
    return {
      reason: CAPSULE_UNINSTALL_REASONS.destroyStarted,
      message: `capsule ${capsule.id} teardown has already started and cannot be cancelled`,
    };
  }
  return undefined;
}
