/**
 * Notifications (`/notifications`) — the plain-language feed for the signed-in
 * person, aggregated across every Workspace they belong to (the friendly
 * counterpart of the raw Activity view).
 *
 * Honesty contract: every sentence renders ONLY values the backend already
 * recorded as public-safe Activity metadata (names, ids, counts, compact error
 * CODES) — no invented prices, formulas, or messages.
 */
import "../../styles/wave-b.css";
import "../../styles/wave-c.css";
import { createResource, For, Match, Show, Switch } from "solid-js";
import { A } from "@solidjs/router";
import { AlertTriangle, Bell } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import type { ActivityEvent, ControlApiError } from "../../lib/control-api.ts";
import {
  attentionCount,
  type FeedEntry,
  isFailureAction,
  refreshNotificationFeed,
} from "../../lib/notifications.ts";
import { listCapsulesCached } from "../../lib/capsule-list.ts";
import { runFailureHint } from "../../lib/run-errors.ts";
import { operationLabel } from "../../lib/labels.ts";
import { relativeTime, t } from "../../i18n/index.ts";
import {
  Badge,
  EmptyState,
  PageHeader,
  Skeleton,
  Toast,
} from "../../components/ui/index.ts";

function metaString(
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

/**
 * One plain-language sentence per event, from recorded metadata only. Unknown
 * actions use neutral copy; raw backend verbs stay in the activity debug layer.
 * `serviceName` (resolved from the recorded Capsule id — still backend data,
 * never invented) upgrades run/service lines to their named variants so the
 * reader knows WHICH service each line is about.
 */
function describeEvent(
  event: ActivityEvent,
  serviceName?: string,
): {
  readonly title: string;
  readonly detail?: string;
} {
  const m = event.metadata ?? {};
  const name = serviceName;
  switch (event.action) {
    case "installation.created":
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
    case "capsule.auto_update_disabled": {
      return { title: t("notif.event.autoUpdateOff") };
    }
    case "installation.auto_update_failed":
    case "installation.auto_update_apply_failed": {
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
    case "installation.drift_detected": {
      return {
        title: name
          ? t("notif.event.driftNamed", { name })
          : t("notif.event.drift"),
        detail: t("notif.event.driftDetail"),
      };
    }
    case "installation.stale": {
      const producer = metaString(m, "producerInstallationName");
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
      const provider = metaString(m, "provider");
      return {
        title: provider
          ? t("notif.event.connCreated", { provider })
          : t("notif.event.connCreatedGeneric"),
      };
    }
    case "connection.revoked": {
      const provider = metaString(m, "provider");
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
    case "run_group.created": {
      return { title: t("notif.event.groupCreated") };
    }
    default: {
      return { title: t("notif.event.recorded") };
    }
  }
}

/** Links an activity event to the page for its target (run / run-group / app). */
function eventHref(event: ActivityEvent): string | undefined {
  if (event.targetType === "run") {
    return `/runs/${encodeURIComponent(event.targetId)}`;
  }
  if (event.targetType === "run_group") {
    return `/run-groups/${encodeURIComponent(event.targetId)}`;
  }
  if (event.targetType === "installation" || event.targetType === "capsule") {
    return `/services/${encodeURIComponent(event.targetId)}`;
  }
  return undefined;
}

/** Capsule id an event is about: run events record it as metadata
 * (installationId / capsuleId); service events carry it as the target. */
function eventCapsuleId(event: ActivityEvent): string | undefined {
  const m = event.metadata ?? {};
  const fromMeta =
    metaString(m, "installationId") ?? metaString(m, "capsuleId");
  if (fromMeta) return fromMeta;
  if (event.targetType === "installation" || event.targetType === "capsule") {
    return event.targetId;
  }
  return undefined;
}

/** workspaceId → (capsuleId → name), resolved best-effort per feed load. */
type CapsuleNameIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

async function loadCapsuleNameIndex(
  entries: readonly FeedEntry[],
): Promise<CapsuleNameIndex> {
  const workspaceIds = [
    ...new Set(entries.map((entry) => entry.event.workspaceId)),
  ];
  const results = await Promise.allSettled(
    workspaceIds.map(
      async (id) =>
        [id, await listCapsulesCached(id, { includeDestroyed: true })] as const,
    ),
  );
  const index = new Map<string, ReadonlyMap<string, string>>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const [id, capsules] = result.value;
    index.set(
      id,
      new Map(capsules.map((capsule) => [capsule.id, capsule.name])),
    );
  }
  return index;
}

function NotificationRow(props: {
  entry: FeedEntry;
  serviceName?: string | undefined;
}) {
  const failure = () => isFailureAction(props.entry.event.action);
  const description = () => describeEvent(props.entry.event, props.serviceName);
  const href = () => eventHref(props.entry.event);
  return (
    <li class={`wc-notif-row${failure() ? " wc-notif-row-failure" : ""}`}>
      <span class="wc-notif-icon" aria-hidden="true">
        <Show when={failure()} fallback={<Bell />}>
          <AlertTriangle />
        </Show>
      </span>
      <div class="wc-notif-body">
        <p class="wc-notif-title">
          <Show when={failure()}>
            <Badge tone="danger">{t("notif.badge.attention")}</Badge>
          </Show>
          <Show when={href()} fallback={description().title}>
            {(to) => <A href={to()}>{description().title}</A>}
          </Show>
        </p>
        <Show when={description().detail}>
          {(detail) => <p class="wc-notif-detail">{detail()}</p>}
        </Show>
        <p class="wc-notif-foot">
          <span>@{props.entry.workspaceHandle}</span>
          <Show when={props.entry.event.createdAt}>
            <span aria-hidden="true">·</span>
            <time datetime={props.entry.event.createdAt}>
              {relativeTime(props.entry.event.createdAt)}
            </time>
          </Show>
        </p>
      </div>
    </li>
  );
}

export default function NotificationsView() {
  return (
    <Page title={t("notif.title")}>
      {() => {
        // Same feed snapshot the TopBar badge reads (force = the page always
        // shows fresh events); the 要対応 banner below counts through the
        // SAME attentionCount derivation, so the two can never disagree.
        const [feed] = createResource(() =>
          refreshNotificationFeed({ force: true }),
        );
        // Service names for the recorded Capsule ids — best-effort, cached;
        // lines render unnamed until (unless) the lookup resolves.
        const [capsuleNames] = createResource(
          () => (feed.error ? undefined : feed()),
          (entries) => loadCapsuleNameIndex(entries),
        );
        const serviceNameFor = (event: ActivityEvent): string | undefined => {
          const capsuleId = eventCapsuleId(event);
          if (!capsuleId) return undefined;
          return capsuleNames()?.get(event.workspaceId)?.get(capsuleId);
        };
        const loading = () => feed.loading;
        const error = () => feed.error as ControlApiError | undefined;
        const failureCount = () => attentionCount(feed());

        return (
          <>
            <PageHeader
              title={t("notif.title")}
              subtitle={t("notif.subtitle")}
            />

            <Switch>
              <Match when={loading()}>
                <Skeleton variant="card" count={3} />
              </Match>
              <Match when={error()}>
                <Toast tone="error">
                  {t("common.fetchFailed", { message: error()?.message ?? "" })}
                </Toast>
              </Match>
              <Match when={feed()}>
                {(list) => (
                  <Show
                    when={list().length > 0}
                    fallback={
                      <EmptyState
                        icon={<Bell />}
                        title={t("notif.empty.title")}
                        message={t("notif.empty.message")}
                      />
                    }
                  >
                    <div class="wc-stack-sm">
                      <Show when={failureCount() > 0}>
                        <p class="wc-notif-summary">
                          <AlertTriangle aria-hidden="true" />
                          {t("notif.attention", { n: failureCount() })}
                        </p>
                      </Show>
                      <ul class="wc-notif-list">
                        <For each={list()}>
                          {(entry) => (
                            <NotificationRow
                              entry={entry}
                              serviceName={serviceNameFor(entry.event)}
                            />
                          )}
                        </For>
                      </ul>
                      <details class="wb-disclosure wc-notif-support">
                        <summary>{t("notif.supportSummary")}</summary>
                        <p class="muted">
                          <A href="/activity">{t("notif.viewRaw")}</A>
                        </p>
                      </details>
                    </div>
                  </Show>
                )}
              </Match>
            </Switch>
          </>
        );
      }}
    </Page>
  );
}
