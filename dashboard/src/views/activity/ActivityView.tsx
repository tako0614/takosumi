/**
 * Activity view — the Workspace-scoped audit trail (the raw, expert counterpart
 * of the notifications feed). Lists recent {@link ActivityEvent}s for the
 * current Workspace via the current compatibility route. Each row shows the raw
 * action verb, the targeted entity, the actor, and the timestamp; metadata is
 * rendered as compact key=value chips (never secrets).
 */
import "../../styles/wave-a.css";
import { createResource, For, Match, Show, Switch } from "solid-js";
import { ScrollText } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId } from "../../lib/space-state.ts";
import {
  type ActivityEvent,
  type ControlApiError,
  listActivity,
} from "../../lib/control-api.ts";
import { formatDateTime, t } from "../../i18n/index.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { Card } from "../../components/ui/Card.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";
import Skeleton from "../../components/ui/Skeleton.tsx";

const ACTIVITY_LIMIT = 100;

export default function ActivityView() {
  return <Page title={t("activity.title")}>{() => <Inner />}</Page>;
}

function MetadataChips(props: { metadata: Record<string, unknown> }) {
  const entries = () =>
    Object.entries(props.metadata).filter(
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

function ActivityRow(props: { event: ActivityEvent }) {
  return (
    <li class="wa-activity-row">
      <div class="wa-activity-head">
        <code class="wa-activity-action">{props.event.action}</code>
        <span class="wa-activity-target">
          {props.event.targetType} · {props.event.targetId}
        </span>
      </div>
      <div class="wa-activity-rowmeta">
        <Show when={props.event.actorId}>
          <span>{props.event.actorId}</span>
          <span>·</span>
        </Show>
        <time datetime={props.event.createdAt}>
          {formatDateTime(props.event.createdAt)}
        </time>
      </div>
      <MetadataChips metadata={props.event.metadata} />
    </li>
  );
}

function Inner() {
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [events] = createResource(spaceId, (id) =>
    listActivity(id, ACTIVITY_LIMIT),
  );

  return (
    <AppShell>
      <PageHeader
        title={t("activity.title")}
        subtitle={t("activity.subtitle")}
      />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<ScrollText size={28} />}
            title={t("space.select")}
            message={t("space.selectMessage")}
          />
        }
      >
        <Switch>
          <Match when={events.loading}>
            <Card>
              <Skeleton variant="row" count={5} />
            </Card>
          </Match>
          <Match when={events.error}>
            <EmptyState
              icon={<ScrollText size={28} />}
              title={t("activity.title")}
              message={t("common.fetchFailed", {
                message: (events.error as ControlApiError).message,
              })}
            />
          </Match>
          <Match when={events()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <EmptyState
                    ink
                    icon={<ScrollText size={28} />}
                    title={t("activity.empty.title")}
                    message={t("activity.empty.message")}
                  />
                }
              >
                <Card>
                  <ul class="wa-activity">
                    <For each={list()}>
                      {(event) => <ActivityRow event={event} />}
                    </For>
                  </ul>
                </Card>
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}
