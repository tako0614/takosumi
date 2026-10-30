/**
 * Which Activity events become a notification to Takosumi Mobile, who
 * receives it, and what it says. Design: takos-control
 * `docs/platform/takosumi-app-clients.md` (「何を通知するか」「中身」).
 *
 * Recipients come from the app (Capsule) owner and the accounts an event
 * names, never from Workspace membership. Texts carry the app name and the
 * kind of Run only: no secret, token, error message or Output value.
 */

import type { ActivityEvent } from "takosumi-contract/activity";

/** Approval waits: kept a day, sent with `Urgency: high`. */
const APPROVAL_TTL_SECONDS = 86_400;
const DEFAULT_TTL_SECONDS = 259_200;

export type OwnNotificationKind =
  | "run.approval_required"
  | "run.failed"
  | "run.applied"
  | "capsule.drift_detected"
  | "capsule.auto_update_failed"
  | "capsule.auto_update_apply_failed"
  | "capsule.uninstall_blocked"
  | "connection.revoked"
  | "interface_materialization.dead_lettered"
  | "app.ownership_transfer_created"
  | "app.member_added"
  | "interface_link.approval_requested";

export type OwnNotificationRecipient =
  | { readonly kind: "app_owner"; readonly capsuleId: string }
  | { readonly kind: "run_starter"; readonly runId: string }
  | { readonly kind: "account"; readonly accountId: string };

export interface OwnNotificationPlan {
  readonly kind: OwnNotificationKind;
  readonly eventId: string;
  /** Event time in milliseconds. */
  readonly occurredAt: number;
  readonly recipients: readonly OwnNotificationRecipient[];
  /** The app whose name the text shows, if any. */
  readonly capsuleId?: string;
  /** Second app for an Interface link request (the consumer). */
  readonly consumerCapsuleId?: string;
  /** Dashboard path on the instance origin. */
  readonly navigatePath: string;
  readonly ttlSeconds: number;
  readonly urgency: "high" | "normal";
  /** Groups notifications for `Topic` and the on-device `tag`. */
  readonly group: string;
  readonly runOperation?: string;
  readonly runPhase?: string;
}

const ATTENTION_KINDS = new Set<OwnNotificationKind>([
  "capsule.drift_detected",
  "capsule.auto_update_failed",
  "capsule.auto_update_apply_failed",
  "capsule.uninstall_blocked",
  "interface_materialization.dead_lettered",
]);

/** Unstored context the recorder handed to the notification hook. */
export interface OwnNotificationContext {
  readonly ownerAccountId?: string;
  readonly actorAccountId?: string;
}

/** The plan for one Activity event, or undefined when it is not notified. */
export function planOwnNotification(
  event: ActivityEvent,
  context?: OwnNotificationContext,
): OwnNotificationPlan | undefined {
  const occurredAt = Date.parse(event.createdAt);
  if (!Number.isFinite(occurredAt)) return undefined;
  const base = { eventId: event.id, occurredAt };
  const capsuleId =
    field(event, "capsuleId") ??
    (event.targetType === "capsule" ? event.targetId : undefined);
  const runId = event.runId ?? (event.targetType === "run" ? event.targetId : undefined);
  const kind = event.action as OwnNotificationKind;
  switch (event.action) {
    case "run.approval_required":
      if (!runId || !capsuleId) return undefined;
      return {
        ...base,
        kind,
        recipients: [{ kind: "app_owner", capsuleId }],
        capsuleId,
        navigatePath: `/runs/${encodeURIComponent(runId)}`,
        ttlSeconds: APPROVAL_TTL_SECONDS,
        urgency: "high",
        group: `run:${runId}`,
        ...optional("runOperation", field(event, "operation")),
      };
    case "run.failed": {
      if (!runId) return undefined;
      const phase = field(event, "phase");
      return {
        ...base,
        kind,
        recipients: [
          { kind: "run_starter", runId },
          ...(capsuleId ? [{ kind: "app_owner" as const, capsuleId }] : []),
        ],
        ...optional("capsuleId", capsuleId),
        navigatePath: `/runs/${encodeURIComponent(runId)}`,
        ttlSeconds: DEFAULT_TTL_SECONDS,
        urgency: "normal",
        // Periodic drift checks fail as a new Run each time: collapse them
        // per app, like drift itself, instead of one notification per Run.
        group: phase === "drift_check" && capsuleId ? `drift:${capsuleId}` : `run:${runId}`,
        ...optional("runOperation", field(event, "operation")),
        ...optional("runPhase", phase),
      };
    }
    case "run.applied":
      // Only the first Apply of an install (operation `create`).
      if (!runId || !capsuleId || field(event, "operation") !== "create") {
        return undefined;
      }
      return {
        ...base,
        kind,
        recipients: [{ kind: "run_starter", runId }],
        capsuleId,
        navigatePath: appPath(capsuleId),
        ttlSeconds: DEFAULT_TTL_SECONDS,
        urgency: "normal",
        group: `installed:${capsuleId}`,
      };
    case "connection.revoked": {
      // The Connection record is deleted before the event is read, and its
      // owner is not stored in the public event: the recorder hands it to the
      // immediate path only. The owner is told only when someone else revoked
      // it; a scheduled re-read has no owner and sends nothing.
      const owner = context?.ownerAccountId;
      const actor = context?.actorAccountId ?? event.actorId;
      if (!owner || owner === actor) return undefined;
      return {
        ...base,
        kind,
        recipients: [{ kind: "account", accountId: owner }],
        navigatePath: "/connections",
        ttlSeconds: DEFAULT_TTL_SECONDS,
        urgency: "normal",
        group: `connection:${event.targetId}`,
      };
    }
    case "app.ownership_transfer_created": {
      const recipient = field(event, "recipientAccountId");
      if (!recipient || !capsuleId) return undefined;
      return {
        ...base,
        kind,
        recipients: [{ kind: "account", accountId: recipient }],
        capsuleId,
        navigatePath: appPath(capsuleId),
        ttlSeconds: DEFAULT_TTL_SECONDS,
        urgency: "normal",
        group: `transfer:${capsuleId}`,
      };
    }
    case "app.member_added": {
      const member = field(event, "memberAccountId");
      if (!member || !capsuleId) return undefined;
      return {
        ...base,
        kind,
        recipients: [{ kind: "account", accountId: member }],
        capsuleId,
        navigatePath: appPath(capsuleId),
        ttlSeconds: DEFAULT_TTL_SECONDS,
        urgency: "normal",
        group: `member:${capsuleId}`,
      };
    }
    case "interface_link.approval_requested": {
      const provider = field(event, "providerCapsuleId");
      if (!provider) return undefined;
      return {
        ...base,
        kind,
        recipients: [{ kind: "app_owner", capsuleId: provider }],
        capsuleId: provider,
        ...optional("consumerCapsuleId", field(event, "consumerCapsuleId")),
        navigatePath: `${appPath(provider)}#links`,
        ttlSeconds: APPROVAL_TTL_SECONDS,
        urgency: "high",
        group: `link:${event.targetId}`,
      };
    }
    default:
      if (!ATTENTION_KINDS.has(kind) || !capsuleId) return undefined;
      return {
        ...base,
        kind,
        recipients: [{ kind: "app_owner", capsuleId }],
        capsuleId,
        navigatePath: `${appPath(capsuleId)}#attention`,
        ttlSeconds: DEFAULT_TTL_SECONDS,
        urgency: "normal",
        group: kind === "capsule.drift_detected" ? `drift:${capsuleId}` : `${kind}:${capsuleId}`,
      };
  }
}

export type OwnNotificationLanguage = "ja" | "en";

/** Japanese for a `ja` device language, English otherwise. */
export function ownNotificationLanguage(lang: string): OwnNotificationLanguage {
  return /^ja(?:-|$)/i.test(lang.trim()) ? "ja" : "en";
}

export interface OwnNotificationNames {
  readonly app?: string;
  readonly consumerApp?: string;
}

export function renderOwnNotification(
  plan: OwnNotificationPlan,
  names: OwnNotificationNames,
  language: OwnNotificationLanguage,
): { readonly title: string; readonly body: string } {
  const ja = language === "ja";
  const app = names.app ?? (ja ? "アプリ" : "an app");
  const appName = names.app ?? (ja ? "アプリ" : "The app");
  switch (plan.kind) {
    case "run.approval_required":
      return plan.runOperation === "destroy"
        ? ja
          ? { title: "承認を待っています", body: `${app} の削除に承認が必要です` }
          : { title: "Waiting for your approval", body: `Removing ${app} needs your approval` }
        : ja
          ? { title: "承認を待っています", body: `${app} の変更に、削除または置き換えを含むplanがあります` }
          : { title: "Waiting for your approval", body: `A plan for ${app} deletes or replaces resources` };
    case "run.failed": {
      const phase = runPhaseLabel(plan.runPhase ?? plan.runOperation, language);
      return ja
        ? { title: "Runが失敗しました", body: `${app} の${phase}が失敗しました` }
        : { title: "A Run failed", body: `The ${phase} of ${app} failed` };
    }
    case "run.applied":
      return ja
        ? { title: "インストールが完了しました", body: `${app} を使えるようになりました` }
        : { title: "Installed", body: `${appName} is ready to use` };
    case "capsule.drift_detected":
      return ja
        ? { title: "確認が必要です", body: `${app} の実際の状態が設定とずれています` }
        : { title: "Needs attention", body: `${appName} has drifted from its configuration` };
    case "capsule.auto_update_failed":
      return ja
        ? { title: "確認が必要です", body: `${app} の自動更新に失敗しました` }
        : { title: "Needs attention", body: `The automatic update of ${app} failed` };
    case "capsule.auto_update_apply_failed":
      return ja
        ? { title: "確認が必要です", body: `${app} の自動更新を適用できませんでした` }
        : { title: "Needs attention", body: `Applying the automatic update of ${app} failed` };
    case "capsule.uninstall_blocked":
      return ja
        ? { title: "確認が必要です", body: `${app} のアンインストールが止まっています` }
        : { title: "Needs attention", body: `Uninstalling ${app} is blocked` };
    case "interface_materialization.dead_lettered":
      return ja
        ? { title: "確認が必要です", body: `${app} の連携の準備を完了できませんでした` }
        : { title: "Needs attention", body: `Setting up a link for ${app} did not finish` };
    case "connection.revoked":
      return ja
        ? { title: "確認が必要です", body: "接続が取り消されました" }
        : { title: "Needs attention", body: "A connection was revoked" };
    case "app.ownership_transfer_created":
      return ja
        ? { title: "持ち主の移転の依頼", body: `${app} の持ち主になるよう依頼されています` }
        : { title: "Ownership transfer request", body: `You are asked to become the owner of ${app}` };
    case "app.member_added":
      return ja
        ? { title: "メンバーに追加されました", body: `${app} のメンバーになりました` }
        : { title: "Added as a member", body: `You are now a member of ${app}` };
    case "interface_link.approval_requested": {
      const consumer = names.consumerApp ?? (ja ? "別のアプリ" : "Another app");
      return ja
        ? { title: "連携の承認を待っています", body: `${consumer} が ${app} との連携を求めています` }
        : { title: "Waiting for your approval", body: `${consumer} asks to link with ${app}` };
    }
  }
}

function runPhaseLabel(
  phase: string | undefined,
  language: OwnNotificationLanguage,
): string {
  const ja = language === "ja";
  switch (phase) {
    case "plan":
    case "create":
    case "update":
      return "plan";
    case "drift_check":
      return ja ? "状態の確認" : "drift check";
    case "apply":
      return ja ? "適用" : "apply";
    case "destroy":
    case "destroy_apply":
      return ja ? "削除" : "removal";
    default:
      return "Run";
  }
}

function appPath(capsuleId: string): string {
  return `/apps/${encodeURIComponent(capsuleId)}`;
}

/**
 * A string field from the event's metadata, or from the top level: app
 * ownership rows are written by the store itself with `memberAccountId` and
 * `recipientAccountId` beside the standard fields and no metadata.
 */
function field(event: ActivityEvent, key: string): string | undefined {
  const metadata = (event as { readonly metadata?: unknown }).metadata;
  const fromMetadata =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>)[key]
      : undefined;
  const value = fromMetadata ?? (event as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optional<K extends string>(
  key: K,
  value: string | undefined,
): { readonly [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: string };
}
