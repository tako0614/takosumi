/**
 * Run history (`/runs`) — real Workspace Run ledger rows rendered as a plain
 * end-user update list, linking each row to the canonical `/runs/:id` detail.
 */
import "../../styles/app-views.css";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { Activity } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { listCapsulesCached } from "../../lib/capsule-list.ts";
import {
  type ControlApiError,
  listRuns,
  type Capsule,
  type Run,
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

const RUN_LIST_LIMIT = 200;

interface RunHistoryRow {
  readonly runId: string;
  readonly status: RunStatus;
  readonly operation: string;
  readonly capsuleId?: string;
  readonly serviceName?: string;
  readonly createdAt: string;
  readonly errorCode?: string;
}

export default function RunsListView() {
  return <Page title={t("runList.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const workspaceId = () => currentWorkspaceId() || null;
  const [runs] = createResource(workspaceId, (id) => listRuns(id, RUN_LIST_LIMIT));
  const [capsules] = createResource(workspaceId, (id) =>
    listCapsulesCached(id, { includeDestroyed: false }),
  );
  const capsuleNames = createMemo(() => {
    const map = new Map<string, string>();
    for (const capsule of capsules() ?? []) {
      map.set(capsule.id, capsule.name);
    }
    return map;
  });
  const rows = createMemo(() =>
    rowsFromRuns(runs() ?? [], capsules() ?? [], capsuleNames()),
  );

  return (
    <AppShell>
      <PageHeader title={t("runList.title")} subtitle={t("runList.subtitle")} />
      <Show
        when={workspaceId()}
        fallback={
          <EmptyState
            icon={<Activity size={28} />}
            title={t("workspace.select")}
            message={t("workspace.selectMessage")}
          />
        }
      >
        <Switch>
          <Match when={runs.loading || capsules.loading}>
            <Card>
              <Skeleton variant="row" count={6} />
            </Card>
          </Match>
          <Match when={runs.error || capsules.error}>
            <Toast tone="error">
              {t("common.fetchFailed", {
                message: errorMessage(runs.error ?? capsules.error),
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

function rowsFromRuns(
  runs: readonly Run[],
  capsules: readonly Capsule[],
  names: ReadonlyMap<string, string>,
): readonly RunHistoryRow[] {
  const fallbackNames = new Map(
    capsules.map((capsule) => [capsule.id, capsule.name]),
  );
  return [...runs]
    .map((run): RunHistoryRow => {
      const capsuleId = run.capsuleId;
      return {
        runId: run.id,
        status: run.status,
        operation: run.type,
        ...(capsuleId ? { capsuleId } : {}),
        ...(capsuleId
          ? {
              serviceName:
                names.get(capsuleId) ?? fallbackNames.get(capsuleId),
            }
          : {}),
        createdAt: run.createdAt,
        ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function titleForRow(row: RunHistoryRow): string {
  if (row.status === "failed" && row.errorCode) {
    return t("runList.failedWithCode", {
      operation: operationLabel(row.operation),
      code: row.errorCode,
    });
  }
  if (row.operation === "apply") return t("runList.applied");
  if (row.operation === "destroy_apply") return t("runList.destroyed");
  return operationLabel(row.operation);
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
