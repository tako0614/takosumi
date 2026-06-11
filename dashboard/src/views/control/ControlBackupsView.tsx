/**
 * Backups view (spec §29) — Space-scoped control backup ledger.
 *
 * The route uses the session-authed `/api/v1/spaces/:id/backups` pass-through
 * so operators can create and inspect backup artifacts from the same dashboard
 * surface as Installations, Sources, Graph, Output shares, and Activity.
 */
import { createResource, For, Match, Show, Switch } from "solid-js";
import { Archive, RefreshCw } from "lucide-solid";
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

  return (
    <AppShell>
      <div class="page-header">
        <h1>Backups</h1>
        <p class="page-sub">
          Space の control backup と service-data archive を管理します。
        </p>
        <div class="page-actions">
          <button
            class="btn btn-primary"
            type="button"
            disabled={create.busy() || !spaceId()}
            onClick={() => void create.run()}
          >
            <Archive size={16} />
            Backup 作成
          </button>
        </div>
      </div>

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <section class="empty-state">
            <p>Space を選択すると Backup 一覧を表示します。</p>
          </section>
        }
      >
        <Show when={create.error()}>
          {(m) => <p class="sign-in-error">{m()}</p>}
        </Show>
        <Switch>
          <Match when={backups.loading}>
            <div class="grid-skel"><div class="skel-block" /></div>
          </Match>
          <Match when={backups.error}>
            <section class="empty-state error-state">
              <p>取得に失敗しました — {(backups.error as ControlApiError).message}</p>
            </section>
          </Match>
          <Match when={backups()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <section class="empty-state">
                    <p>まだ Backup がありません。</p>
                    <button
                      class="btn btn-primary"
                      type="button"
                      disabled={create.busy()}
                      onClick={() => void create.run()}
                    >
                      <Archive size={16} />
                      Backup 作成
                    </button>
                  </section>
                }
              >
                <table class="data-table backups-table">
                  <thead>
                    <tr>
                      <th>作成日時</th>
                      <th>Control artifact</th>
                      <th>Service data</th>
                      <th>Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={list()}>
                      {(backup) => <BackupRow backup={backup} />}
                    </For>
                  </tbody>
                </table>
              </Show>
            )}
          </Match>
        </Switch>

        <Show when={create.busy()}>
          <p class="muted backup-progress">
            <RefreshCw size={14} />
            Backup を作成しています。
          </p>
        </Show>
      </Show>
    </AppShell>
  );
}

function BackupRow(props: { readonly backup: BackupRecord }) {
  const serviceData = () => props.backup.serviceData;
  return (
    <tr>
      <td>
        <time>{props.backup.createdAt}</time>
        <div class="muted installation-type">
          <code>{props.backup.id}</code>
        </div>
      </td>
      <td>
        <code>{props.backup.objectKey}</code>
        <div class="muted installation-type">
          {formatBytes(props.backup.sizeBytes)} · {shortDigest(props.backup.digest)}
        </div>
      </td>
      <td>
        <Show when={serviceData()} fallback={<span class="muted">none</span>}>
          {(data) => (
            <span>
              <code>{data().objectKey}</code>
              <div class="muted installation-type">
                exported {data().exportedCount} · unsupported {data().unsupportedCount}
                {" "}· missing {data().missingCount}
              </div>
            </span>
          )}
        </Show>
      </td>
      <td>
        <Show
          when={props.backup.createdByRunId}
          fallback={<span class="muted">manual</span>}
        >
          {(runId) => <code>{runId()}</code>}
        </Show>
      </td>
    </tr>
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
