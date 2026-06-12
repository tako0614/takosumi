/**
 * Activity view (spec §31) — the Space-scoped audit trail.
 *
 * Lists recent {@link ActivityEvent}s for the current Space via
 * `GET /api/v1/spaces/:id/activity?limit=`. Each row shows the action verb,
 * the targeted entity, the actor, and the timestamp. Activity records WHAT
 * happened (names / ids / counts) and never secrets, so metadata is rendered as
 * compact key=value chips.
 */
import "../../styles/wave-a.css";
import { createResource, For, Match, Show, Switch } from "solid-js";
import { ScrollText } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ActivityEvent,
  type ControlApiError,
  listActivity,
} from "../../lib/control-api.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { Card } from "../../components/ui/Card.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";
import Skeleton from "../../components/ui/Skeleton.tsx";

const ACTIVITY_LIMIT = 100;

export default function ControlActivityView() {
  return <Page title="アクティビティ">{() => <Inner />}</Page>;
}

function MetadataChips(props: { metadata: Record<string, unknown> }) {
  const entries = () =>
    Object.entries(props.metadata).filter(([, v]) =>
      v !== null && v !== undefined && typeof v !== "object"
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
        <time>{props.event.createdAt}</time>
      </div>
      <MetadataChips metadata={props.event.metadata} />
    </li>
  );
}

function Inner() {
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [events] = createResource(
    spaceId,
    (id) => listActivity(id, ACTIVITY_LIMIT),
  );

  return (
    <AppShell>
      <PageHeader
        eyebrow="Activity"
        title="アクティビティ"
        subtitle="Space の監査証跡（最近の操作）です。"
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<ScrollText size={28} />}
            title="Space を選択してください"
            message="Space を選択するとアクティビティを表示します。"
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
              title="取得に失敗しました"
              message={(events.error as ControlApiError).message}
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
                    title="まだアクティビティがありません"
                    message="この Space で操作が行われると、ここに記録されます。"
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
