/**
 * Workspace settings — バックアップ. Port of the former ControlBackupsView body
 * (current compatibility store: workspace-scoped control backup ledger).
 */
import "../../../styles/wave-b.css";
import { createResource, Match, Show, Switch } from "solid-js";
import { Archive } from "lucide-solid";
import {
  type BackupRecord,
  type ControlApiError,
  createSpaceBackup,
  listSpaceBackups,
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

export default function BackupsTab(props: { readonly spaceId: string }) {
  const [backups, { refetch }] = createResource(
    () => props.spaceId,
    listSpaceBackups,
  );

  const create = createAction(async () => {
    await createSpaceBackup(props.spaceId);
    await refetch();
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
          <strong>{t("backups.col.artifact")}</strong>
          <div class="wb-subline">
            {formatBytes(backup.sizeBytes)}
            {backup.serviceData
              ? ` · ${t("backups.serviceDataSummary", {
                  exported: backup.serviceData.exportedCount,
                  unsupported: backup.serviceData.unsupportedCount,
                  missing: backup.serviceData.missingCount,
                })}`
              : ""}
          </div>
        </div>
      ),
    },
    {
      header: t("backups.col.source"),
      cell: (backup) => (
        <span>
          {backup.createdByRunId ? t("backups.col.run") : t("backups.manual")}
        </span>
      ),
    },
    {
      header: t("common.details"),
      cell: (backup) => (
        <details class="wb-disclosure">
          <summary>{t("common.details")}</summary>
          <div class="wb-stack-sm">
            <div>
              <span class="muted">{t("backups.detail.id")}</span>
              <div>
                <code class="wb-mono">{backup.id}</code>
              </div>
            </div>
            <div>
              <span class="muted">{t("backups.col.artifact")}</span>
              <div>
                <code class="wb-mono">{backup.objectKey}</code>
              </div>
              <div class="wb-subline">{shortDigest(backup.digest)}</div>
            </div>
            <Show when={backup.serviceData}>
              {(data) => (
                <div>
                  <span class="muted">{t("backups.col.serviceData")}</span>
                  <div>
                    <code class="wb-mono">{data().objectKey}</code>
                  </div>
                  <div class="wb-subline">
                    {t("backups.serviceDataSummary", {
                      exported: data().exportedCount,
                      unsupported: data().unsupportedCount,
                      missing: data().missingCount,
                    })}
                  </div>
                </div>
              )}
            </Show>
            <Show when={backup.createdByRunId}>
              {(runId) => (
                <div>
                  <span class="muted">{t("backups.col.run")}</span>
                  <div>
                    <code class="wb-mono">{runId()}</code>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </details>
      ),
    },
  ];

  return (
    <div class="wb-stack">
      <Card>
        <CardHeader
          title={t("spaceSettings.tab.backups")}
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
        <Switch>
          <Match when={backups.error}>
            <EmptyState
              icon={<Archive size={28} />}
              title={t("spaceSettings.tab.backups")}
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
