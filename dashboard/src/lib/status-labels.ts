/**
 * status-labels — non-developer Japanese label maps for the dashboard.
 *
 * Single source of truth for turning internal status strings into the
 * user-facing「アプリ」vocabulary. Phase 0 of the PaaS-kernel repositioning:
 * the dashboard speaks App / Environment / Connection / 変更を確認 / 公開, while
 * the internal concepts (PlanRun / ApplyRun, installation status enum) keep
 * their code identifiers. Views import these maps instead of inlining raw
 * status strings so later phases (Connections / Environments screens) reuse
 * the exact same wording.
 *
 * Code identifiers and API field names are intentionally unchanged — only the
 * primary, user-visible label is localized. Run ids and other expert details
 * stay visible in detail/expert sections.
 */

/** Fallback for any status string we have not mapped yet. */
const UNKNOWN_LABEL = "不明";

/**
 * Installation ("App") lifecycle status. Canonical enum:
 * `installing` / `ready` / `failed` / `suspended` / `exported`.
 */
const INSTALLATION_STATUS_LABELS: Record<string, string> = {
  ready: "稼働中",
  installing: "セットアップ中",
  failed: "失敗",
  suspended: "停止中",
  exported: "エクスポート済み",
};

export function installationStatusLabel(status: string | undefined): string {
  if (!status) return UNKNOWN_LABEL;
  return INSTALLATION_STATUS_LABELS[status] ?? status;
}

/**
 * PlanRun status → 変更の確認 vocabulary. Plan is "変更を確認" in the primary
 * flow; while it runs it is「変更を確認中」, once done「変更の確認が完了」.
 * `queued` / `blocked` / `failed` are shared with apply runs.
 */
const PLAN_RUN_STATUS_LABELS: Record<string, string> = {
  queued: "待機中",
  pending: "待機中",
  running: "変更を確認中",
  in_progress: "変更を確認中",
  planning: "変更を確認中",
  reviewing: "変更を確認中",
  succeeded: "変更の確認が完了",
  completed: "変更の確認が完了",
  planned: "変更の確認が完了",
  ready: "変更の確認が完了",
  failed: "失敗",
  errored: "失敗",
  blocked: "ブロック中",
  denied: "ブロック中",
};

export function planRunStatusLabel(status: string | undefined): string {
  if (!status) return UNKNOWN_LABEL;
  return PLAN_RUN_STATUS_LABELS[status] ?? status;
}

/**
 * ApplyRun status →「反映」/「公開」vocabulary. Apply is "公開"/"反映" in the
 * primary flow; while it runs it is「反映中」, once done「公開済み」.
 * `queued` / `blocked` / `failed` are shared with plan runs.
 */
const APPLY_RUN_STATUS_LABELS: Record<string, string> = {
  queued: "待機中",
  pending: "待機中",
  running: "反映中",
  in_progress: "反映中",
  applying: "反映中",
  succeeded: "公開済み",
  completed: "公開済み",
  applied: "公開済み",
  failed: "失敗",
  errored: "失敗",
  blocked: "ブロック中",
  denied: "ブロック中",
};

export function applyRunStatusLabel(status: string | undefined): string {
  if (!status) return UNKNOWN_LABEL;
  return APPLY_RUN_STATUS_LABELS[status] ?? status;
}

/**
 * Workload service status. Canonical enum:
 * `ready` / `not_configured` / `unavailable`.
 */
const SERVICE_STATUS_LABELS: Record<string, string> = {
  ready: "利用可能",
  not_configured: "未設定",
  unavailable: "利用不可",
};

export function serviceStatusLabel(status: string | undefined): string {
  if (!status) return UNKNOWN_LABEL;
  return SERVICE_STATUS_LABELS[status] ?? status;
}

/**
 * Connection status. Canonical enum: `pending` / `verified` / `revoked`.
 * A Connection registers provider credentials for a Space; `verified` means the
 * stored credential passed a provider check (e.g. Cloudflare token verify).
 */
const CONNECTION_STATUS_LABELS: Record<string, string> = {
  pending: "未確認",
  verified: "確認済み",
  revoked: "無効化",
};

export function connectionStatusLabel(status: string | undefined): string {
  if (!status) return UNKNOWN_LABEL;
  return CONNECTION_STATUS_LABELS[status] ?? status;
}

/**
 * Export operation status. Canonical enum:
 * `preparing` / `exported` / `failed`.
 */
const EXPORT_STATUS_LABELS: Record<string, string> = {
  preparing: "準備中",
  exported: "エクスポート完了",
  failed: "失敗",
};

export function exportStatusLabel(status: string | undefined): string {
  if (!status) return UNKNOWN_LABEL;
  return EXPORT_STATUS_LABELS[status] ?? status;
}
