/**
 * Run history (`/runs`) — real Workspace activity projected into a plain run
 * list. The control API does not expose a dedicated list-runs endpoint yet, so
 * this view uses the Activity ledger rows that already carry public-safe run
 * ids and metadata, then links each row to the canonical `/runs/:id` detail.
 */
import "../../styles/app-views.css";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { Activity } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId } from "../../lib/space-state.ts";
import {
  type ActivityEvent,
  type ControlApiError,
  listActivity,
  listInstallations,
  type Installation,
  type RunStatus,
} from "../../lib/control-api.ts";
import { operationLabel, runStatusLabel, runTone } from "../../lib/labels.ts";
import { formatDateTime, t } from "../../i18n/index.ts";
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  StatusBadge,
  Toast,
} from "../../components/ui/index.ts";

const RUN_ACTIVITY_LIMIT = 200;
const RUN_ACTIONS = new Set([
  "run.plan_created",
  "run.approved",
  "run.applied",
  "run.destroyed",
  "run.failed",
]);

interface RunHistoryRow {
  readonly runId: string;
  readonly action: string;
  readonly status: RunStatus;
  readonly operation: string;
  readonly installationId?: string;
  readonly serviceName?: string;
  readonly createdAt: string;
  readonly errorCode?: string;
}

export default function RunsListView() {
  return <Page title={t("runList.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const spaceId = () => currentSpaceId() || null;
  const [events] = createResource(spaceId, (id) =>
    listActivity(id, RUN_ACTIVITY_LIMIT),
  );
  const [installations] = createResource(spaceId, listInstallations);
  const installationNames = createMemo(() => {
    const map = new Map<string, string>();
    for (const installation of installations() ?? []) {
      map.set(installation.id, installation.name);
    }
    return map;
  });
  const rows = createMemo(() =>
    rowsFromActivity(
      events() ?? [],
      installations() ?? [],
      installationNames(),
    ),
  );

  return (
    <AppShell>
      <PageHeader title={t("runList.title")} subtitle={t("runList.subtitle")} />
      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            icon={<Activity size={28} />}
            title={t("space.select")}
            message={t("space.selectMessage")}
          />
        }
      >
        <Switch>
          <Match when={events.loading || installations.loading}>
            <Card>
              <Skeleton variant="row" count={6} />
            </Card>
          </Match>
          <Match when={events.error || installations.error}>
            <Toast tone="error">
              {t("common.fetchFailed", {
                message: errorMessage(events.error ?? installations.error),
              })}
            </Toast>
          </Match>
          <Match when={rows()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <EmptyState
                    icon={<Activity size={28} />}
                    title={t("runList.empty.title")}
                    message={t("runList.empty.message")}
                    action={
                      <Button variant="primary" href="/new">
                        {t("apps.add")}
                      </Button>
                    }
                  />
                }
              >
                <Card>
                  <ul class="av-run-history">
                    <For each={list()}>
                      {(row) => <RunHistoryRowView row={row} />}
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

function RunHistoryRowView(props: { readonly row: RunHistoryRow }) {
  return (
    <li class="av-run-history-row">
      <div class="av-run-history-main">
        <span class="av-run-history-title">{titleForRow(props.row)}</span>
        <Show when={props.row.serviceName}>
          {(name) => <span class="muted">{name()}</span>}
        </Show>
      </div>
      <StatusBadge
        status={props.row.status}
        label={runStatusLabel}
        tone={runTone}
      />
      <time class="av-run-history-time" datetime={props.row.createdAt}>
        {formatDateTime(props.row.createdAt)}
      </time>
      <Button
        variant="secondary"
        size="sm"
        href={`/runs/${encodeURIComponent(props.row.runId)}`}
      >
        {t("runList.open")}
      </Button>
    </li>
  );
}

function rowsFromActivity(
  events: readonly ActivityEvent[],
  installations: readonly Installation[],
  names: ReadonlyMap<string, string>,
): readonly RunHistoryRow[] {
  const rows = new Map<string, RunHistoryRow>();
  const fallbackNames = new Map(
    installations.map((installation) => [installation.id, installation.name]),
  );
  for (const event of events) {
    if (!RUN_ACTIONS.has(event.action)) continue;
    const runId = runIdFromEvent(event);
    if (!runId) continue;
    const installationId = metaString(event.metadata, "installationId");
    const row: RunHistoryRow = {
      runId,
      action: event.action,
      status: statusFromAction(event.action),
      operation: operationFromEvent(event),
      ...(installationId ? { installationId } : {}),
      ...(installationId
        ? {
            serviceName:
              names.get(installationId) ?? fallbackNames.get(installationId),
          }
        : {}),
      createdAt: event.createdAt,
      ...(metaString(event.metadata, "errorCode")
        ? { errorCode: metaString(event.metadata, "errorCode") }
        : {}),
    };
    const previous = rows.get(runId);
    if (!previous || previous.createdAt < row.createdAt) {
      rows.set(runId, row);
    }
  }
  return [...rows.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

function runIdFromEvent(event: ActivityEvent): string | undefined {
  if (event.runId) return event.runId;
  if (event.targetType === "run") return event.targetId;
  return (
    metaString(event.metadata, "runId") ??
    metaString(event.metadata, "planRunId") ??
    metaString(event.metadata, "applyRunId")
  );
}

function statusFromAction(action: string): RunStatus {
  switch (action) {
    case "run.failed":
      return "failed";
    case "run.plan_created":
      return "waiting_approval";
    case "run.approved":
      return "running";
    case "run.applied":
    case "run.destroyed":
      return "succeeded";
    default:
      return "queued";
  }
}

function operationFromEvent(event: ActivityEvent): string {
  return (
    metaString(event.metadata, "operation") ??
    metaString(event.metadata, "phase") ??
    event.action
  );
}

function titleForRow(row: RunHistoryRow): string {
  if (row.action === "run.failed" && row.errorCode) {
    return t("runList.failedWithCode", {
      operation: operationLabel(row.operation),
      code: row.errorCode,
    });
  }
  if (row.action === "run.applied") return t("runList.applied");
  if (row.action === "run.destroyed") return t("runList.destroyed");
  return operationLabel(row.operation);
}

function metaString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as ControlApiError).message;
    if (typeof message === "string") return message;
  }
  return t("common.unknown");
}
