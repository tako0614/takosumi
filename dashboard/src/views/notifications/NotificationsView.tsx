/**
 * Notifications (`/notifications`) — the plain-language feed for the signed-in
 * person, aggregated across a bounded recent set of active workspaces plus the
 * current one. Each entry links to where it can be acted on: the app's page,
 * the run, or 接続.
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
  acknowledgeNotifications,
  attentionCount,
  type FeedEntry,
  isFailureAction,
  notificationFeed,
  refreshNotificationFeed,
} from "../../lib/notifications.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { workspaceName } from "../../lib/workspace-labels.ts";
import { readyOrUndefined } from "../../lib/resource-read.ts";
import { t } from "../../i18n/index.ts";
import RelativeTime from "../account/components/RelativeTime.tsx";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  Toast,
} from "../../components/ui/index.ts";
import { fetchFailedMessage } from "../../lib/error-copy.ts";
import { activityEventHref } from "../../lib/activity-links.ts";
import {
  activityServiceName,
  describeActivityEvent,
} from "../../lib/activity-copy.ts";

const eventHref = activityEventHref;
function NotificationRow(props: {
  entry: FeedEntry;
  serviceName?: string | undefined;
  workspaceName: string;
  /** Workspaces are named only when there is more than one. */
  showWorkspace: boolean;
}) {
  const failure = () => isFailureAction(props.entry.event.action);
  const description = () => describeActivityEvent(props.entry.event, props.serviceName);
  const href = () => eventHref(props.entry.event);
  // The feed stays cross-Workspace, but the bell badge / 要対応 banner count
  // only the CURRENT Workspace — call out entries that belong to another
  // Workspace so their exclusion from the count is legible.
  const otherWorkspace = () => {
    const current = currentWorkspaceId();
    return Boolean(current && props.entry.event.workspaceId !== current);
  };
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
          <Show when={props.showWorkspace}>
            <Show
              when={otherWorkspace()}
              fallback={<span>{props.workspaceName}</span>}
            >
              <span>
                {t("notif.otherWorkspace", { name: props.workspaceName })}
              </span>
            </Show>
            <span aria-hidden="true">·</span>
          </Show>
          <Show when={props.entry.event.createdAt}>
            {(createdAt) => <RelativeTime iso={createdAt()} />}
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
        // Same feed snapshot the TopBar badge reads. The page revalidates in
        // the BACKGROUND (force refresh) but renders the existing shared
        // snapshot immediately — a bell click must not full-skeleton over
        // entries the badge already counted. The 要対応 banner and the bell
        // badge derive the SAME count from this feed (attentionCount, scoped to
        // the current Workspace).
        const [refreshed] = createResource(() =>
          refreshNotificationFeed({
            force: true,
            selectedWorkspaceId: currentWorkspaceId() || undefined,
          }),
        );
        const feed = () => notificationFeed();
        const serviceNameFor = (event: ActivityEvent): string | undefined =>
          activityServiceName(event);
        // Entries carry the Workspace handle (or id); people know their
        // Workspaces by display name. The list is the shell's cached copy.
        const [workspaces] = createResource(() => listWorkspacesCached());
        const multipleWorkspaces = () =>
          (readyOrUndefined(workspaces) ?? []).length >= 2;
        const workspaceNameFor = (entry: FeedEntry): string => {
          const workspace = (readyOrUndefined(workspaces) ?? []).find(
            (item) => item.id === entry.event.workspaceId,
          );
          return workspace
            ? workspaceName(workspace)
            : workspaceName({ displayName: "", handle: entry.workspaceHandle });
        };
        // Skeleton / error only before the FIRST snapshot exists; afterwards a
        // failed background refresh silently keeps the last-known entries
        // (mirrors the TopBar badge's behaviour).
        const loading = () => feed() === undefined && refreshed.loading;
        const error = () =>
          feed() === undefined
            ? (refreshed.error as ControlApiError | undefined)
            : undefined;
        const failureCount = () =>
          attentionCount(feed(), currentWorkspaceId() || undefined);

        return (
          <>
            <PageHeader
              title={t("notif.title")}
              subtitle={t("notif.subtitle")}
              actions={
                <Show when={failureCount() > 0}>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => acknowledgeNotifications(feed())}
                  >
                    {t("notif.markAllRead")}
                  </Button>
                </Show>
              }
            />

            <Switch>
              <Match when={loading()}>
                <Skeleton variant="card" count={3} />
              </Match>
              <Match when={error()}>
                <Toast tone="error">
                  {fetchFailedMessage(error(), t)}
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() =>
                      void refreshNotificationFeed({ force: true })
                    }
                  >
                    {t("common.retry")}
                  </Button>
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
                        action={
                          <Button variant="primary" href="/new">
                            {t("notif.empty.cta")}
                          </Button>
                        }
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
                              workspaceName={workspaceNameFor(entry)}
                              showWorkspace={multipleWorkspaces()}
                            />
                          )}
                        </For>
                      </ul>
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
