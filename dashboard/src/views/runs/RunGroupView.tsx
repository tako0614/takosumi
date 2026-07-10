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
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
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
  const clearLauncherCaches = (workspaceId: string | undefined): void => {
    if (!workspaceId) return;
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
  };

  const anyWaiting = createMemo(() =>
    (group()?.runs ?? []).some((r) => r.status === "waiting_approval"),
  );

  // A grouped update executes over minutes — a single static read would never
  // show members progressing to デプロイ済み. Mirror RunView's fallback poll:
  // refetch every ~5s while any member run is non-terminal, pause on a hidden
  // tab (refetch on return), stop once every member has settled.
  const anyMemberActive = createMemo(() => {
    // An errored resource throws on read — a failed fetch simply stops the
    // poll (the error state renders below; the refresh button restarts it).
    if (group.error) return false;
    const current = group.latest;
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

  const approveAll = createAction(async () => {
    await approveRunGroup(groupId());
    await refetch();
    // The grouped apply changes multiple capsules — mirror RunView and drop
    // the launcher projections so the home tiles reflect it without a reload.
    clearLauncherCaches(group()?.runGroup.workspaceId);
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
              busy={group.loading}
              onClick={() => void refetch()}
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
        <Match when={group.loading && !group.error && !group.latest}>
          <Card>
            <Skeleton variant="block" />
          </Card>
        </Match>
        <Match when={group.error}>
          <EmptyState
            icon={<Layers size={28} />}
            title={t("runGroup.title")}
            message={t("common.fetchFailed", {
              message: (group.error as ControlApiError).message,
            })}
          />
        </Match>
        <Match when={group()}>
          {(g) => {
            return (
              <div class="wa-stack">
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
                        {(run) => <RunGroupMemberRow run={run} />}
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

function RunGroupMemberRow(props: { readonly run: Run }) {
  const run = () => props.run;
  return (
    <li class="wa-run-group-row">
      <div class="wa-run-group-main">
        <Show
          when={run().capsuleId}
          fallback={<span class="muted">{t("common.unknown")}</span>}
        >
          {(id) => (
            <a
              class="wa-run-group-service"
              href={`/services/${encodeURIComponent(id())}`}
            >
              {t("runGroup.openService")}
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
      <a class="wa-run-group-review" href={`/runs/${run().id}`}>
        {t("runGroup.openRun")}
      </a>
    </li>
  );
}
