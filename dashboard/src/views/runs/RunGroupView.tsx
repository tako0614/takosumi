/**
 * RunGroup view (`/run-groups/:id`) — a grouped update: multiple Runs ordered
 * across the dependency DAG (e.g. a Workspace update after stale propagation).
 * Shows the group status + ordered member list and offers a one-shot
 * "approve all" (`POST /api/v1/run-groups/:id/approve`).
 */
import "../../styles/wave-a.css";
import "../../styles/wave-b.css";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { Layers } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import {
  approveRunGroup,
  type ControlApiError,
  getRunGroup,
  type Run,
  type RunGroupWithRuns,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  clearCapsuleListCache,
  listCapsulesCached,
} from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { clearInstallConfigListCache } from "../../lib/install-config-list.ts";
import { runCapsuleId } from "../../lib/run-approval.ts";
import { operationLabel, runStatusLabel, runTone } from "../../lib/labels.ts";
import { isTerminalRunStatus } from "../../lib/run-logs.ts";
import { t } from "../../i18n/index.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import Button from "../../components/ui/Button.tsx";
import { Card, CardHeader } from "../../components/ui/Card.tsx";
import { Badge, StatusBadge } from "../../components/ui/Badge.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";
import Skeleton from "../../components/ui/Skeleton.tsx";

const RUN_GROUP_POLL_MS = 5_000;

export default function RunGroupView() {
  return <Page title={t("runGroup.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams();
  const groupId = () => params.id ?? "";

  const [group, { refetch }] = createResource(groupId, getRunGroup);
  // Last GOOD payload: an errored resource throws on read, and one transient
  // poll failure must neither blank the member list nor stop the poll — keep
  // rendering this snapshot and surface a quiet inline notice instead. The
  // EmptyState below is reserved for a failed INITIAL load.
  const [snapshot, setSnapshot] = createSignal<RunGroupWithRuns | undefined>();
  createEffect(() => {
    if (group.error) return;
    const latest = group.latest;
    if (latest) setSnapshot(latest);
  });
  const clearLauncherCaches = (workspaceId: string | undefined): void => {
    if (!workspaceId) return;
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
    clearInstallConfigListCache(workspaceId);
  };

  const anyWaiting = createMemo(() =>
    (snapshot()?.runs ?? []).some((r) => r.status === "waiting_approval"),
  );

  // A grouped update executes over minutes — a single static read would never
  // show members progressing to デプロイ済み. Mirror RunView's fallback poll:
  // refetch every ~5s while any member run is non-terminal, pause on a hidden
  // tab (refetch on return), stop once every member has settled. Reads the
  // snapshot, so a transient refetch error keeps the poll alive.
  const anyMemberActive = createMemo(() => {
    const current = snapshot();
    if (!current) return false;
    return current.runs.some((r) => !isTerminalRunStatus(r.status));
  });
  const [pageVisible, setPageVisible] = createSignal(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  if (typeof document !== "undefined") {
    const onVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      setPageVisible(visible);
      if (visible && anyMemberActive()) void refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );
  }
  createEffect(() => {
    // Re-arm after every settle so the poll chains (state flips
    // ready → refreshing → ready on each cycle and never throws).
    void group.state;
    if (!pageVisible() || !anyMemberActive()) return;
    const timer = setTimeout(() => void refetch(), RUN_GROUP_POLL_MS);
    onCleanup(() => clearTimeout(timer));
  });

  // Member service names (best-effort): the Run payload carries only the
  // Capsule id, so resolve names from the cached Workspace capsule list —
  // rows and their links must be distinguishable per service, not five
  // identical サービスを開く/変更内容を開く.
  const [capsules] = createResource(
    () => snapshot()?.runGroup.workspaceId ?? null,
    (id) => listCapsulesCached(id, { includeDestroyed: true }),
  );
  const capsuleNames = createMemo(() => {
    const map = new Map<string, string>();
    for (const capsule of capsules.error ? [] : (capsules.latest ?? [])) {
      map.set(capsule.id, capsule.name);
    }
    return map;
  });

  // AT-visible progress: member statuses flip silently in the list — mirror
  // the count into one polite live line ("5 件中 3 件が完了").
  const doneCount = createMemo(
    () =>
      (snapshot()?.runs ?? []).filter((r) => isTerminalRunStatus(r.status))
        .length,
  );
  const totalCount = createMemo(() => snapshot()?.runs.length ?? 0);

  // The manual 更新 button must go busy ONLY for a user-initiated refresh —
  // tying it to group.loading made it flicker (and evict focus) on every 5s
  // poll refetch.
  const [manualRefreshing, setManualRefreshing] = createSignal(false);
  const manualRefresh = async (): Promise<void> => {
    setManualRefreshing(true);
    try {
      await refetch();
    } catch {
      // Rendered via group.error / the inline refresh notice.
    } finally {
      setManualRefreshing(false);
    }
  };

  const approveAll = createAction(async () => {
    await approveRunGroup(groupId());
    await refetch();
    // The grouped apply changes multiple capsules — mirror RunView and drop
    // the launcher projections so the home tiles reflect it without a reload.
    clearLauncherCaches(snapshot()?.runGroup.workspaceId);
  });

  return (
    <>
      <PageHeader
        title={t("runGroup.title")}
        subtitle={t("runGroup.subtitle")}
        actions={
          <>
            <Button
              variant="secondary"
              type="button"
              busy={manualRefreshing()}
              onClick={() => void manualRefresh()}
            >
              {t("common.refresh")}
            </Button>
            <Button variant="ghost" href="/">
              {t("app.backToList")}
            </Button>
          </>
        }
      />

      <Switch>
        <Match when={!snapshot() && group.loading && !group.error}>
          <Card>
            <Skeleton variant="block" />
          </Card>
        </Match>
        {/* Initial load failed — nothing to render yet. A refetch error while
            a snapshot exists falls through to the content match below. */}
        <Match when={group.error && !snapshot()}>
          <EmptyState
            icon={<Layers size={28} />}
            title={t("runGroup.title")}
            message={t("common.fetchFailed", {
              message: (group.error as ControlApiError).message,
            })}
            action={
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void manualRefresh()}
              >
                {t("common.retry")}
              </Button>
            }
          />
        </Match>
        <Match when={snapshot()}>
          {(g) => {
            return (
              <div class="wa-stack">
                {/* One polite line so member-status transitions are not
                    silent to assistive tech (the visible badges swap with no
                    announcement). */}
                <Show when={totalCount() > 0}>
                  <p class="sr-only" role="status" aria-live="polite">
                    {t("runGroup.progressStatus", {
                      done: doneCount(),
                      total: totalCount(),
                    })}
                  </p>
                </Show>
                <Show when={group.error}>
                  <p class="wa-notice" role="alert">
                    {t("runGroup.refreshFailed")}
                  </p>
                </Show>
                <Card>
                  <CardHeader
                    title={
                      <span class="wa-title-row">
                        {t("runGroup.title")}
                        <Show when={g().runGroup.status}>
                          <StatusBadge
                            status={g().runGroup.status}
                            label={runStatusLabel}
                            tone={runTone}
                          />
                        </Show>
                      </span>
                    }
                    actions={
                      <Show when={anyWaiting()}>
                        <Button
                          variant="primary"
                          type="button"
                          busy={approveAll.busy()}
                          onClick={() => void approveAll.run()}
                        >
                          {approveAll.busy()
                            ? t("run.approving")
                            : t("runGroup.approveAll")}
                        </Button>
                      </Show>
                    }
                  />
                  <details class="wb-disclosure">
                    <summary>{t("run.details.title")}</summary>
                    <div class="wb-stack-sm">
                      <div>
                        <span class="muted">{t("runGroup.groupId")}</span>
                        <div>
                          <code>{g().runGroup.id}</code>
                        </div>
                      </div>
                      <Show when={g().runGroup.type}>
                        {(type) => (
                          <div>
                            <span class="muted">{t("run.details.type")}</span>
                            <div>
                              <code>{type()}</code>
                            </div>
                          </div>
                        )}
                      </Show>
                    </div>
                  </details>
                  <Show when={approveAll.error()}>
                    {(m) => (
                      <p class="wa-error" role="alert">
                        {m()}
                      </p>
                    )}
                  </Show>
                </Card>

                <Card>
                  <CardHeader
                    title={
                      <span class="wa-title-row">
                        {t("runGroup.members")}
                        <Badge tone="muted">{g().runs.length}</Badge>
                      </span>
                    }
                  />
                  <Show
                    when={g().runs.length > 0}
                    fallback={<p class="muted">{t("runGroup.membersEmpty")}</p>}
                  >
                    <ul class="wa-run-group-list">
                      <For each={g().runs}>
                        {(run) => (
                          <RunGroupMemberRow
                            run={run}
                            serviceName={capsuleNames().get(
                              runCapsuleId(run) ?? "",
                            )}
                          />
                        )}
                      </For>
                    </ul>
                  </Show>
                </Card>
              </div>
            );
          }}
        </Match>
      </Switch>
    </>
  );
}

function RunGroupMemberRow(props: {
  readonly run: Run;
  readonly serviceName?: string | undefined;
}) {
  const run = () => props.run;
  const name = () => props.serviceName;
  return (
    <li class="wa-run-group-row">
      <div class="wa-run-group-main">
        <Show
          when={runCapsuleId(run())}
          fallback={<span class="muted">{t("common.unknown")}</span>}
        >
          {(id) => (
            /* The resolved service NAME is the visible link text — five rows
               of identical サービスを開く are indistinguishable both visually
               and to a screen reader; the aria-label keeps the action verb. */
            <a
              class="wa-run-group-service"
              href={`/services/${encodeURIComponent(id())}`}
              aria-label={
                name()
                  ? t("runGroup.openServiceAria", { name: name()! })
                  : undefined
              }
            >
              {name() ?? t("runGroup.openService")}
            </a>
          )}
        </Show>
        <span class="wa-run-group-change">{operationLabel(run().type)}</span>
      </div>
      <StatusBadge
        status={run().status}
        label={runStatusLabel}
        tone={runTone}
      />
      <a
        class="wa-run-group-review"
        href={`/runs/${run().id}`}
        aria-label={
          name() ? t("runGroup.openRunAria", { name: name()! }) : undefined
        }
      >
        {t("runGroup.openRun")}
      </a>
    </li>
  );
}
