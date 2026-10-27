/**
 * Space switcher: the single owner of "which space am I using" for the whole
 * dashboard. A space is a Workspace; the UI calls it スペース / space.
 *
 * Spaces matter (one person alone, one person keeping environments apart, a
 * team) but stay out of the way: with a single space the chrome shows no
 * switcher and no space name at all. The switcher appears once there are two
 * or more spaces, and it lists them by name — never by the generated API
 * handle (see lib/space-labels.ts). New spaces are offered by purpose
 * (環境を分ける / チームで使う); a team space continues to member invites.
 *
 * Every view reads the same `workspace-state.ts` selection this control
 * writes. The initial read is a bounded recent projection that always pins the
 * current space; opening the menu discovers the first cursor and "load more"
 * keeps every space reachable.
 */
import { A, useLocation, useNavigate } from "@solidjs/router";
import { Check, ChevronsUpDown, Layers, Settings, Users } from "lucide-solid";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import {
  DASHBOARD_WORKSPACE_LIST_LIMIT,
  listWorkspacePage,
  type Workspace,
  type WorkspaceListPage,
} from "../../../../lib/control-api.ts";
import {
  clearWorkspaceListCache,
  listWorkspacesCached,
  mergeWorkspaceLists,
} from "../../../../lib/workspace-list.ts";
import {
  currentWorkspaceId,
  selectWorkspaceFromQuery,
  setCurrentWorkspaceId,
} from "../../../../lib/workspace-state.ts";
import {
  duplicatedSpaceNames,
  spaceDisambiguator,
  spaceName,
  type SpacePurpose,
} from "../../../../lib/space-labels.ts";
import { fetchFailedMessage, friendlyError } from "../../../../lib/error-copy.ts";
import { t } from "../../../../i18n/index.ts";
import SpaceCreateForm from "../SpaceCreateForm.tsx";

interface Props {
  readonly compact?: boolean;
}

function spaceInitial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/**
 * Routes whose content belongs to one app or run, not to the selected space.
 * After a switch they would keep showing — and accepting actions on — the
 * previous space's object, so the switch returns to ホーム.
 */
const ENTITY_SCOPED_ROUTES: readonly RegExp[] = [
  /^\/workloads\/[^/]+/u,
  /^\/runs\/[^/]+/u,
  /^\/run-groups\/[^/]+/u,
];

export default function SpaceSwitcher(props: Props = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [workspaces, { refetch }] = createResource(() =>
    listWorkspacesCached({
      selectedWorkspaceId: currentWorkspaceId() || undefined,
    }),
  );
  const [open, setOpen] = createSignal(false);
  const [page, setPage] = createSignal<WorkspaceListPage | null>(null);
  const [pageLoading, setPageLoading] = createSignal(false);
  const [pageError, setPageError] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal<SpacePurpose | null>(null);
  // Reading an errored createResource THROWS. This switcher is mounted in BOTH
  // the sidebar and the top bar, so an unguarded read would take the whole
  // chrome down on every page when the space list fails.
  const loadedWorkspaces = createMemo(() =>
    mergeWorkspaceLists(
      workspaces.error ? [] : (workspaces.latest ?? []),
      page()?.workspaces ?? [],
    ),
  );
  const selectedWorkspaceId = createMemo(() =>
    selectWorkspaceFromQuery("", currentWorkspaceId(), loadedWorkspaces()),
  );
  const selectedWorkspace = createMemo(() =>
    loadedWorkspaces().find((workspace) => workspace.id === selectedWorkspaceId()),
  );
  const duplicates = createMemo(() => duplicatedSpaceNames(loadedWorkspaces()));
  const selectedName = () => {
    const workspace = selectedWorkspace();
    return workspace ? spaceName(workspace) : "";
  };
  /** Only two or more spaces need a switcher. */
  const visible = () => !workspaces.loading && loadedWorkspaces().length >= 2;
  const menuId = () =>
    props.compact ? "space-switcher-compact" : "space-switcher-sidebar";

  // Reconcile a persisted selection after sign-in: a browser can keep the
  // previous user's value, so never keep an id absent from the loaded list.
  // The selection is read UNTRACKED — reconciling on every selection change
  // made a just-created space flap back to the first one before the refetch
  // landed it.
  createEffect(() => {
    if (workspaces.loading) return;
    // A failed read is not evidence that the user has no spaces; keep the
    // selection until a list actually loads.
    if (workspaces.error) return;
    const list = loadedWorkspaces();
    const current = untrack(currentWorkspaceId);
    const next = selectWorkspaceFromQuery("", current, list);
    if (next !== current) setCurrentWorkspaceId(next);
    if (!next) setOpen(false);
  });

  let rootRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  if (typeof window !== "undefined") {
    const refreshWorkspaces = () => {
      clearWorkspaceListCache();
      setPage(null);
      setPageError(null);
      void refetch();
    };
    window.addEventListener("takosumi:workspaces-changed", refreshWorkspaces);
    const dismissOutside = (event: Event) => {
      if (!open()) return;
      if (rootRef && !rootRef.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open()) {
        setOpen(false);
        triggerRef?.focus();
      }
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("focusin", dismissOutside);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("takosumi:workspaces-changed", refreshWorkspaces);
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("focusin", dismissOutside);
      window.removeEventListener("keydown", onKeyDown);
    });
  }

  const loadPage = async (cursor?: string) => {
    if (pageLoading()) return;
    setPageLoading(true);
    setPageError(null);
    try {
      const next = await listWorkspacePage({
        limit: DASHBOARD_WORKSPACE_LIST_LIMIT,
        order: "updated_desc",
        ...(cursor ? { cursor } : {}),
        ...(!cursor && currentWorkspaceId()
          ? { selectedWorkspaceId: currentWorkspaceId() }
          : {}),
      });
      const merged = mergeWorkspaceLists(
        cursor ? (page()?.workspaces ?? []) : [],
        next.workspaces,
      );
      setPage({ ...next, workspaces: merged, returned: merged.length });
    } catch (error) {
      setPageError(friendlyError(error, t).message);
    } finally {
      setPageLoading(false);
    }
  };

  const toggle = () => {
    const next = !open();
    setOpen(next);
    if (next && page() === null) void loadPage();
  };
  const loadMore = () => {
    const cursor = page()?.nextCursor;
    if (cursor) void loadPage(cursor);
  };

  const choose = (id: string) => {
    setCurrentWorkspaceId(id);
    setOpen(false);
    if (ENTITY_SCOPED_ROUTES.some((pattern) => pattern.test(location.pathname))) {
      navigate("/");
    }
    // Closing removes the focused item from the DOM; keep focus on the trigger.
    triggerRef?.focus();
  };

  const created = (_workspace: Workspace, purpose: SpacePurpose) => {
    setCreating(null);
    setOpen(false);
    // A team space exists to be shared: continue straight to inviting people.
    if (purpose === "team") navigate("/account/members");
    else triggerRef?.focus();
  };

  // Re-opening the menu starts at the space list, not a half-open form.
  createEffect(() => {
    if (!open()) setCreating(null);
  });

  // role="menu" keyboard model: focus the checked space on open, then arrows /
  // Home / End rove between items. It stands down inside the create form.
  const menuItems = (): HTMLElement[] =>
    menuRef
      ? Array.from(
          menuRef.querySelectorAll<HTMLElement>(
            '[role="menuitemradio"], [role="menuitem"]',
          ),
        )
      : [];
  createEffect(() => {
    if (!open() || creating()) return;
    queueMicrotask(() => {
      const items = menuItems();
      const current = items.find((el) => el.getAttribute("aria-checked") === "true");
      (current ?? items[0])?.focus();
    });
  });
  const onMenuKeyDown = (event: KeyboardEvent) => {
    if ((event.target as HTMLElement | null)?.closest(".space-create-form")) return;
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) =>
      items[(next + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
      triggerRef?.focus();
    }
  };

  return (
    <Show when={visible() || workspaces.error}>
      <div
        class="space-switcher"
        classList={{ compact: props.compact }}
        ref={rootRef}
      >
        <Show when={visible()}>
          <div class="space-switcher-picker">
            <button
              type="button"
              class="space-switcher-current"
              aria-label={t("space.switcherAria", { name: selectedName() })}
              aria-haspopup="menu"
              aria-expanded={open()}
              aria-controls={menuId()}
              ref={triggerRef}
              onClick={toggle}
            >
              <span class="space-switcher-avatar" aria-hidden="true">
                {spaceInitial(selectedName())}
              </span>
              <span class="space-switcher-name">{selectedName()}</span>
              <ChevronsUpDown
                class="space-switcher-caret"
                size={15}
                aria-hidden="true"
              />
            </button>
            <Show when={open()}>
              <div
                class="space-switcher-menu"
                id={menuId()}
                // A <form> is invalid content for role="menu"; while the create
                // form is open the popover is presented as a dialog.
                role={creating() ? "dialog" : "menu"}
                aria-labelledby={`${menuId()}-label`}
                ref={menuRef}
                onKeyDown={onMenuKeyDown}
              >
                <div class="space-switcher-menu-head" id={`${menuId()}-label`}>
                  {t("space.label")}
                </div>
                <Switch>
                  <Match when={creating()}>
                    {(purpose) => (
                      <div class="space-switcher-create">
                        <SpaceCreateForm
                          purpose={purpose()}
                          idPrefix={`${menuId()}-create`}
                          autofocus
                          onCreated={created}
                          onCancel={() => {
                            setCreating(null);
                            queueMicrotask(() => menuItems()[0]?.focus());
                          }}
                        />
                      </div>
                    )}
                  </Match>
                  <Match when={!creating()}>
                    <ul class="space-switcher-list" role="none">
                      <For each={loadedWorkspaces()}>
                        {(workspace) => (
                          <li role="none">
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={workspace.id === selectedWorkspaceId()}
                              class="space-switcher-item"
                              classList={{
                                current: workspace.id === selectedWorkspaceId(),
                              }}
                              onClick={() => choose(workspace.id)}
                            >
                              <span class="space-switcher-avatar" aria-hidden="true">
                                {spaceInitial(spaceName(workspace))}
                              </span>
                              <span class="space-switcher-item-name">
                                {spaceName(workspace)}
                              </span>
                              <Show when={duplicates().has(spaceName(workspace))}>
                                <span class="space-switcher-item-hint">
                                  {spaceDisambiguator(workspace)}
                                </span>
                              </Show>
                              <Show when={workspace.id === selectedWorkspaceId()}>
                                <Check
                                  class="space-switcher-check"
                                  size={16}
                                  aria-hidden="true"
                                />
                              </Show>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={page()?.nextCursor}>
                      <button
                        type="button"
                        role="menuitem"
                        class="space-switcher-action"
                        disabled={pageLoading()}
                        onClick={loadMore}
                      >
                        <span>
                          {pageLoading() ? t("space.loading") : t("common.loadMore")}
                        </span>
                      </button>
                    </Show>
                    <Show when={pageError()}>
                      {(message) => (
                        <p class="space-switcher-error" role="alert">
                          {t("space.loadFailed", { message: message() })}
                        </p>
                      )}
                    </Show>
                    <button
                      type="button"
                      role="menuitem"
                      class="space-switcher-action"
                      onClick={() => setCreating("environment")}
                    >
                      <Layers size={15} aria-hidden="true" />
                      <span>{t("space.create.environment")}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="space-switcher-action"
                      onClick={() => setCreating("team")}
                    >
                      <Users size={15} aria-hidden="true" />
                      <span>{t("space.create.team")}</span>
                    </button>
                    <A
                      href="/account/space"
                      class="space-switcher-action"
                      role="menuitem"
                      onClick={() => setOpen(false)}
                    >
                      <Settings size={15} aria-hidden="true" />
                      <span>{t("space.settings")}</span>
                    </A>
                  </Match>
                </Switch>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={workspaces.error}>
          <div class="space-switcher-error" role="alert">
            <span>{fetchFailedMessage(workspaces.error, t)}</span>
            <button
              type="button"
              class="space-switcher-retry"
              onClick={() => void refetch()}
            >
              {t("common.retry")}
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
