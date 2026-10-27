/**
 * アカウント > スペース: this workspace's name, new workspaces by purpose, and
 * archiving (a workspace is called スペース in the Japanese UI). Its generated
 * API handle is never shown (lib/workspace-labels.ts); people know a workspace
 * by its name.
 *
 * New workspaces are offered by what they are for — keeping an environment
 * apart, or using Takosumi with a team (which continues to member invites) —
 * so nobody has to learn the mechanism first. Creating works even before the
 * first workspace exists.
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Archive, Layers, Users } from "lucide-solid";
import {
  listWorkspacePage,
  updateWorkspace,
  type Workspace,
} from "../../../lib/control-api.ts";
import { useConfirmDialog } from "../../../lib/confirm-dialog.ts";
import { friendlyError } from "../../../lib/error-copy.ts";
import { latestOrUndefined } from "../../../lib/resource-read.ts";
import { currentWorkspaceId } from "../../../lib/workspace-state.ts";
import { workspaceName, type WorkspacePurpose } from "../../../lib/workspace-labels.ts";
import WorkspaceCreateForm from "../../account/components/WorkspaceCreateForm.tsx";
import RelativeTime from "../../account/components/RelativeTime.tsx";
import { t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  FormField,
  Input,
  Toast,
} from "../../../components/ui/index.ts";

// Archiving the SELECTED workspace makes the switcher reconcile the selection onto
// another workspace, which re-keys this view — so the "archived" notice must
// outlive the component instance.
const [archiveNotice, setArchiveNotice] = createSignal<string | null>(null);

const notifyWorkspacesChanged = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
  }
};

export default function WorkspaceTab() {
  return (
    <div class="acct-stack">
      <Show when={archiveNotice()}>
        {(name) => (
          <Toast tone="success">
            {t("workspace.archive.done", { name: name() })}
          </Toast>
        )}
      </Show>
      <Show when={currentWorkspaceId() || null} keyed>
        {(workspaceId) => (
          <ThisWorkspaceCard workspaceId={workspaceId} />
        )}
      </Show>
      <NewWorkspaceCard />
      <ArchivedWorkspaces />
    </div>
  );
}

function ThisWorkspaceCard(props: { readonly workspaceId: string }) {
  const { confirm } = useConfirmDialog();
  const [workspacePage, { refetch }] = createResource(() =>
    listWorkspacePage({
      limit: 1,
      includeTotal: true,
      order: "updated_desc",
      selectedWorkspaceId: props.workspaceId,
    }),
  );
  // An errored resource THROWS on read; route reads through guarded memos.
  const workspace = createMemo(() =>
    (workspacePage.error ? [] : (workspacePage.latest?.workspaces ?? [])).find(
      (item) => item.id === props.workspaceId,
    ),
  );
  const activeWorkspaceCount = () => workspacePage.latest?.total ?? 0;
  const [nameDraft, setNameDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [archiving, setArchiving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  // Seed the draft from the workspace only while the user has no unsaved edit.
  let seededName: string | null = null;
  createEffect(() => {
    const current = workspace();
    if (!current) return;
    const draft = untrack(nameDraft);
    const shown = workspaceName(current);
    const clean = seededName === null || draft === seededName || draft === shown;
    if (!clean) return;
    seededName = shown;
    setNameDraft(shown);
  });

  const save = async (event: Event) => {
    event.preventDefault();
    if (saving()) return;
    const current = workspace();
    if (!current) return;
    const displayName = nameDraft().trim();
    if (!displayName) {
      setSaveError(t("workspace.nameRequired"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateWorkspace(current.id, { displayName });
      await refetch();
      notifyWorkspacesChanged();
      setSaveMessage(t("workspace.saved"));
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
    const ok = await confirm({
      title: t("workspace.archive.confirmTitle", { name: workspaceName(current) }),
      message: t("workspace.archive.confirmMessage"),
      confirmText: t("workspace.archive.cta"),
    });
    if (!ok) return;
    setArchiving(true);
    setSaveError(null);
    try {
      await updateWorkspace(current.id, { archived: true });
      // Do NOT clear the selection here; the switcher reconciles it and the
      // archived list keeps 復元 one click away.
      setArchiveNotice(workspaceName(current));
      await refetch();
      notifyWorkspacesChanged();
    } catch (err) {
      setSaveError(friendlyError(err, t).message);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("workspace.thisWorkspace")} />
      <Show
        when={workspace()}
        fallback={
          <CardSection>
            <Show
              when={workspacePage.error}
              fallback={
                <p class="muted">
                  {workspacePage.loading
                    ? t("common.loading")
                    : t("workspace.notFound")}
                </p>
              }
            >
              <div class="tg-card-error">
                <p class="muted">{friendlyError(workspacePage.error, t).message}</p>
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
          </CardSection>
        }
      >
        {(current) => (
          <>
            <CardSection>
              <form class="wc-form" onSubmit={save}>
                <FormField label={t("workspace.name")} hint={t("workspace.nameHint")}>
                  <Input
                    value={nameDraft()}
                    onInput={(event) => setNameDraft(event.currentTarget.value)}
                  />
                </FormField>
                <p class="muted">
                  {t("workspace.createdLabel")} <RelativeTime iso={current().createdAt} />
                </p>
                <div class="wc-form-actions">
                  <Button variant="primary" type="submit" busy={saving()}>
                    {saving() ? t("common.saving") : t("common.save")}
                  </Button>
                </div>
                <Show when={saveMessage()}>
                  {(message) => <Toast tone="success">{message()}</Toast>}
                </Show>
              </form>
            </CardSection>
            <CardSection>
              <div class="acct-danger-row">
                <div>
                  <p class="acct-pref-label">{t("workspace.archive.title")}</p>
                  <p class="muted">
                    {activeWorkspaceCount() <= 1
                      ? t("workspace.archive.lastWorkspace")
                      : t("workspace.archive.body")}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  type="button"
                  icon={<Archive size={15} />}
                  busy={archiving()}
                  disabled={archiving() || activeWorkspaceCount() <= 1}
                  onClick={() => void archive()}
                >
                  {t("workspace.archive.cta")}
                </Button>
              </div>
            </CardSection>
            <Show when={saveError()}>
              {(message) => (
                <CardSection>
                  <Toast tone="error">{message()}</Toast>
                </CardSection>
              )}
            </Show>
          </>
        )}
      </Show>
    </Card>
  );
}

function NewWorkspaceCard() {
  const navigate = useNavigate();
  const [purpose, setPurpose] = createSignal<WorkspacePurpose | null>(null);
  const [created, setCreated] = createSignal<string | null>(null);
  const onCreated = (workspace: Workspace, chosen: WorkspacePurpose) => {
    setPurpose(null);
    setArchiveNotice(null);
    // A team workspace exists to be shared: continue straight to invites.
    if (chosen === "team") {
      navigate("/account/members");
      return;
    }
    setCreated(workspaceName(workspace));
  };
  return (
    <Card>
      <CardHeader title={t("workspace.new.title")} subtitle={t("workspace.new.body")} />
      <CardSection>
        <Show
          when={purpose()}
          fallback={
            <div class="acct-purpose-grid">
              <button
                type="button"
                class="acct-purpose"
                onClick={() => {
                  setCreated(null);
                  setPurpose("environment");
                }}
              >
                <Layers size={20} aria-hidden="true" />
                <span class="acct-purpose-title">
                  {t("workspace.create.environment")}
                </span>
                <span class="acct-purpose-body">
                  {t("workspace.create.environmentBody")}
                </span>
              </button>
              <button
                type="button"
                class="acct-purpose"
                onClick={() => {
                  setCreated(null);
                  setPurpose("team");
                }}
              >
                <Users size={20} aria-hidden="true" />
                <span class="acct-purpose-title">{t("workspace.create.team")}</span>
                <span class="acct-purpose-body">
                  {t("workspace.create.teamBody")}
                </span>
              </button>
            </div>
          }
        >
          {(chosen) => (
            <WorkspaceCreateForm
              purpose={chosen()}
              idPrefix="account-workspace-create"
              autofocus
              onCreated={onCreated}
              onCancel={() => setPurpose(null)}
            />
          )}
        </Show>
        <Show when={created()}>
          {(name) => (
            <Toast tone="success">{t("workspace.create.done", { name: name() })}</Toast>
          )}
        </Show>
      </CardSection>
    </Card>
  );
}

function ArchivedWorkspaces() {
  const [archivedPage, { mutate, refetch }] = createResource(() =>
    listWorkspacePage({ includeArchived: true, limit: 50, order: "updated_desc" }),
  );
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [restoringId, setRestoringId] = createSignal<string | null>(null);
  if (typeof window !== "undefined") {
    const refresh = () => void refetch();
    window.addEventListener("takosumi:workspaces-changed", refresh);
    onCleanup(() =>
      window.removeEventListener("takosumi:workspaces-changed", refresh),
    );
  }
  const archived = createMemo(() =>
    (archivedPage.error ? [] : (archivedPage.latest?.workspaces ?? [])).filter(
      (workspace) => Boolean(workspace.archivedAt),
    ),
  );

  const restore = async (id: string) => {
    if (restoringId()) return;
    setRestoringId(id);
    setError(null);
    try {
      await updateWorkspace(id, { archived: false });
      setArchiveNotice(null);
      await refetch();
      notifyWorkspacesChanged();
    } catch (err) {
      setError(friendlyError(err, t).message);
    } finally {
      setRestoringId(null);
    }
  };

  const loadMore = async () => {
    const current = archivedPage.latest;
    if (!current?.nextCursor || loadingMore()) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await listWorkspacePage({
        includeArchived: true,
        limit: 50,
        order: "updated_desc",
        cursor: current.nextCursor,
      });
      const byId = new Map(
        [...current.workspaces, ...next.workspaces].map((item) => [item.id, item]),
      );
      const workspaces = [...byId.values()];
      mutate({ ...next, workspaces, returned: workspaces.length });
    } catch (err) {
      setError(friendlyError(err, t).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Show
      when={
        archived().length > 0 ||
        latestOrUndefined(archivedPage)?.nextCursor !== undefined
      }
    >
      <Card>
        <CardHeader
          title={t("workspace.archived.title")}
          subtitle={t("workspace.archived.body")}
        />
        <ul class="acct-list">
          <For each={archived()}>
            {(workspace) => (
              <li class="acct-row">
                <div class="acct-row-main">
                  <strong>{workspaceName(workspace)}</strong>
                </div>
                <div class="acct-row-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    busy={restoringId() === workspace.id}
                    disabled={restoringId() !== null}
                    onClick={() => void restore(workspace.id)}
                  >
                    {t("workspace.archived.restore")}
                  </Button>
                </div>
              </li>
            )}
          </For>
        </ul>
        <Show when={latestOrUndefined(archivedPage)?.nextCursor}>
          <CardSection>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              busy={loadingMore()}
              onClick={() => void loadMore()}
            >
              {t("common.loadMore")}
            </Button>
          </CardSection>
        </Show>
        <Show when={error()}>
          {(message) => (
            <CardSection>
              <Toast tone="error">{message()}</Toast>
            </CardSection>
          )}
        </Show>
      </Card>
    </Show>
  );
}
