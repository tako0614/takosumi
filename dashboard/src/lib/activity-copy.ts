/**
 * Plain-language copy for Activity events, shared by Notifications and the
 * Activity history so the same event reads the same on both screens.
 *
 * Honesty contract: every sentence renders ONLY values the backend already
 * recorded as public-safe Activity metadata (names, ids, counts, compact error
 * CODES) — no invented prices, formulas, or messages.
 */
import type { ActivityEvent } from "./control-api.ts";
import { operationLabel } from "./labels.ts";
import { readableProviderSourceLabel } from "./provider-labels.ts";
import { runFailureHint } from "./run-errors.ts";
import { t } from "../i18n/index.ts";

export function metaString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = metadata[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function metaNumber(
  metadata: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = metadata[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Generic human-readable label for a recorded provider source. */
function connectionProviderLabel(
  provider: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  return readableProviderSourceLabel(provider);
}

/**
 * One plain-language sentence per event, from recorded metadata only. Unknown
 * actions use neutral copy; raw backend verbs stay in the activity debug layer.
 * `serviceName` (resolved from the recorded Capsule id — still backend data,
 * never invented) upgrades run/service lines to their named variants so the
 * reader knows WHICH service each line is about.
 */
export function describeActivityEvent(
  event: ActivityEvent,
  serviceName?: string,
): {
  readonly title: string;
  readonly detail?: string;
} {
  const m = event.metadata ?? {};
  const name = serviceName;
  switch (event.action) {
    case "capsule.created": {
      const name = metaString(m, "name") ?? "—";
      const env = metaString(m, "environment");
      return {
        title: t("notif.event.installCreated", { name }),
        detail: env ? t("notif.event.installCreatedEnv", { env }) : undefined,
      };
    }
    case "capsule.auto_update_enabled": {
      return { title: t("notif.event.autoUpdateOn") };
    }
    case "capsule.uninstall_scheduled": {
      return {
        title: name
          ? t("notif.event.uninstallScheduledNamed", { name })
          : t("notif.event.uninstallScheduled"),
      };
    }
    case "capsule.uninstall_cancelled": {
      return {
        title: name
          ? t("notif.event.uninstallCancelledNamed", { name })
          : t("notif.event.uninstallCancelled"),
      };
    }
    case "capsule.uninstall_blocked": {
      return {
        title: name
          ? t("notif.event.uninstallBlockedNamed", { name })
          : t("notif.event.uninstallBlocked"),
        detail: t("notif.event.uninstallBlockedDetail"),
      };
    }
    case "capsule.auto_update_disabled": {
      return { title: t("notif.event.autoUpdateOff") };
    }
    case "capsule.auto_update_failed":
    case "capsule.auto_update_apply_failed": {
      return {
        title: name
          ? t("notif.event.autoUpdateFailedNamed", { name })
          : t("notif.event.autoUpdateFailed"),
        detail: t("notif.event.autoUpdateFailedDetail"),
      };
    }
    case "run.plan_created": {
      const operation = operationLabel(metaString(m, "operation"));
      return {
        title: name
          ? t("notif.event.planReadyNamed", { name, operation })
          : t("notif.event.planReady", { operation }),
        detail:
          metaString(m, "policyStatus") === "blocked"
            ? t("notif.event.planBlockedDetail")
            : t("notif.event.planReadyDetail"),
      };
    }
    case "run.approved": {
      const operation = operationLabel(metaString(m, "operation"));
      return {
        title: name
          ? t("notif.event.approvedNamed", { name, operation })
          : t("notif.event.approved", { operation }),
      };
    }
    case "run.applied": {
      const outputs = metaNumber(m, "outputCount");
      return {
        title: name
          ? t("notif.event.appliedNamed", { name })
          : t("notif.event.applied"),
        detail:
          outputs !== undefined
            ? t("notif.event.appliedDetail", { n: outputs })
            : undefined,
      };
    }
    case "run.destroyed": {
      return {
        title: name
          ? t("notif.event.destroyedNamed", { name })
          : t("notif.event.destroyed"),
      };
    }
    case "run.failed": {
      const operation = operationLabel(metaString(m, "phase"));
      return {
        title: name
          ? t("notif.event.failedNamed", { name, operation })
          : t("notif.event.failed", { operation }),
        // Friendly sentence, never the raw snake_case token (that stays in
        // the run screen's folded expert details).
        detail: runFailureHint(metaString(m, "errorCode")),
      };
    }
    case "capsule.drift_detected":
    case "resource.drift_detected": {
      return {
        title: name
          ? t("notif.event.driftNamed", { name })
          : t("notif.event.drift"),
        detail: t("notif.event.driftDetail"),
      };
    }
    case "capsule.stale": {
      const producer = metaString(m, "producerCapsuleName");
      // A source ref change belongs to this service's own Git source, not a
      // producer service. Keep this notice explicit even when producer data
      // is absent on older events.
      if (metaString(m, "reason") === "source_ref_changed" || !producer) {
        return {
          title: name
            ? t("notif.event.staleSourceNamed", { name })
            : t("notif.event.staleSource"),
        };
      }
      return {
        title: name
          ? t("notif.event.staleNamed", { name })
          : t("notif.event.stale"),
        detail: producer
          ? t("notif.event.staleDetail", { producer })
          : undefined,
      };
    }
    case "connection.created": {
      const provider = connectionProviderLabel(metaString(m, "provider"));
      return {
        title: provider
          ? t("notif.event.connCreated", { provider })
          : t("notif.event.connCreatedGeneric"),
      };
    }
    case "connection.revoked": {
      const provider = connectionProviderLabel(metaString(m, "provider"));
      return {
        title: provider
          ? t("notif.event.connRevoked", { provider })
          : t("notif.event.connRevokedGeneric"),
      };
    }
    case "backup.created": {
      return { title: t("notif.event.backupCreated") };
    }
    case "dependency.created": {
      return { title: t("notif.event.depCreated") };
    }
    case "dependency.deleted": {
      return { title: t("notif.event.depDeleted") };
    }
    case "output_share.created": {
      return { title: t("notif.event.shareRequested") };
    }
    case "output_share.approved": {
      return { title: t("notif.event.shareApproved") };
    }
    case "output_share.revoked": {
      return { title: t("notif.event.shareRevoked") };
    }
    case "interface_link.approved": {
      return { title: t("notif.event.interfaceLinkApproved") };
    }
    case "interface_link.declined": {
      return { title: t("notif.event.interfaceLinkDeclined") };
    }
    case "run_group.created": {
      return { title: t("notif.event.groupCreated") };
    }
    case "interface_materialization.dead_lettered": {
      return {
        title: name
          ? t("notif.event.interfaceDeadLetteredNamed", { name })
          : t("notif.event.interfaceDeadLettered"),
        detail: t("notif.event.interfaceDeadLetteredDetail"),
      };
    }
    case "interface_materialization.retry_requested": {
      return {
        title: name
          ? t("notif.event.interfaceRetryRequestedNamed", { name })
          : t("notif.event.interfaceRetryRequested"),
      };
    }
    default: {
      return { title: t("notif.event.recorded") };
    }
  }
}

/**
 * The service an event is about: the name the backend recorded on the event,
 * else the current name of the recorded Capsule id. `undefined` when neither
 * is known — callers then use the unnamed sentence.
 */
export function activityServiceName(
  event: ActivityEvent,
  namesById?: ReadonlyMap<string, string>,
): string | undefined {
  const metadata = event.metadata ?? {};
  const recorded =
    metaString(metadata, "capsuleName") ?? metaString(metadata, "name");
  if (recorded) return recorded;
  const capsuleId =
    metaString(metadata, "capsuleId") ??
    (event.targetType === "capsule" && event.targetId
      ? event.targetId
      : undefined);
  return capsuleId ? namesById?.get(capsuleId) : undefined;
}
