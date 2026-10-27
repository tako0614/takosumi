/**
 * アカウント > スペース: this space's name, new spaces by purpose, and
 * archiving. A space is a Workspace. Its generated API handle is never shown
 * (lib/space-labels.ts); people know a space by its name.
 *
 * New spaces are offered by what they are for — keeping an environment apart,
 * or using Takosumi with a team (which continues to member invites) — so
 * nobody has to learn the mechanism first. Creating works even before the
 * first space exists.
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
import { spaceName, type SpacePurpose } from "../../../lib/space-labels.ts";
import SpaceCreateForm from "../../account/components/SpaceCreateForm.tsx";
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

// Archiving the SELECTED space makes the switcher reconcile the selection onto
// another space, which re-keys this view — so the "archived" notice must
// outlive the component instance.
const [archiveNotice, setArchiveNotice] = createSignal<string | null>(null);

const notifySpacesChanged = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
  }
};

export default function SpaceTab() {
  return (
    <div class="acct-stack">
      <Show when={archiveNotice()}>
        {(name) => (
          <Toast tone="success">
            {t("space.archive.done", { name: name() })}
          </Toast>
        )}
      </Show>
      <Show when={currentWorkspaceId() || null} keyed>
        {(workspaceId) => (
          <ThisSpaceCard workspaceId={workspaceId} />
        )}
      </Show>
      <NewSpaceCard />
      <ArchivedSpaces />
    </div>
  );
}

function ThisSpaceCard(props: { readonly workspaceId: string }) {
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
  const activeSpaceCount = () => workspacePage.latest?.total ?? 0;
  const [nameDraft, setNameDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [archiving, setArchiving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  // Seed the draft from the space only while the user has no unsaved edit.
  let seededName: string | null = null;
  createEffect(() => {
    const current = workspace();
    if (!current) return;
    const draft = untrack(nameDraft);
    const shown = spaceName(current);
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
      setSaveError(t("space.nameRequired"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateWorkspace(current.id, { displayName });
      await refetch();
      notifySpacesChanged();
      setSaveMessage(t("space.saved"));
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
      title: t("space.archive.confirmTitle", { name: spaceName(current) }),
      message: t("space.archive.confirmMessage"),
      confirmText: t("space.archive.cta"),
    });
    if (!ok) return;
    setArchiving(true);
    setSaveError(null);
    try {
      await updateWorkspace(current.id, { archived: true });
      // Do NOT clear the selection here; the switcher reconciles it and the
      // archived list keeps 復元 one click away.
      setArchiveNotice(spaceName(current));
      await refetch();
      notifySpacesChanged();
    } catch (err) {
      setSaveError(friendlyError(err, t).message);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("space.thisSpace")} />
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
                    : t("space.notFound")}
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
                <FormField label={t("space.name")} hint={t("space.nameHint")}>
                  <Input
                    value={nameDraft()}
                    onInput={(event) => setNameDraft(event.currentTarget.value)}
                  />
                </FormField>
                <p class="muted">
                  {t("space.createdLabel")} <RelativeTime iso={current().createdAt} />
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
                  <p class="acct-pref-label">{t("space.archive.title")}</p>
                  <p class="muted">
                    {activeSpaceCount() <= 1
                      ? t("space.archive.lastSpace")
                      : t("space.archive.body")}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  type="button"
                  icon={<Archive size={15} />}
                  busy={archiving()}
                  disabled={archiving() || activeSpaceCount() <= 1}
                  onClick={() => void archive()}
                >
                  {t("space.archive.cta")}
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

function NewSpaceCard() {
  const navigate = useNavigate();
  const [purpose, setPurpose] = createSignal<SpacePurpose | null>(null);
  const [created, setCreated] = createSignal<string | null>(null);
  const onCreated = (workspace: Workspace, chosen: SpacePurpose) => {
    setPurpose(null);
    setArchiveNotice(null);
    // A team space exists to be shared: continue straight to invites.
    if (chosen === "team") {
      navigate("/account/members");
      return;
    }
    setCreated(spaceName(workspace));
  };
  return (
    <Card>
      <CardHeader title={t("space.new.title")} subtitle={t("space.new.body")} />
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
                  {t("space.create.environment")}
                </span>
                <span class="acct-purpose-body">
                  {t("space.create.environmentBody")}
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
                <span class="acct-purpose-title">{t("space.create.team")}</span>
                <span class="acct-purpose-body">
                  {t("space.create.teamBody")}
                </span>
              </button>
            </div>
          }
        >
          {(chosen) => (
            <SpaceCreateForm
              purpose={chosen()}
              idPrefix="account-space-create"
              autofocus
              onCreated={onCreated}
              onCancel={() => setPurpose(null)}
            />
          )}
        </Show>
        <Show when={created()}>
          {(name) => (
            <Toast tone="success">{t("space.create.done", { name: name() })}</Toast>
          )}
        </Show>
      </CardSection>
    </Card>
  );
}

function ArchivedSpaces() {
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
      notifySpacesChanged();
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
          title={t("space.archived.title")}
          subtitle={t("space.archived.body")}
        />
        <ul class="acct-list">
          <For each={archived()}>
            {(workspace) => (
              <li class="acct-row">
                <div class="acct-row-main">
                  <strong>{spaceName(workspace)}</strong>
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
                    {t("space.archived.restore")}
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
