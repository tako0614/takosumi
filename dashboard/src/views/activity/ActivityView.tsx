/**
 * History view — the Workspace-scoped activity feed. The default row is
 * plain-language; raw action/target/metadata remains available in a disclosure
 * for support and audit work.
 */
import "../../styles/wave-a.css";
import "../../styles/wave-b.css";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { ScrollText } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { type ActivityEvent, listActivity } from "../../lib/control-api.ts";
import { createServiceNames } from "../../lib/service-names.ts";
import {
  activityServiceName,
  describeActivityEvent,
} from "../../lib/activity-copy.ts";
import { activityActorLabel } from "../../lib/account-labels.ts";
import type { SessionRecord } from "../account/lib/session.ts";
import { formatDateTime, relativeTime, t } from "../../i18n/index.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { Card } from "../../components/ui/Card.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";
import Button from "../../components/ui/Button.tsx";
import Skeleton from "../../components/ui/Skeleton.tsx";
import { fetchFailedMessage } from "../../lib/error-copy.ts";
import { activityEventHref } from "../../lib/activity-links.ts";
import { A } from "@solidjs/router";

const ACTIVITY_PAGE_SIZE = 100;
/** Backend clamp (contract ACTIVITY_MAX_LIMIT) — asking for more is a 400. */
const ACTIVITY_MAX_LIMIT = 500;

export default function ActivityView() {
  return (
    <Page title={t("activity.title")}>
      {(session) => <Inner session={session} />}
    </Page>
  );
}

function MetadataChips(props: { metadata: Record<string, unknown> }) {
  const entries = () =>
    Object.entries(props.metadata ?? {}).filter(
      ([, v]) => v !== null && v !== undefined && typeof v !== "object",
    );
  return (
    <Show when={entries().length > 0}>
      <div class="wa-meta">
        <For each={entries()}>
          {([k, v]) => (
            <span class="wa-meta-chip">
              <span class="muted">{k}</span>=<code>{String(v)}</code>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}

function ActivityRow(props: {
  event: ActivityEvent;
  serviceName?: string | undefined;
  session: SessionRecord;
}) {
  // Same sentence as the Notifications feed, named after the service when
  // the history knows which one the event is about.
  const description = () =>
    describeActivityEvent(props.event, props.serviceName);
  return (
    <li class="wa-activity-row">
      <div class="wa-activity-head">
        {/* The identical row on /notifications links to the run or service it
            is about; the history page rendered it as unclickable text, so a
            failure found here was a dead end. */}
        <Show
          when={activityEventHref(props.event)}
          fallback={
            <span class="wa-activity-action">{description().title}</span>
          }
        >
          {(href) => (
            <A class="wa-activity-action wa-activity-link" href={href()}>
              {description().title}
            </A>
          )}
        </Show>
      </div>
      <Show when={description().detail}>
        {(detail) => <p class="muted">{detail()}</p>}
      </Show>
      <div class="wa-activity-rowmeta">
        {/* The page promises だれが何を変更したか — surface the recorded
            actor on the row itself, not only inside the debug disclosure.
            Your own events read as you; the raw subject stays in the debug
            layer and on hover. */}
        <Show when={props.event.actorId}>
          {(actor) => (
            <span class="muted" title={actor()}>
              {t("activity.actorLine", {
                actor: activityActorLabel(actor(), props.session),
              })}
            </span>
          )}
        </Show>
        {/* Relative first (the app's convention elsewhere), absolute on hover
            — "6 months ago vs today" was unanswerable at a glance. */}
        <time
          datetime={props.event.createdAt}
          title={formatDateTime(props.event.createdAt)}
        >
          {relativeTime(props.event.createdAt)}
        </time>
      </div>
      <details class="wb-disclosure">
        <summary>{t("activity.details")}</summary>
        <p class="muted">{t("activity.detailsBody")}</p>
        <details class="wb-inline-details">
          <summary>{t("activity.debug")}</summary>
          <div class="wa-meta">
            <Show when={props.event.actorId}>
              {(actorId) => (
                <span class="wa-meta-chip">
                  <span class="muted">actor</span>=<code>{actorId()}</code>
                </span>
              )}
            </Show>
            <span class="wa-meta-chip">
              <span class="muted">action</span>=
              <code>{props.event.action}</code>
            </span>
            <span class="wa-meta-chip">
              <span class="muted">target</span>=
              <code>
                {props.event.targetType}:{props.event.targetId}
              </code>
            </span>
          </div>
          <MetadataChips metadata={props.event.metadata} />
        </details>
      </details>
    </li>
  );
}

function Inner(props: { session: SessionRecord }) {
  const workspaceId = () =>
    currentWorkspaceId() ? currentWorkspaceId() : null;
  const serviceNames = createServiceNames(workspaceId);
  const [limit, setLimit] = createSignal(ACTIVITY_PAGE_SIZE);
  const eventsKey = () => {
    const id = workspaceId();
    return id ? ([id, limit()] as const) : null;
  };
  const [events, { refetch: refetchEvents }] = createResource(
    eventsKey,
    ([id, max]) => listActivity(id, max),
  );
  createEffect(
    on(workspaceId, () => setLimit(ACTIVITY_PAGE_SIZE), { defer: true }),
  );
  // Load-more keeps the current rows on screen (reads `.latest`), but a
  // Workspace switch must not flash the previous Workspace's trail — so keep
  // only this Workspace's events. (Clearing the resource with `mutate` on the
  // switch raced the first load: the route transition delayed that effect
  // until the events had arrived, and a fresh session showed "No activity".)
  const rows = () =>
    (events.error ? [] : (events.latest ?? [])).filter(
      (event) => event.workspaceId === workspaceId(),
    );
  const canLoadMore = () =>
    rows().length >= limit() && limit() < ACTIVITY_MAX_LIMIT;
  const atListCap = () =>
    limit() >= ACTIVITY_MAX_LIMIT && rows().length >= ACTIVITY_MAX_LIMIT;

  return (
    <>
      <PageHeader
        title={t("activity.title")}
        subtitle={t("activity.subtitle")}
      />

      <Show
        when={workspaceId()}
        fallback={
          <EmptyState
            icon={<ScrollText size={28} />}
            title={t("workspace.select")}
            message={t("workspace.selectMessage")}
          />
        }
      >
        <Switch>
          <Match when={events.loading && !events.error && !events.latest}>
            <Card>
              <Skeleton variant="row" count={5} />
            </Card>
          </Match>
          <Match when={events.error}>
            <EmptyState
              icon={<ScrollText size={28} />}
              title={t("activity.title")}
              message={fetchFailedMessage(events.error, t)}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => void refetchEvents()}
                >
                  {t("common.retry")}
                </Button>
              }
            />
          </Match>
          <Match when={rows()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <EmptyState
                    icon={<ScrollText size={28} />}
                    title={t("activity.empty.title")}
                    message={t("activity.empty.message")}
                    action={
                      <Button variant="primary" href="/new">
                        {t("apps.add")}
                      </Button>
                    }
                  />
                }
              >
                <Card>
                  <ul class="wa-activity">
                    <For each={list()}>
                      {(event) => (
                        <ActivityRow
                          event={event}
                          serviceName={activityServiceName(
                            event,
                            serviceNames(),
                          )}
                          session={props.session}
                        />
                      )}
                    </For>
                  </ul>
                  <Show when={canLoadMore()}>
                    <div style={{ "margin-top": "var(--tg-s-3)" }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        busy={events.loading}
                        onClick={() =>
                          setLimit((current) =>
                            Math.min(
                              current + ACTIVITY_PAGE_SIZE,
                              ACTIVITY_MAX_LIMIT,
                            ),
                          )
                        }
                      >
                        {t("common.loadMore")}
                      </Button>
                    </div>
                  </Show>
                  <Show when={atListCap()}>
                    <p class="muted">
                      {t("common.showingRecent", { n: list().length })}
                    </p>
                  </Show>
                </Card>
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </>
  );
}
