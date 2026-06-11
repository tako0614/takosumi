/**
 * Activity view (spec §31) — the Space-scoped audit trail.
 *
 * Lists recent {@link ActivityEvent}s for the current Space via
 * `GET /api/v1/spaces/:id/activity?limit=`. Each row shows the action verb,
 * the targeted entity, the actor, and the timestamp. Activity records WHAT
 * happened (names / ids / counts) and never secrets, so metadata is rendered as
 * compact key=value chips.
 */
import { createResource, For, Match, Show, Switch } from "solid-js";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ActivityEvent,
  type ControlApiError,
  listActivity,
} from "../../lib/control-api.ts";

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
      <div class="activity-meta">
        <For each={entries()}>
          {([k, v]) => (
            <span class="activity-meta-chip">
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
    <li class="activity-row">
      <div class="activity-row-head">
        <code class="activity-action">{props.event.action}</code>
        <span class="muted activity-target">
          {props.event.targetType} · {props.event.targetId}
        </span>
      </div>
      <div class="activity-row-meta muted">
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
      <div class="page-header">
        <h1>アクティビティ</h1>
        <p class="page-sub">Space の監査証跡（最近の操作）です。</p>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択するとアクティビティを表示します。</p>
          </section>
        }
      >
        <Switch>
          <Match when={events.loading}>
            <div class="grid-skel"><div class="skel-block" /></div>
          </Match>
          <Match when={events.error}>
            <section class="empty-state error-state">
              <p>取得に失敗しました — {(events.error as ControlApiError).message}</p>
            </section>
          </Match>
          <Match when={events()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <section class="empty-state">
                    <p>まだアクティビティがありません。</p>
                  </section>
                }
              >
                <ul class="activity-list">
                  <For each={list()}>
                    {(event) => <ActivityRow event={event} />}
                  </For>
                </ul>
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}
