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
import { awaitsDeployApproval, runCapsuleId } from "../../lib/run-approval.ts";
import { operationLabel, runStatusLabel, runTone } from "../../lib/labels.ts";
import { formatDateTime, t } from "../../i18n/index.ts";
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  StatusBadge,
} from "../../components/ui/index.ts";

const RUN_LIST_PAGE_SIZE = 200;
/** Backend clamp (contract RUN_LIST_MAX_LIMIT) — asking for more is a no-op. */
const RUN_LIST_MAX_LIMIT = 500;

interface RunHistoryRow {
  readonly runId: string;
  readonly status: RunStatus;
  /** Row status shown to the user. A succeeded review run still awaiting its
   * deploy is already approved/passed, so it reads the synthetic
   * `ready_to_deploy` (実行待ち) rather than the backend `waiting_approval`
   * (承認待ち) — the remaining step is execution, not approval. */
  readonly displayStatus: RunStatus | "ready_to_deploy";
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
  const [runs, { mutate: mutateRuns, refetch: refetchRuns }] = createResource(
    runsKey,
    ([id, max]) => listRuns(id, max),
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
          {/* Only a failed RUN read blanks the history — the secondary
              capsule-name lookup failing merely drops the names (rows already
              tolerate an absent name), with a quiet notice below. */}
          <Match when={runs.error}>
            <EmptyState
              icon={<Activity size={28} />}
              title={t("runList.title")}
              message={t("common.fetchFailed", {
                message: errorMessage(runs.error),
              })}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => void refetchRuns()}
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
                  <Show when={capsules.error}>
                    <p class="muted">{t("runList.namesUnavailable")}</p>
                  </Show>
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
  // Both the real waiting_approval status and the synthetic ready_to_deploy
  // (実行待ち) open the run to review + deploy, so both get 確認する.
  const reviewable = () =>
    props.row.displayStatus === "waiting_approval" ||
    props.row.displayStatus === "ready_to_deploy";
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
          reviewable() ? "runList.reviewAria" : "runList.openAria",
          { title: rowAriaTitle() },
        )}
      >
        {reviewable() ? t("runList.review") : t("runList.open")}
      </Button>
    </li>
  );
}

// The 承認待ち presentation (a succeeded review run whose deploy approval no
// apply attempt has consumed) derives from the SHARED predicate in
// lib/run-approval.ts — the same one RunView's badge + deploy CTA use — so the
// list and the run screen can never disagree about an open approval.

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
          ? "ready_to_deploy"
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
