/**
 * Backups view (spec §29) — Space-scoped control backup ledger.
 *
 * The route uses the session-authed `/api/v1/spaces/:id/backups` pass-through
 * so operators can create and inspect backup artifacts from the same dashboard
 * surface as Installations, Sources, Graph, Output shares, and Activity.
 */
import "../../styles/wave-b.css";
import { createResource, Match, Show, Switch } from "solid-js";
import { Archive } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type BackupRecord,
  type ControlApiError,
  createSpaceBackup,
  listSpaceBackups,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  Button,
  type Column,
  DataTable,
  EmptyState,
  PageHeader,
  Spinner,
} from "../../components/ui/index.ts";

export default function ControlBackupsView() {
  return <Page title="Backups">{() => <Inner />}</Page>;
}

function Inner() {
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [backups, { refetch }] = createResource(spaceId, listSpaceBackups);

  const create = createAction(async () => {
    const id = spaceId();
    if (!id) throw new Error("Space を選択してください。");
    await createSpaceBackup(id);
    await refetch();
  });

  const columns: readonly Column<BackupRecord>[] = [
    {
      header: "作成日時",
      cell: (backup) => (
        <>
          <time>{backup.createdAt}</time>
          <div class="wb-subline">
            <code>{backup.id}</code>
          </div>
        </>
      ),
    },
    {
      header: "Control artifact",
      cell: (backup) => (
        <>
          <code class="wb-mono">{backup.objectKey}</code>
          <div class="wb-subline">
            {formatBytes(backup.sizeBytes)} · {shortDigest(backup.digest)}
          </div>
        </>
      ),
    },
    {
      header: "Service data",
      cell: (backup) => (
        <Show when={backup.serviceData} fallback={<span class="muted">none</span>}>
          {(data) => (
            <span>
              <code class="wb-mono">{data().objectKey}</code>
              <div class="wb-subline">
                exported {data().exportedCount} · unsupported{" "}
                {data().unsupportedCount} · missing {data().missingCount}
              </div>
            </span>
          )}
        </Show>
      ),
    },
    {
      header: "Run",
      cell: (backup) => (
        <Show
          when={backup.createdByRunId}
          fallback={<span class="muted">manual</span>}
        >
          {(runId) => <code class="wb-mono">{runId()}</code>}
        </Show>
      ),
    },
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="CONTROL"
        title="Backups"
        subtitle="Space の control backup と service-data archive を管理します。"
        actions={
          <Button
            variant="primary"
            icon={<Archive size={16} />}
            busy={create.busy()}
            disabled={create.busy() || !spaceId()}
            onClick={() => void create.run()}
          >
            Backup 作成
          </Button>
        }
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Archive size={28} />}
            title="Space を選択"
            message="Space を選択すると Backup 一覧を表示します。"
          />
        }
      >
        <div class="wb-stack">
          <Show when={create.error()}>
            {(m) => <p class="wb-error" role="alert">{m()}</p>}
          </Show>
          <Switch>
            <Match when={backups.error}>
              <EmptyState
                icon={<Archive size={28} />}
                title="取得に失敗しました"
                message={(backups.error as ControlApiError).message}
              />
            </Match>
            <Match when={!backups.error}>
              <Show
                when={backups.loading || (backups()?.length ?? 0) > 0}
                fallback={
                  <EmptyState
                    ink
                    icon={<Archive size={28} />}
                    title="まだ Backup がありません"
                    message="この Space の最初のバックアップを作成できます。"
                    action={
                      <Button
                        variant="primary"
                        icon={<Archive size={16} />}
                        busy={create.busy()}
                        disabled={create.busy()}
                        onClick={() => void create.run()}
                      >
                        Backup 作成
                      </Button>
                    }
                  />
                }
              >
                <DataTable
                  columns={columns}
                  rows={backups()}
                  rowKey={(backup) => backup.id}
                  loading={backups.loading}
                  skeletonRows={3}
                />
              </Show>
            </Match>
          </Switch>

          <Show when={create.busy()}>
            <p class="wb-progress">
              <Spinner size={14} />
              Backup を作成しています。
            </p>
          </Show>
        </div>
      </Show>
    </AppShell>
  );
}

function shortDigest(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
