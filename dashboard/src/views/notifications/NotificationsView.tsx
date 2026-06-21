/**
 * Notifications (`/notifications`) — the plain-language feed for the signed-in
 * person, aggregated across every Space they belong to (the friendly
 * counterpart of the raw Activity view). Opening this page marks the feed seen,
 * which clears the TopBar bell badge.
 *
 * Honesty contract: every sentence renders ONLY values the backend already
 * recorded as public-safe Activity metadata (names, ids, counts, compact error
 * CODES) — no invented prices, formulas, or messages.
 */
import "../../styles/wave-c.css";
import {
  createEffect,
  createMemo,
  createResource,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { A } from "@solidjs/router";
import { AlertTriangle, Bell } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import {
  type ActivityEvent,
  type ControlApiError,
  listSpaces,
} from "../../lib/control-api.ts";
import {
  type FeedEntry,
  isFailureAction,
  loadNotificationFeed,
  markSeen,
} from "../../lib/notifications.ts";
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
 * actions fall back to the raw verb so nothing is silently dropped.
 */
function describeEvent(event: ActivityEvent): {
  readonly title: string;
  readonly detail?: string;
} {
  const m = event.metadata ?? {};
  switch (event.action) {
    case "installation.created": {
      const name = metaString(m, "name") ?? "—";
      const env = metaString(m, "environment");
      return {
        title: t("notif.event.installCreated", { name }),
        detail: env ? t("notif.event.installCreatedEnv", { env }) : undefined,
      };
    }
    case "run.plan_created": {
      return {
        title: t("notif.event.planReady", {
          operation: operationLabel(metaString(m, "operation")),
        }),
        detail:
          metaString(m, "policyStatus") === "blocked"
            ? t("notif.event.planBlockedDetail")
            : t("notif.event.planReadyDetail"),
      };
    }
    case "run.approved": {
      return {
        title: t("notif.event.approved", {
          operation: operationLabel(metaString(m, "operation")),
        }),
      };
    }
    case "run.applied": {
      const outputs = metaNumber(m, "outputCount");
      return {
        title: t("notif.event.applied"),
        detail:
          outputs !== undefined
            ? t("notif.event.appliedDetail", { n: outputs })
            : undefined,
      };
    }
    case "run.destroyed": {
      return { title: t("notif.event.destroyed") };
    }
    case "run.failed": {
      const code = metaString(m, "errorCode");
      return {
        title: t("notif.event.failed", {
          operation: operationLabel(metaString(m, "phase")),
        }),
        detail: code
          ? t("notif.event.failedDetail", { code })
          : t("notif.event.failedHint"),
      };
    }
    case "installation.drift_detected": {
      return {
        title: t("notif.event.drift"),
        detail: t("notif.event.driftDetail"),
      };
    }
    case "installation.stale": {
      const producer = metaString(m, "producerInstallationName");
      return {
        title: t("notif.event.stale"),
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
      return { title: event.action };
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
  if (event.targetType === "installation") {
    return `/capsules/${encodeURIComponent(event.targetId)}`;
  }
  return undefined;
}

function NotificationRow(props: { entry: FeedEntry }) {
  const failure = () => isFailureAction(props.entry.event.action);
  const description = () => describeEvent(props.entry.event);
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
          <span>@{props.entry.spaceHandle}</span>
          <span aria-hidden="true">·</span>
          <time datetime={props.entry.event.createdAt}>
            {relativeTime(props.entry.event.createdAt)}
          </time>
        </p>
      </div>
    </li>
  );
}

export default function NotificationsView() {
  return (
    <Page title={t("notif.title")}>
      {() => {
        const [spaces] = createResource(listSpaces);
        const [feed] = createResource(
          () => spaces(),
          (list) => loadNotificationFeed(list),
        );
        const loading = () => spaces.loading || feed.loading;
        const error = createMemo(
          () =>
            (spaces.error as ControlApiError | undefined) ??
            (feed.error as ControlApiError | undefined),
        );
        const failureCount = () =>
          (feed() ?? []).filter((e) => isFailureAction(e.event.action)).length;

        // Once the feed is loaded, the visitor has SEEN it — clear the badge.
        createEffect(() => {
          const list = feed();
          if (list) markSeen(list);
        });

        return (
          <AppShell>
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
                          {(entry) => <NotificationRow entry={entry} />}
                        </For>
                      </ul>
                      <p class="muted">
                        <A href="/activity">{t("notif.viewRaw")}</A>
                      </p>
                    </div>
                  </Show>
                )}
              </Match>
            </Switch>
          </AppShell>
        );
      }}
    </Page>
  );
}
