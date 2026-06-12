/**
 * RunGroup summary view (spec §31) — a Space-update RunGroup.
 *
 * A RunGroup orders multiple Runs across the dependency DAG (e.g. a Space update
 * after stale propagation). This view reads `GET /api/v1/run-groups/:id`
 * ({runGroup, runs}), shows the group status + ordered member list, and offers
 * "全て承認" (`POST /api/v1/run-groups/:id/approve`) to approve the group.
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
import { controlRunStatusLabel } from "../../lib/status-labels.ts";
import { runTone } from "./run-tone.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import Button from "../../components/ui/Button.tsx";
import { Card, CardHeader } from "../../components/ui/Card.tsx";
import { Badge, StatusBadge } from "../../components/ui/Badge.tsx";
import KVList, { type KVItem } from "../../components/ui/KVList.tsx";
import DataTable, { type Column } from "../../components/ui/DataTable.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";
import Skeleton from "../../components/ui/Skeleton.tsx";

export default function ControlRunGroupView() {
  return <Page title="Space 更新">{() => <Inner />}</Page>;
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
    { header: "種別", cell: (r) => <code>{r.type}</code> },
    {
      header: "状態",
      cell: (r) => (
        <StatusBadge
          status={r.status}
          label={controlRunStatusLabel}
          tone={runTone}
        />
      ),
    },
    {
      header: "Installation",
      cell: (r) => (
        <Show when={r.installationId} fallback={<span class="muted">—</span>}>
          <code>{r.installationId}</code>
        </Show>
      ),
    },
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="RunGroup"
        title="Space 更新（RunGroup）"
        subtitle="DAG 順に並んだ複数 Run のグループ。まとめて承認できます。"
        actions={
          <Button variant="secondary" href="/installations">
            一覧へ
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
            title="取得に失敗しました"
            message={(group.error as ControlApiError).message}
          />
        </Match>
        <Match when={group()}>
          {(g) => {
            const items = (): readonly KVItem[] => {
              const out: KVItem[] = [
                { label: "Group ID", value: <code>{g().runGroup.id}</code> },
              ];
              if (g().runGroup.type) {
                out.push({ label: "種別", value: <code>{g().runGroup.type}</code> });
              }
              return out;
            };
            return (
              <div class="wa-stack">
                <Card>
                  <CardHeader
                    title={
                      <span class="wa-title-row">
                        RunGroup
                        <Show when={g().runGroup.status}>
                          <StatusBadge
                            status={g().runGroup.status}
                            label={controlRunStatusLabel}
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
                          {approveAll.busy() ? "承認中..." : "全ての Run を承認"}
                        </Button>
                      </Show>
                    }
                  />
                  <KVList items={items()} />
                  <Show when={approveAll.error()}>
                    {(m) => <p class="wa-error">{m()}</p>}
                  </Show>
                </Card>

                <Card>
                  <CardHeader
                    title={
                      <span class="wa-title-row">
                        メンバー Run
                        <Badge tone="muted">{g().runs.length}</Badge>
                      </span>
                    }
                  />
                  <DataTable
                    columns={memberColumns}
                    rows={g().runs}
                    rowKey={(r) => r.id}
                    empty="メンバー Run はありません。"
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
