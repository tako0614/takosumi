/**
 * Locale-aware status / operation labels (successor of status-labels.ts).
 *
 * Single source of truth for turning backend enum strings into user-facing
 * wording in the active locale. Unknown operations render as neutral copy in
 * primary UI; raw backend values belong in folded support/debug details.
 *
 * Vocabulary contract: Capsule / 追加 / 変更を確認 / デプロイ / デプロイ済み
 * (Capsule / Add / Review changes / Deploy / Deployed) — see i18n/ja.ts.
 */
import { type MessageKey, t } from "../i18n/index.ts";
import type { Tone } from "../components/ui/Badge.tsx";

function label(
  map: Record<string, MessageKey>,
  status: string | undefined,
): string {
  if (!status) return t("common.unknown");
  const key = map[status];
  // An unmapped backend enum must read neutrally in a primary badge, not leak
  // the raw snake_case token to the consumer.
  return key ? t(key) : t("common.unknown");
}

/** Capsule lifecycle status: pending/active/stale/error/disabled/destroyed. */
const INSTALLATION: Record<string, MessageKey> = {
  pending: "status.capsule.pending",
  needs_attention: "status.capsule.needsAttention",
  active: "status.capsule.active",
  stale: "status.capsule.stale",
  error: "status.capsule.error",
  disabled: "status.capsule.disabled",
  destroyed: "status.capsule.destroyed",
};
export const capsuleStatusLabel = (status?: string) =>
  label(INSTALLATION, status);

/** Run status (spec §19). */
const RUN: Record<string, MessageKey> = {
  queued: "status.run.queued",
  running: "status.run.running",
  waiting_approval: "status.run.waiting_approval",
  succeeded: "status.run.succeeded",
  failed: "status.run.failed",
  cancelled: "status.run.cancelled",
  expired: "status.run.expired",
};
export const runStatusLabel = (status?: string) => label(RUN, status);

/** Run policy status (spec §25). */
const POLICY: Record<string, MessageKey> = {
  pass: "status.policy.pass",
  warn: "status.policy.warn",
  deny: "status.policy.deny",
};
export const policyStatusLabel = (status?: string) => label(POLICY, status);

/** Run diagnostic severity (info/warning/error) — keeps raw English out of the UI. */
const DIAGNOSTIC_SEVERITY: Record<string, MessageKey> = {
  info: "run.diag.severity.info",
  warning: "run.diag.severity.warning",
  error: "run.diag.severity.error",
};
export const diagnosticSeverityLabel = (severity?: string) =>
  label(DIAGNOSTIC_SEVERITY, severity);

/** Legacy deployment evidence status retained for current compatibility views. */
const DEPLOYMENT: Record<string, MessageKey> = {
  active: "status.deployment.active",
  superseded: "status.deployment.superseded",
  rolled_back: "status.deployment.rolled_back",
  destroyed: "status.deployment.destroyed",
};
export const deploymentStatusLabel = (status?: string) =>
  label(DEPLOYMENT, status);

/** Connection status. */
const CONNECTION: Record<string, MessageKey> = {
  pending: "status.connection.pending",
  verified: "status.connection.verified",
  revoked: "status.connection.revoked",
  expired: "status.connection.expired",
  error: "status.connection.error",
};
export const connectionStatusLabel = (status?: string) =>
  label(CONNECTION, status);

/** ProviderConnection readiness status. */
const PROVIDER_CONNECTION: Record<string, MessageKey> = {
  pending: "status.connection.pending",
  verified: "status.connection.verified",
  revoked: "status.connection.revoked",
  error: "status.connection.error",
  ready: "status.providerConnection.ready",
  needs_setup: "status.providerConnection.needs_setup",
  expired: "status.providerConnection.expired",
  blocked: "status.providerConnection.blocked",
};
export const providerConnectionStatusLabel = (status?: string) =>
  label(PROVIDER_CONNECTION, status);

/** Run operation noun (plan/apply/destroy_* …) for feeds and summaries. */
const OPERATION: Record<string, MessageKey> = {
  plan: "op.plan",
  apply: "op.apply",
  destroy_plan: "op.destroy_plan",
  destroy_apply: "op.destroy_apply",
  drift_check: "op.drift_check",
  source_sync: "op.source_sync",
  compatibility_check: "op.compatibility_check",
  backup: "op.backup",
  restore: "op.restore",
};
export function operationLabel(operation: string | undefined): string {
  if (!operation) return t("op.generic");
  const key = OPERATION[operation];
  return key ? t(key) : t("op.generic");
}

// --- tones (UI colour treatment per status) -----------------------------------

export function capsuleTone(status: string | undefined): Tone {
  switch (status) {
    case "active":
      return "ok";
    case "pending":
    case "stale":
      return "warn";
    case "needs_attention":
    case "error":
      return "danger";
    case "disabled":
    case "destroyed":
      return "muted";
    default:
      return "neutral";
  }
}

export function runTone(status: string | undefined): Tone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "queued":
    case "running":
    case "waiting_approval":
      return "warn";
    case "failed":
    case "expired":
      return "danger";
    case "cancelled":
      return "muted";
    default:
      return "neutral";
  }
}

export function policyTone(status: string | undefined): Tone {
  switch (status) {
    case "pass":
      return "ok";
    case "warn":
      return "warn";
    case "deny":
      return "danger";
    default:
      return "neutral";
  }
}

export function deploymentTone(status: string | undefined): Tone {
  switch (status) {
    case "active":
      return "ok";
    case "superseded":
    case "rolled_back":
    case "destroyed":
      return "muted";
    default:
      return "neutral";
  }
}

export function connectionTone(status: string | undefined): Tone {
  switch (status) {
    case "verified":
      return "ok";
    case "pending":
      return "warn";
    case "error":
      return "danger";
    case "revoked":
    case "expired":
      return "muted";
    default:
      return "neutral";
  }
}

export function providerConnectionTone(status: string | undefined): Tone {
  switch (status) {
    case "verified":
    case "ready":
      return "ok";
    case "pending":
    case "needs_setup":
      return "warn";
    case "error":
    case "blocked":
      return "danger";
    case "revoked":
    case "expired":
      return "muted";
    default:
      return "neutral";
  }
}
