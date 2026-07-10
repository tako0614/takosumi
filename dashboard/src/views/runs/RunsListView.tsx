/**
 * Run history (`/runs`) — real Workspace Run ledger rows rendered as a plain
 * end-user update list, linking each row to the canonical `/runs/:id` detail.
 */
import "../../styles/app-views.css";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { Activity } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { listCapsulesCached } from "../../lib/capsule-list.ts";
import {
  type ControlApiError,
  listRuns,
  listSources,
  type Capsule,
  type Run,
  type RunStatus,
  type Source,
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

const RUN_LIST_PAGE_SIZE = 200;
/** Backend clamp (contract RUN_LIST_MAX_LIMIT) — asking for more is a no-op. */
const RUN_LIST_MAX_LIMIT = 500;

interface RunHistoryRow {
  readonly runId: string;
  readonly status: RunStatus;
  /** Row status shown to the user (`waiting_approval` while a succeeded
   * review run still waits on its deploy approval). */
  readonly displayStatus: RunStatus;
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
  const [limit, setLimit] = createSignal(RUN_LIST_PAGE_SIZE);
  const runsKey = () => {
    const id = workspaceId();
    return id ? ([id, limit()] as const) : null;
  };
  const [runs, { mutate: mutateRuns }] = createResource(runsKey, ([id, max]) =>
    listRuns(id, max),
  );
  // Load-more keeps the current rows on screen (reads `.latest`), but a
  // Workspace switch must not flash the previous Workspace's history — reset
  // the page size and drop the stale rows so the skeleton shows instead.
  createEffect(
    on(
      workspaceId,
      () => {
        setLimit(RUN_LIST_PAGE_SIZE);
        mutateRuns(undefined);
      },
      { defer: true },
    ),
  );
  // Include destroyed capsules so a run row for a since-deleted service still
  // shows which service it was.
  const [capsules] = createResource(workspaceId, (id) =>
    listCapsulesCached(id, { includeDestroyed: true }),
  );
  // Preparation runs (追加前の確認 …) carry a sourceId instead of a capsuleId;
  // resolve the registered Source name so those rows are attributable too.
  // Best-effort: a failed Source read must not blank the run history.
  const [sources] = createResource(workspaceId, async (id) => {
    try {
      return await listSources(id);
    } catch {
      return [];
    }
  });
  const capsuleNames = createMemo(() => {
    const map = new Map<string, string>();
    for (const capsule of capsules.error ? [] : (capsules.latest ?? [])) {
      map.set(capsule.id, capsule.name);
    }
    return map;
  });
  const rows = createMemo(() =>
    rowsFromRuns(
      runs.error ? [] : (runs.latest ?? []),
      capsules.error ? [] : (capsules.latest ?? []),
      capsuleNames(),
      sources.latest ?? [],
    ),
  );
  const initialLoading = () =>
    (runs.loading && !runs.error && !runs.latest) ||
    (capsules.loading && !capsules.error && !capsules.latest);
  const canLoadMore = () =>
    rows().length >= limit() && limit() < RUN_LIST_MAX_LIMIT;
  const atListCap = () =>
    limit() >= RUN_LIST_MAX_LIMIT && rows().length >= RUN_LIST_MAX_LIMIT;

  return (
    <>
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
          <Match when={initialLoading()}>
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
                      <Button variant="primary" href="/store">
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
                  <Show when={canLoadMore()}>
                    <div style={{ "margin-top": "var(--tg-s-3)" }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        busy={runs.loading}
                        onClick={() =>
                          setLimit((current) =>
                            Math.min(
                              current + RUN_LIST_PAGE_SIZE,
                              RUN_LIST_MAX_LIMIT,
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

function RunHistoryRowView(props: { readonly row: RunHistoryRow }) {
  // Rows repeat the same visible 詳細/確認する; the accessible name carries
  // the run title (+ service) so the buttons are distinguishable out of
  // context.
  const rowAriaTitle = () =>
    props.row.serviceName
      ? `${titleForRow(props.row)} — ${props.row.serviceName}`
      : titleForRow(props.row);
  return (
    <li class="av-run-history-row">
      <div class="av-run-history-main">
        <span class="av-run-history-title">{titleForRow(props.row)}</span>
        <Show when={props.row.serviceName}>
          {(name) => <span class="muted">{name()}</span>}
        </Show>
      </div>
      <StatusBadge
        status={props.row.displayStatus}
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
        aria-label={t(
          props.row.displayStatus === "waiting_approval"
            ? "runList.reviewAria"
            : "runList.openAria",
          { title: rowAriaTitle() },
        )}
      >
        {props.row.displayStatus === "waiting_approval"
          ? t("runList.review")
          : t("runList.open")}
      </Button>
    </li>
  );
}

/** The wire Run keeps the legacy `installationId` alias next to `capsuleId`
 * (backup runs record only the alias) — read both so those rows still name
 * their service. */
function runCapsuleId(run: Run): string | undefined {
  return (
    run.capsuleId ??
    (run as Run & { readonly installationId?: string }).installationId
  );
}

/**
 * True when a succeeded review run (plan / destroy_plan) is still waiting on
 * the user's deploy approval: policy passed, and no apply / destroy_apply for
 * the same Capsule has been created at/after it (mirrors the condition under
 * which RunView renders the デプロイを実行 CTA). Presented as 承認待ち so the
 * list agrees with the notification wording instead of claiming 成功.
 */
function awaitsDeployApproval(run: Run, runs: readonly Run[]): boolean {
  if (run.type !== "plan" && run.type !== "destroy_plan") return false;
  if (run.status !== "succeeded") return false;
  if (run.policyStatus !== "pass") return false;
  const planCapsuleId = runCapsuleId(run);
  if (!planCapsuleId) return false;
  const planCreatedAt = Date.parse(run.createdAt);
  return !runs.some((candidate) => {
    if (candidate.type !== "apply" && candidate.type !== "destroy_apply") {
      return false;
    }
    if (runCapsuleId(candidate) !== planCapsuleId) return false;
    if (Number.isNaN(planCreatedAt)) return true;
    const candidateCreatedAt = Date.parse(candidate.createdAt);
    return Number.isNaN(candidateCreatedAt)
      ? true
      : candidateCreatedAt >= planCreatedAt;
  });
}

function rowsFromRuns(
  runs: readonly Run[],
  capsules: readonly Capsule[],
  names: ReadonlyMap<string, string>,
  sources: readonly Source[],
): readonly RunHistoryRow[] {
  const fallbackNames = new Map(
    capsules.map((capsule) => [capsule.id, capsule.name]),
  );
  const sourceNames = new Map(
    sources.map((source) => [source.id, source.name]),
  );
  return [...runs]
    .map((run): RunHistoryRow => {
      const capsuleId = runCapsuleId(run);
      const serviceName = capsuleId
        ? (names.get(capsuleId) ?? fallbackNames.get(capsuleId))
        : run.sourceId
          ? sourceNames.get(run.sourceId)
          : undefined;
      return {
        runId: run.id,
        status: run.status,
        displayStatus: awaitsDeployApproval(run, runs)
          ? "waiting_approval"
          : run.status,
        operation: run.type,
        ...(capsuleId ? { capsuleId } : {}),
        ...(serviceName ? { serviceName } : {}),
        createdAt: run.createdAt,
        ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function rowAriaTitle(row: RunHistoryRow): string {
  const title = titleForRow(row);
  return row.serviceName ? `${title} — ${row.serviceName}` : title;
}

function titleForRow(row: RunHistoryRow): string {
  if (row.status === "failed") {
    return t("runList.failed", { operation: operationLabel(row.operation) });
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
