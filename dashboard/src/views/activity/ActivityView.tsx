/**
 * History view — the Workspace-scoped activity feed. The default row is
 * plain-language; raw action/target/metadata remains available in a disclosure
 * for support and audit work.
 */
import "../../styles/wave-a.css";
import "../../styles/wave-b.css";
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
import { operationLabel } from "../../lib/labels.ts";
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

function metaString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function activityTitle(event: ActivityEvent): string {
  const metadata = event.metadata ?? {};
  switch (event.action) {
    case "installation.created":
      return t("notif.event.installCreated", {
        name: metaString(metadata, "name") ?? "—",
      });
    case "run.plan_created":
      return t("notif.event.planReady", {
        operation: operationLabel(metaString(metadata, "operation")),
      });
    case "run.approved":
      return t("notif.event.approved", {
        operation: operationLabel(metaString(metadata, "operation")),
      });
    case "run.applied":
      return t("notif.event.applied");
    case "run.destroyed":
      return t("notif.event.destroyed");
    case "run.failed":
      return t("notif.event.failed", {
        operation: operationLabel(metaString(metadata, "phase")),
      });
    case "connection.created":
      return metaString(metadata, "provider")
        ? t("notif.event.connCreated", {
            provider: metaString(metadata, "provider")!,
          })
        : t("notif.event.connCreatedGeneric");
    case "connection.revoked":
      return metaString(metadata, "provider")
        ? t("notif.event.connRevoked", {
            provider: metaString(metadata, "provider")!,
          })
        : t("notif.event.connRevokedGeneric");
    case "backup.created":
      return t("notif.event.backupCreated");
    case "dependency.created":
      return t("notif.event.depCreated");
    case "dependency.deleted":
      return t("notif.event.depDeleted");
    case "output_share.created":
      return t("notif.event.shareRequested");
    case "output_share.approved":
      return t("notif.event.shareApproved");
    case "output_share.revoked":
      return t("notif.event.shareRevoked");
    case "run_group.created":
      return t("notif.event.groupCreated");
    default:
      return event.action;
  }
}

function ActivityRow(props: { event: ActivityEvent }) {
  return (
    <li class="wa-activity-row">
      <div class="wa-activity-head">
        <span class="wa-activity-action">{activityTitle(props.event)}</span>
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
      <details class="wb-disclosure">
        <summary>{t("activity.details")}</summary>
        <div class="wa-meta">
          <span class="wa-meta-chip">
            <span class="muted">action</span>=<code>{props.event.action}</code>
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
