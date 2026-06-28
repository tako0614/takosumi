/**
 * Workspace settings — バックアップ. Port of the former ControlBackupsView body
 * (current compatibility store: workspace-scoped control backup ledger).
 */
import "../../../styles/wave-b.css";
import { useNavigate } from "@solidjs/router";
import { createResource, Match, Show, Switch } from "solid-js";
import { Archive, RotateCcw } from "lucide-solid";
import {
  type BackupRecord,
  createBackupRestore,
  type ControlApiError,
  createWorkspaceBackup,
  listWorkspaceBackups,
} from "../../../lib/control-api.ts";
import { createAction } from "../../account/lib/action.tsx";
import { formatDateTime, t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  type Column,
  DataTable,
  EmptyState,
  Spinner,
} from "../../../components/ui/index.ts";

export default function BackupsTab(props: { readonly workspaceId: string }) {
  const navigate = useNavigate();
  const [backups, { refetch }] = createResource(
    () => props.workspaceId,
    listWorkspaceBackups,
  );

  const create = createAction(async () => {
    await createWorkspaceBackup(props.workspaceId);
    await refetch();
  });
  const restore = createAction(async (record: BackupRecord) => {
    const target = record.restoreTarget;
    if (!target) {
      throw new Error(t("backups.restoreUnavailable"));
    }
    const run = await createBackupRestore(props.workspaceId, record.id, {
      capsuleId: target.capsuleId,
      environment: target.environment,
      stateGeneration: target.stateGeneration,
      expectedBackupDigest: record.digest,
    });
    navigate(`/runs/${run.id}`);
  });

  const columns: readonly Column<BackupRecord>[] = [
    {
      header: t("backups.col.createdAt"),
      cell: (backup) => (
        <div>
          <time datetime={backup.createdAt}>
            {formatDateTime(backup.createdAt)}
          </time>
        </div>
      ),
    },
    {
      header: t("backups.col.contents"),
      cell: (backup) => (
        <div>
          <strong>{t("backups.restorePoint")}</strong>
          <div class="wb-subline">{formatBytes(backup.sizeBytes)}</div>
          <Show when={backup.restoreTarget}>
            {(target) => (
              <div class="wb-subline">
                {t("backups.restoreGeneration", {
                  generation: String(target().stateGeneration),
                })}
              </div>
            )}
          </Show>
        </div>
      ),
    },
    {
      header: t("backups.col.actions"),
      align: "right",
      cell: (backup) => (
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCcw size={14} />}
          busy={restore.busy()}
          disabled={restore.busy() || !backup.restoreTarget}
          onClick={() => void restore.run(backup)}
          title={
            backup.restoreTarget ? undefined : t("backups.restoreUnavailable")
          }
        >
          {t("backups.restore")}
        </Button>
      ),
    },
  ];

  return (
    <div class="wb-stack">
      <Card>
        <CardHeader
          title={t("workspaceSettings.tab.backups")}
          subtitle={t("backups.subtitle")}
          actions={
            <Button
              variant="primary"
              icon={<Archive size={16} />}
              busy={create.busy()}
              disabled={create.busy()}
              onClick={() => void create.run()}
            >
              {t("backups.create")}
            </Button>
          }
        />
        <Show when={create.error()}>
          {(m) => (
            <p class="wb-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Show when={restore.error()}>
          {(m) => (
            <p class="wb-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Switch>
          <Match when={backups.error}>
            <EmptyState
              icon={<Archive size={28} />}
              title={t("workspaceSettings.tab.backups")}
              message={t("common.fetchFailed", {
                message: (backups.error as ControlApiError).message,
              })}
            />
          </Match>
          <Match when={!backups.error}>
            <Show
              when={backups.loading || (backups()?.length ?? 0) > 0}
              fallback={
                <EmptyState
                  icon={<Archive size={28} />}
                  title={t("backups.empty.title")}
                  message={t("backups.empty.message")}
                  action={
                    <Button
                      variant="primary"
                      icon={<Archive size={16} />}
                      busy={create.busy()}
                      disabled={create.busy()}
                      onClick={() => void create.run()}
                    >
                      {t("backups.create")}
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
            {t("backups.creating")}
          </p>
        </Show>
      </Card>
    </div>
  );
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
