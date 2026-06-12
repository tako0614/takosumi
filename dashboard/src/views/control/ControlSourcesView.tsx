import "../../styles/wave-b.css";
import {
  createMemo,
  createResource,
  Match,
  Show,
  Switch,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { GitBranch, RefreshCw } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ControlApiError,
  extractRunId,
  listConnections,
  listSources,
  type Source,
  syncSource,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  Badge,
  Button,
  type Column,
  DataTable,
  EmptyState,
  PageHeader,
} from "../../components/ui/index.ts";

export default function ControlSourcesView() {
  return <Page title="Sources">{() => <Inner />}</Page>;
}

function sourceTone(status: string): "ok" | "danger" | "muted" {
  if (status === "active") return "ok";
  if (status === "error") return "danger";
  return "muted";
}

function Inner() {
  const navigate = useNavigate();
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [sources, { refetch }] = createResource(spaceId, listSources);
  const [connections] = createResource(spaceId, listConnections);

  const connectionName = createMemo(() => {
    const map = new Map<string, string>();
    for (const c of connections() ?? []) {
      map.set(c.id, c.displayName ?? c.provider ?? c.id);
    }
    return map;
  });

  const sync = createAction(async (sourceId: string) => {
    const envelope = await syncSource(sourceId);
    await refetch();
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });

  const columns: readonly Column<Source>[] = [
    {
      header: "名前",
      cell: (source) => (
        <>
          <strong>{source.name}</strong>
          <div class="wb-subline">
            <code>{source.id}</code>
          </div>
        </>
      ),
    },
    {
      header: "Git",
      cell: (source) => <code class="wb-url">{source.url}</code>,
    },
    {
      header: "Ref / Path",
      cell: (source) => (
        <span class="wb-mono">
          <code>{source.defaultRef}</code>
          <span class="muted"> / </span>
          <code>{source.defaultPath}</code>
        </span>
      ),
    },
    {
      header: "Auth",
      cell: (source) => (
        <Show
          when={source.authConnectionId}
          fallback={<span class="muted">none</span>}
        >
          {(id) => (
            <span>
              {connectionName().get(id()) ?? id()}
              <div class="wb-subline">
                <code>{id()}</code>
              </div>
            </span>
          )}
        </Show>
      ),
    },
    {
      header: "状態",
      cell: (source) => (
        <Badge tone={sourceTone(source.status)}>{source.status}</Badge>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (source) => (
        <div class="wb-row-actions">
          <Button
            size="sm"
            busy={sync.busy()}
            disabled={sync.busy()}
            onClick={() => void sync.run(source.id)}
          >
            同期
          </Button>
        </div>
      ),
    },
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="CONTROL"
        title="Sources"
        subtitle="Space に登録された Git Source と、SourceSnapshot 同期を管理します。"
        actions={
          <Button variant="primary" href="/install" icon={<GitBranch size={16} />}>
            Git から導入
          </Button>
        }
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<GitBranch size={28} />}
            title="Space を選択"
            message="Space を選択すると Source 一覧を表示します。"
          />
        }
      >
        <div class="wb-stack">
          <Show when={sync.error()}>
            {(m) => <p class="wb-error" role="alert">{m()}</p>}
          </Show>
          <Switch>
            <Match when={sources.error}>
              <EmptyState
                icon={<RefreshCw size={28} />}
                title="取得に失敗しました"
                message={(sources.error as ControlApiError).message}
              />
            </Match>
            <Match when={!sources.error}>
              <Show
                when={sources.loading || (sources()?.length ?? 0) > 0}
                fallback={
                  <EmptyState
                    ink
                    icon={<GitBranch size={28} />}
                    title="まだ Source がありません"
                    message="この Space にはまだ Source がありません。"
                    action={
                      <Button variant="primary" href="/install">
                        Git から導入
                      </Button>
                    }
                  />
                }
              >
                <DataTable
                  columns={columns}
                  rows={sources()}
                  rowKey={(source) => source.id}
                  loading={sources.loading}
                  skeletonRows={4}
                />
              </Show>
            </Match>
          </Switch>
        </div>
      </Show>
    </AppShell>
  );
}
