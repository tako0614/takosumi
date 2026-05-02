/**
 * Audit retention policy — env-aware retention bands for regulated workloads.
 *
 * Regulated environments (PCI-DSS / HIPAA / SOX) require longer retention
 * than the default 1y window. Operators select a retention band per
 * environment so the audit GC job, the SqlObservabilitySink archive cutoff,
 * and the AuditReplicationSink targets all agree.
 *
 * Per compliance contract:
 *   - audit_events is **append-only**; rows are never deleted regardless of
 *     `deleteAfterArchive`. The hash chain remains intact across the entire
 *     history so independent verification by an auditor works at any point.
 *   - `deleteAfterArchive` only ever applies to **already-replicated**
 *     records, and even then defaults to `false`. Operators that opt in
 *     accept the trade-off that downstream replication is the canonical
 *     compliance store.
 */
export type AuditRetentionRegime =
  | "default"
  | "pci-dss"
  | "hipaa"
  | "sox"
  | "regulated";

export interface AuditRetentionPolicy {
  /** Days to retain audit events before flagging them as `archived = true`. */
  readonly defaultDays: number;
  /** Retention band applied when `regime` selects a regulated workload. */
  readonly regulatedDays: number;
  /**
   * If false (default), archived rows remain in audit_events forever. When
   * true, the GC job is allowed to delete already-replicated rows after
   * `archiveGracePeriodDays`. Implementations must consult
   * `replicationConfirmed` before deleting anything.
   */
  readonly deleteAfterArchive: boolean;
  /**
   * Grace window (days) between the archive cutoff and the optional
   * delete-after-replicate cutoff. Defaults to 30 days so operators can
   * detect downstream replication failures before the row leaves the
   * primary store.
   */
  readonly archiveGracePeriodDays: number;
}

export const DEFAULT_AUDIT_RETENTION_POLICY: AuditRetentionPolicy = Object
  .freeze({
    defaultDays: 365,
    regulatedDays: 2555, // 7 years (SOX-aligned)
    deleteAfterArchive: false,
    archiveGracePeriodDays: 30,
  });

export interface ResolveAuditRetentionInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly policy?: Partial<AuditRetentionPolicy>;
}

export interface ResolvedAuditRetention {
  readonly regime: AuditRetentionRegime;
  readonly retentionDays: number;
  readonly deleteAfterArchive: boolean;
  readonly archiveGracePeriodDays: number;
  readonly policy: AuditRetentionPolicy;
}

const REGULATED_REGIMES: ReadonlySet<AuditRetentionRegime> = new Set([
  "pci-dss",
  "hipaa",
  "sox",
  "regulated",
]);

/**
 * Resolve the active retention policy from an env snapshot. The lookup
 * order is:
 *   1. `TAKOS_AUDIT_RETENTION_REGIME` (default | pci-dss | hipaa | sox | regulated)
 *   2. `TAKOS_AUDIT_RETENTION_DAYS` overrides default/regulated band
 *   3. `TAKOS_AUDIT_DELETE_AFTER_ARCHIVE` opts into delete-after-replicate
 *   4. `TAKOS_AUDIT_ARCHIVE_GRACE_DAYS` overrides default 30d grace
 */
export function resolveAuditRetention(
  input: ResolveAuditRetentionInput = {},
): ResolvedAuditRetention {
  const policy: AuditRetentionPolicy = {
    ...DEFAULT_AUDIT_RETENTION_POLICY,
    ...input.policy,
  };
  const env = input.env ?? {};
  const regimeRaw = (env.TAKOS_AUDIT_RETENTION_REGIME ?? "default")
    .toLowerCase();
  const regime: AuditRetentionRegime =
    regimeRaw === "pci-dss" || regimeRaw === "hipaa" ||
      regimeRaw === "sox" || regimeRaw === "regulated"
      ? regimeRaw
      : "default";

  const overrideDays = parsePositiveInt(env.TAKOS_AUDIT_RETENTION_DAYS);
  const baseDays = REGULATED_REGIMES.has(regime)
    ? policy.regulatedDays
    : policy.defaultDays;
  const retentionDays = overrideDays ?? baseDays;

  const deleteAfterArchive = parseBool(env.TAKOS_AUDIT_DELETE_AFTER_ARCHIVE) ??
    policy.deleteAfterArchive;
  const graceDays = parsePositiveInt(env.TAKOS_AUDIT_ARCHIVE_GRACE_DAYS) ??
    policy.archiveGracePeriodDays;

  return {
    regime,
    retentionDays,
    deleteAfterArchive,
    archiveGracePeriodDays: graceDays,
    policy,
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return undefined;
}
