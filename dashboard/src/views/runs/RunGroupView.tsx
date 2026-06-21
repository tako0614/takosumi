/**
 * RunGroup view (`/run-groups/:id`) — a grouped update: multiple Runs ordered
 * across the dependency DAG (e.g. a Space update after stale propagation).
 * Shows the group status + ordered member list and offers a one-shot
 * "approve all" (`POST /api/v1/run-groups/:id/approve`).
 */
import "../../styles/wave-a.css";
import "../../styles/wave-b.css";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useParams } from "@solidjs/router";
import { Layers } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import {
  approveRunGroup,
  type ControlApiError,
  getRunGroup,
  type Run,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import { operationLabel, runStatusLabel, runTone } from "../../lib/labels.ts";
import { t } from "../../i18n/index.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import Button from "../../components/ui/Button.tsx";
import { Card, CardHeader } from "../../components/ui/Card.tsx";
import { Badge, StatusBadge } from "../../components/ui/Badge.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";
import Skeleton from "../../components/ui/Skeleton.tsx";

export default function RunGroupView() {
  return <Page title={t("runGroup.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams();
  const groupId = () => params.id ?? "";

  const [group, { refetch }] = createResource(groupId, getRunGroup);

  const anyWaiting = createMemo(() =>
    (group()?.runs ?? []).some((r) => r.status === "waiting_approval"),
  );

  const approveAll = createAction(async () => {
    await approveRunGroup(groupId());
    await refetch();
  });

  return (
    <AppShell>
      <PageHeader
        title={t("runGroup.title")}
        subtitle={t("runGroup.subtitle")}
        actions={
          <Button variant="ghost" href="/">
            {t("app.backToList")}
          </Button>
        }
      />

      <Switch>
        <Match when={group.loading}>
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
    </AppShell>
  );
}

function RunGroupMemberRow(props: { readonly run: Run }) {
  const run = () => props.run;
  return (
    <li class="wa-run-group-row">
      <div class="wa-run-group-main">
        <Show
          when={run().installationId}
          fallback={<span class="muted">{t("common.unknown")}</span>}
        >
          {(id) => (
            <a
              class="wa-run-group-service"
              href={`/capsules/${encodeURIComponent(id())}`}
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
      <details class="wb-disclosure wa-run-group-details">
        <summary>{t("run.details.title")}</summary>
        <div class="wb-stack-sm">
          <div>
            <span class="muted">{t("run.details.runId")}</span>
            <div>
              <a href={`/runs/${run().id}`}>
                <code>{run().id}</code>
              </a>
            </div>
          </div>
          <Show when={run().installationId}>
            {(id) => (
              <div>
                <span class="muted">{t("app.installationSub")}</span>
                <div>
                  <code>{id()}</code>
                </div>
              </div>
            )}
          </Show>
        </div>
      </details>
    </li>
  );
}
