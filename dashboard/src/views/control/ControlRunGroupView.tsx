/**
 * RunGroup view (`/run-groups/:id`) — a grouped update: multiple Runs ordered
 * across the dependency DAG (e.g. a Space update after stale propagation).
 * Shows the group status + ordered member list and offers a one-shot
 * "approve all" (`POST /api/v1/run-groups/:id/approve`).
 */
import "../../styles/wave-a.css";
import { createMemo, createResource, Match, Show, Switch } from "solid-js";
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
import {
  operationLabel,
  runStatusLabel,
  runTone,
} from "../../lib/labels.ts";
import { t } from "../../i18n/index.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import Button from "../../components/ui/Button.tsx";
import { Card, CardHeader } from "../../components/ui/Card.tsx";
import { Badge, StatusBadge } from "../../components/ui/Badge.tsx";
import KVList, { type KVItem } from "../../components/ui/KVList.tsx";
import DataTable, { type Column } from "../../components/ui/DataTable.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";
import Skeleton from "../../components/ui/Skeleton.tsx";

export default function ControlRunGroupView() {
  return <Page title={t("runGroup.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams();
  const groupId = () => params.id ?? "";

  const [group, { refetch }] = createResource(groupId, getRunGroup);

  const anyWaiting = createMemo(() =>
    (group()?.runs ?? []).some((r) => r.status === "waiting_approval")
  );

  const approveAll = createAction(async () => {
    await approveRunGroup(groupId());
    await refetch();
  });

  const memberColumns: readonly Column<Run>[] = [
    {
      header: "Run",
      cell: (r) => (
        <a href={`/runs/${r.id}`}>
          <code>{r.id}</code>
        </a>
      ),
    },
    {
      header: t("run.details.type"),
      cell: (r) => operationLabel(r.type),
    },
    {
      header: t("members.col.status"),
      cell: (r) => (
        <StatusBadge status={r.status} label={runStatusLabel} tone={runTone} />
      ),
    },
    {
      header: t("app.installationSub"),
      cell: (r) => (
        <Show when={r.installationId} fallback={<span class="muted">—</span>}>
          {(id) => (
            <a href={`/apps/${encodeURIComponent(id())}`}>
              <code>{id()}</code>
            </a>
          )}
        </Show>
      ),
    },
  ];

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
            const items = (): readonly KVItem[] => {
              const out: KVItem[] = [
                {
                  label: t("runGroup.groupId"),
                  value: <code>{g().runGroup.id}</code>,
                },
              ];
              if (g().runGroup.type) {
                out.push({
                  label: t("run.details.type"),
                  value: <code>{g().runGroup.type}</code>,
                });
              }
              return out;
            };
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
                  <KVList items={items()} />
                  <Show when={approveAll.error()}>
                    {(m) => <p class="wa-error" role="alert">{m()}</p>}
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
                  <DataTable
                    columns={memberColumns}
                    rows={g().runs}
                    rowKey={(r) => r.id}
                    empty={t("runGroup.membersEmpty")}
                  />
                </Card>
              </div>
            );
          }}
        </Match>
      </Switch>
    </AppShell>
  );
}
