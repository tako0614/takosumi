/**
 * Workspace settings — 一般: display name + (folded) policy JSON. Successor of the
 * Workspace part of the old AccountSettingsView; the Workspace is the one selected in
 * the global switcher.
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js";
import {
  listWorkspacePage,
  updateWorkspace,
} from "../../../lib/control-api.ts";
import { useConfirmDialog } from "../../../lib/confirm-dialog.ts";
import { friendlyError } from "../../../lib/error-copy.ts";
import { formatDateTime, t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  FormField,
  Input,
  KVList,
  Toast,
} from "../../../components/ui/index.ts";

// Archiving the SELECTED workspace makes the global switcher reconcile the
// selection onto another workspace, which re-keys (remounts) this tab — so the
// "archived" success state must outlive the component instance. Module scope
// keeps the notice visible on the remounted tab, right above the archived
// list that carries the 復元 (unarchive) affordance.
const [archiveNotice, setArchiveNotice] = createSignal<string | null>(null);

export default function GeneralTab(props: { readonly workspaceId: string }) {
  const { confirm } = useConfirmDialog();
  const [workspacePage, { refetch }] = createResource(() =>
    listWorkspacePage({
      limit: 1,
      includeTotal: true,
      order: "updated_desc",
      selectedWorkspaceId: props.workspaceId,
    }),
  );
  const [archivedPage, { mutate: mutateArchived, refetch: refetchArchived }] =
    createResource(() =>
      listWorkspacePage({
        includeArchived: true,
        limit: 50,
        order: "updated_desc",
      }),
    );
  const [loadingArchivedMore, setLoadingArchivedMore] = createSignal(false);
  const [archivedLoadError, setArchivedLoadError] = createSignal<string | null>(
    null,
  );
  const archivedWorkspaces = createMemo(() =>
    (archivedPage.error ? [] : (archivedPage.latest?.workspaces ?? [])).filter(
      (workspace) => Boolean(workspace.archivedAt),
    ),
  );
  // An errored resource THROWS on read; route reads through this guarded
  // accessor so the Switch below reaches its error fallback instead of crashing
  // the <Match when={workspace()}> evaluation.
  const workspace = createMemo(() =>
    (workspacePage.error ? [] : (workspacePage.latest?.workspaces ?? [])).find(
      (item) => item.id === props.workspaceId,
    ),
  );
  const activeWorkspaceTotal = () => workspacePage.latest?.total ?? 0;
  const [displayNameDraft, setDisplayNameDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [archiving, setArchiving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  // Seed the draft from the workspace, but only while the user has no unsaved
  // edit: workspace() also refetches on unarchive/background refresh, and an
  // unconditional re-seed would silently discard in-progress typing. `untrack`
  // keeps keystrokes from re-running the effect.
  let seededDisplayName: string | null = null;
  createEffect(() => {
    const current = workspace();
    if (!current) return;
    const draft = untrack(displayNameDraft);
    const clean =
      seededDisplayName === null ||
      draft === seededDisplayName ||
      draft === current.displayName;
    if (!clean) return;
    seededDisplayName = current.displayName;
    setDisplayNameDraft(current.displayName);
    setSaveError(null);
    setSaveMessage(null);
  });

  const save = async (event: Event) => {
    event.preventDefault();
    if (saving()) return;
    const current = workspace();
    if (!current) return;
    const displayName = displayNameDraft().trim();
    if (!displayName) {
      setSaveError(t("workspaceSettings.general.nameRequired"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateWorkspace(current.id, { displayName });
      await refetch();
      // The sidebar/topbar WorkspaceSwitcher listens for this — without it
      // the renamed workspace keeps its old name until a full reload.
      window.dispatchEvent(new Event("takosumi:workspaces-changed"));
      setSaveMessage(t("workspaceSettings.general.saved"));
    } catch (err) {
      setSaveError(friendlyError(err, t).message);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (archiving()) return;
    const current = workspace();
    if (!current) return;
    if (activeWorkspaceTotal() <= 1) {
      setSaveError(t("workspaceSettings.general.archiveLastError"));
      return;
    }
    const ok = await confirm({
      title: t("workspaceSettings.general.archive"),
      message: t("workspaceSettings.general.archiveConfirm"),
      confirmText: t("workspaceSettings.general.archive"),
      danger: true,
    });
    if (!ok) return;
    setArchiving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateWorkspace(current.id, { archived: true });
      // Do NOT clear the workspace selection here: that unmounts this tab
      // before any success state renders and strands the user on a bare
      // "select a workspace" screen. Name the archived workspace instead and
      // let the switcher reconcile the selection; the archived list below
      // keeps the 復元 (unarchive) affordance one click away.
      setArchiveNotice(current.displayName || `@${current.handle}`);
      await Promise.all([refetch(), refetchArchived()]);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("takosumi:workspaces-changed"));
      }
    } catch (err) {
      setSaveError(friendlyError(err, t).message);
    } finally {
      setArchiving(false);
    }
  };

  // Which archived workspace is being restored — per-row busy so a double
  // click cannot fire duplicate PATCHes and other rows stay untouched (same
  // per-row idiom as SharesTab/BackupsTab).
  const [unarchivingId, setUnarchivingId] = createSignal<string | null>(null);
  const unarchive = async (id: string) => {
    if (unarchivingId()) return;
    setUnarchivingId(id);
    try {
      await updateWorkspace(id, { archived: false });
      setArchiveNotice(null);
      await Promise.all([refetch(), refetchArchived()]);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("takosumi:workspaces-changed"));
      }
    } catch (err) {
      setSaveError(friendlyError(err, t).message);
    } finally {
      setUnarchivingId(null);
    }
  };

  const loadMoreArchived = async () => {
    const current = archivedPage.latest;
    if (!current?.nextCursor || loadingArchivedMore()) return;
    setLoadingArchivedMore(true);
    setArchivedLoadError(null);
    try {
      const next = await listWorkspacePage({
        includeArchived: true,
        limit: 50,
        order: "updated_desc",
        cursor: current.nextCursor,
      });
      const byId = new Map(
        [...current.workspaces, ...next.workspaces].map((item) => [
          item.id,
          item,
        ]),
      );
      const workspaces = [...byId.values()];
      mutateArchived({
        ...next,
        workspaces,
        returned: workspaces.length,
      });
    } catch (error) {
      setArchivedLoadError(friendlyError(error, t).message);
    } finally {
      setLoadingArchivedMore(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("workspaceSettings.tab.general")} />
      {/* Rendered outside the workspace() Switch so it survives both the
          brief "not found" window after archiving and the remount that
          follows the switcher's reselection. */}
      <Show when={archiveNotice()}>
        {(name) => (
          <Toast tone="success">
            {t("workspaceSettings.general.archivedNamed", { name: name() })}{" "}
            {t("workspaceSettings.general.archivedHint")}
          </Toast>
        )}
      </Show>
      <Switch
        fallback={
          <Show
            when={workspacePage.error}
            fallback={
              <p class="muted">
                {workspacePage.loading
                  ? t("common.loading")
                  : t("workspaceSettings.general.notFound")}
              </p>
            }
          >
            <div class="tg-card-error">
              <p class="muted">
                {friendlyError(workspacePage.error, t).message}
              </p>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void refetch()}
              >
                {t("common.retry")}
              </Button>
            </div>
          </Show>
        }
      >
        <Match when={workspace()}>
          {(current) => (
            <>
              <KVList
                items={[
                  {
                    label: t("workspaceSettings.general.handle"),
                    value: <code>@{current().handle}</code>,
                  },
                  {
                    label: t("workspaceSettings.general.updated"),
                    value: formatDateTime(current().updatedAt),
                  },
                ]}
              />
              <CardSection>
                <form class="wc-form" onSubmit={save}>
                  <FormField label={t("workspaceSettings.general.displayName")}>
                    <Input
                      value={displayNameDraft()}
                      onInput={(e) =>
                        setDisplayNameDraft(e.currentTarget.value)
                      }
                    />
                  </FormField>
                  <details class="wb-disclosure wc-advanced-settings">
                    <summary>
                      {t("workspaceSettings.general.advancedDetails")}
                    </summary>
                    <KVList
                      items={[
                        {
                          label: t("workspaceSettings.general.type"),
                          value: <code>{current().type}</code>,
                        },
                        {
                          label: t("workspaceSettings.general.owner"),
                          value: <code>{current().ownerUserId}</code>,
                        },
                      ]}
                    />
                    <div class="wc-form-actions">
                      <Button
                        variant="danger"
                        type="button"
                        busy={archiving()}
                        disabled={archiving() || activeWorkspaceTotal() <= 1}
                        // The disabled path is otherwise a dead end — surface
                        // WHY the last workspace cannot be archived on hover.
                        title={
                          activeWorkspaceTotal() <= 1
                            ? t("workspaceSettings.general.archiveLastError")
                            : undefined
                        }
                        onClick={archive}
                      >
                        {archiving()
                          ? t("common.saving")
                          : t("workspaceSettings.general.archive")}
                      </Button>
                    </div>
                  </details>
                  <div class="wc-form-actions">
                    <Button variant="primary" type="submit" busy={saving()}>
                      {saving() ? t("common.saving") : t("common.save")}
                    </Button>
                  </div>
                  <Show when={saveError()}>
                    {(message) => <Toast tone="error">{message()}</Toast>}
                  </Show>
                  <Show when={saveMessage()}>
                    {(message) => <Toast tone="success">{message()}</Toast>}
                  </Show>
                </form>
              </CardSection>
            </>
          )}
        </Match>
      </Switch>
      <Show
        when={
          archivedWorkspaces().length > 0 ||
          archivedPage.latest?.nextCursor !== undefined
        }
      >
        <CardSection>
          <h2 class="tg-card-title">
            {t("workspaceSettings.general.archivedTitle")}
          </h2>
          <ul class="wc-archived-list">
            <For each={archivedWorkspaces()}>
              {(w) => (
                <li class="wc-archived-row">
                  <span>@{w.handle}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    busy={unarchivingId() === w.id}
                    disabled={unarchivingId() !== null}
                    onClick={() => void unarchive(w.id)}
                  >
                    {t("workspaceSettings.general.unarchive")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
          <Show when={archivedPage.latest?.nextCursor}>
            <div class="wc-form-actions">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                busy={loadingArchivedMore()}
                disabled={loadingArchivedMore()}
                onClick={() => void loadMoreArchived()}
              >
                {t("common.loadMore")}
              </Button>
            </div>
          </Show>
          <Show when={archivedLoadError()}>
            {(message) => <Toast tone="error">{message()}</Toast>}
          </Show>
        </CardSection>
      </Show>
    </Card>
  );
}
