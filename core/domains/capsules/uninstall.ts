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
}): CapsuleUninstall {
  return {
    id: input.id,
    revision: (input.previous?.revision ?? 0) + 1,
    phase: "scheduled",
    requestedAt: input.now.toISOString(),
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
      "id" | "revision" | "requestedAt" | "scheduledDestroyAt" | "previousStatus"
    >
  >,
): CapsuleUninstall {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) next[key] = value;
  }
  next.revision = current.revision + 1;
  return next as unknown as CapsuleUninstall;
}

/** Whether the owner may still cancel this Capsule's uninstall. */
export function capsuleUninstallCancellable(capsule: Capsule): boolean {
  return (
    capsule.status === "uninstalled" &&
    capsule.uninstall?.phase === "scheduled"
  );
}
