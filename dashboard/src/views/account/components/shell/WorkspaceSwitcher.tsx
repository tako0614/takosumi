/**
 * Global Workspace switcher: the single owner of "which Workspace am I
 * working in" for the whole dashboard (GitHub org-switcher analogue).
 *
 * Replaces the per-view `lib/workspace-state.ts` signal: every view
 * now reads the same `workspace-state.ts` signal this control writes. Lists Workspaces
 * via `GET /api/v1/workspaces` and defaults to the first Workspace when none is
 * selected. Creation belongs in setup/admin flows, not in the everyday topbar.
 *
 * The picker is a lightweight popover menu (not a native `<select>`): one tap
 * on the current-workspace chip opens a list with the active one checked.
 */
import { A } from "@solidjs/router";
import { Check, ChevronsUpDown, Plus, Settings } from "lucide-solid";
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
import {
  isValidWorkspaceHandle,
  slugifyWorkspaceHandle,
} from "takosumi-contract";
import {
  type ControlApiError,
  createWorkspace,
  type Workspace,
} from "../../../../lib/control-api.ts";
import {
  clearWorkspaceListCache,
  listWorkspacesCached,
} from "../../../../lib/workspace-list.ts";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
  setCurrentWorkspaceId,
} from "../../../../lib/workspace-state.ts";
import { createAction } from "../../lib/action.tsx";
import { t } from "../../../../i18n/index.ts";
import { Button } from "../../../../components/ui/index.ts";

interface Props {
  readonly compact?: boolean;
}

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return (trimmed[0] ?? "?").toUpperCase();
}

/**
 * Fresh unique handle for a workspace created from the switcher (same
 * time+random recipe as the /new and launcher first-workspace flows); the
 * user-facing identity is the display name they typed.
 */
function newWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

export default function WorkspaceSwitcher(props: Props = {}) {
  const [workspaces, { mutate, refetch }] = createResource(() =>
    listWorkspacesCached({ selectedWorkspaceId: currentWorkspaceId() }),
  );
  const [switcherOpen, setSwitcherOpen] = createSignal(false);
  // Reading an errored createResource THROWS. This switcher is mounted in BOTH
  // the sidebar and the topbar, so an unguarded read would take the whole
  // chrome down on every page when the workspace list fails (and its written
  // error UI below would never render). Guard on `.error` and fall back to the
  // last-known list — mirrors RunsListView / ActivityView.
  const loadedWorkspaces = createMemo(() =>
    workspaces.error ? [] : (workspaces.latest ?? []),
  );
  const selectedWorkspaceId = createMemo(() =>
    selectAvailableWorkspaceId(currentWorkspaceId(), loadedWorkspaces()),
  );
  const selectedWorkspace = createMemo(() =>
    loadedWorkspaces().find(
      (workspace) => workspace.id === selectedWorkspaceId(),
    ),
  );
  const selectedWorkspaceName = createMemo(() => {
    const workspace = selectedWorkspace();
    return workspace?.displayName || workspace?.handle || t("workspace.none");
  });
  const switcherId = () =>
    props.compact ? "workspace-switcher-compact" : "workspace-switcher-sidebar";
  const workspaceName = (workspace: Workspace) =>
    workspace.displayName || workspace.handle;

  // Reconcile persisted Workspace selection after sign-in. A browser can keep
  // the previous user's localStorage value, so never keep an id that is absent
  // from the loaded Workspace list.
  //
  // `currentWorkspaceId` is read UNTRACKED: this reconciliation must fire when a
  // freshly loaded list arrives, NOT every time the selection changes. Tracking
  // it made creating a Workspace flap — `setCurrentWorkspaceId(new)` re-ran this
  // against the still-stale list (new id absent), which reset the selection back
  // to the first Workspace before the refetch could land the new one.
  const onLoaded = (list: readonly Workspace[]) => {
    const current = untrack(currentWorkspaceId);
    const next = selectAvailableWorkspaceId(current, list);
    if (next !== current) {
      setCurrentWorkspaceId(next);
    }
    if (!next) setSwitcherOpen(false);
    return list;
  };

  createEffect(() => {
    if (workspaces.loading) return;
    onLoaded(loadedWorkspaces());
  });

  let rootRef: HTMLDivElement | undefined;
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  if (typeof window !== "undefined") {
    const refreshWorkspaces = () => {
      clearWorkspaceListCache();
      void refetch();
    };
    window.addEventListener("takosumi:workspaces-changed", refreshWorkspaces);
    // Dismiss the popover on an outside click, Escape, or focus moving out.
    const onPointerDown = (event: MouseEvent) => {
      if (!switcherOpen()) return;
      if (rootRef && !rootRef.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && switcherOpen()) {
        setSwitcherOpen(false);
        triggerRef?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!switcherOpen()) return;
      if (rootRef && !rootRef.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("focusin", onFocusIn);
    onCleanup(() => {
      window.removeEventListener(
        "takosumi:workspaces-changed",
        refreshWorkspaces,
      );
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("focusin", onFocusIn);
    });
  }

  const choose = (id: string) => {
    setCurrentWorkspaceId(id);
    setSwitcherOpen(false);
    // Closing removes the focused menu item from the DOM; without this,
    // focus falls back to <body>.
    triggerRef?.focus();
  };

  // ----- inline workspace creation ------------------------------------------
  // Name + Workspace ID (the `@handle`) inside the menu popover. The id is the
  // user-chosen, globally unique identifier: it defaults to a slug of the name
  // but stays editable, and if left blank we fall back to a generated handle so
  // a non-ASCII name (which slugifies to nothing) still creates instantly.
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createName, setCreateName] = createSignal("");
  const [createHandle, setCreateHandle] = createSignal("");
  // Once the id is edited by hand we stop mirroring the name into it.
  const [handleEdited, setHandleEdited] = createSignal(false);
  let createInputRef: HTMLInputElement | undefined;

  const onNameInput = (value: string) => {
    setCreateName(value);
    if (!handleEdited()) setCreateHandle(slugifyWorkspaceHandle(value));
  };
  const onHandleInput = (value: string) => {
    setHandleEdited(true);
    setCreateHandle(value);
  };
  // Invalid only when non-empty and malformed — an empty id is allowed (a
  // handle is then generated), so it must not paint the field red.
  const handleInvalid = createMemo(() => {
    const handle = createHandle().trim();
    return handle.length > 0 && !isValidWorkspaceHandle(handle);
  });
  const resetCreateForm = () => {
    setCreateName("");
    setCreateHandle("");
    setHandleEdited(false);
  };

  const create = createAction(async () => {
    const displayName = createName().trim();
    if (!displayName) throw new Error(t("workspace.create.nameRequired"));
    const typedHandle = createHandle().trim();
    if (typedHandle && !isValidWorkspaceHandle(typedHandle)) {
      throw new Error(t("workspace.create.idInvalid"));
    }
    // Instant feedback for the common clash before the round-trip; the service
    // remains the authority on uniqueness across every Workspace.
    if (
      typedHandle &&
      loadedWorkspaces().some((workspace) => workspace.handle === typedHandle)
    ) {
      throw new Error(t("workspace.create.idTaken"));
    }
    const handle = typedHandle || newWorkspaceHandle();
    const workspace = await createWorkspace({
      handle,
      displayName,
      type: "personal",
    });
    clearWorkspaceListCache();
    // Reflect the new Workspace in this switcher immediately (the refetch below
    // replaces it with the canonical list); selecting it before the list settles
    // is now safe because the reconcile effect reads the selection untracked.
    mutate((prev) => [...(prev ?? []), workspace]);
    setCurrentWorkspaceId(workspace.id);
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    resetCreateForm();
    setCreateOpen(false);
    setSwitcherOpen(false);
    triggerRef?.focus();
    return workspace;
  });

  // Re-opening the popover starts back at the workspace list, not a stale
  // half-open create form.
  createEffect(() => {
    if (!switcherOpen()) setCreateOpen(false);
  });
  // Whenever the create form is closed (cancel, success, or dismissing the
  // popover) drop its inputs and any error so it always reopens clean.
  createEffect(() => {
    if (!createOpen()) {
      resetCreateForm();
      create.clearError();
    }
  });
  createEffect(() => {
    if (createOpen()) queueMicrotask(() => createInputRef?.focus());
  });

  // role="menu" keyboard model: move focus into the menu on open (landing on
  // the checked workspace), then arrows / Home / End rove between items.
  const menuItems = (): HTMLElement[] =>
    menuRef
      ? Array.from(
          menuRef.querySelectorAll<HTMLElement>(
            '[role="menuitemradio"], [role="menuitem"]',
          ),
        )
      : [];

  createEffect(() => {
    if (!switcherOpen()) return;
    queueMicrotask(() => {
      const items = menuItems();
      const current = items.find(
        (el) => el.getAttribute("aria-checked") === "true",
      );
      (current ?? items[0])?.focus();
    });
  });

  const onMenuKeyDown = (event: KeyboardEvent) => {
    // Inside the create form, arrows/Home/End edit the input's caret and Tab
    // moves between its controls — the menu roving model must stand down.
    const target = event.target as HTMLElement | null;
    if (target?.closest(".topbar-workspace-create")) return;
    const items = menuItems();
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(idx + 1 + items.length) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      // Menus close on Tab. Refocus the trigger first (without
      // preventDefault) so the default Tab continues from it instead of
      // from the removed menu item.
      setSwitcherOpen(false);
      triggerRef?.focus();
    }
  };

  return (
    <div
      class="topbar-workspace"
      classList={{ compact: props.compact }}
      ref={rootRef}
    >
      <Show when={!props.compact}>
        <div class="topbar-workspace-header">
          <span class="topbar-workspace-label">{t("workspace.label")}</span>
        </div>
      </Show>
      <div class="topbar-workspace-row">
        <Show
          when={!workspaces.loading && loadedWorkspaces().length > 0}
          fallback={
            // On error, suppress the "no workspaces" text — the error line
            // below states what actually happened instead of implying empty.
            <Show when={!workspaces.error}>
              <span class="topbar-workspace-empty">
                {workspaces.loading
                  ? t("workspace.loading")
                  : t("workspace.none")}
              </span>
            </Show>
          }
        >
          <div class="topbar-workspace-picker">
            <button
              type="button"
              class="topbar-workspace-current"
              // Names the compact (topbar) variant, whose visible text is
              // only the avatar letter; also states the control's purpose.
              aria-label={t("workspace.switcherAria", {
                name: selectedWorkspaceName(),
              })}
              aria-haspopup="menu"
              aria-expanded={switcherOpen()}
              aria-controls={switcherId()}
              ref={triggerRef}
              onClick={() => setSwitcherOpen((open) => !open)}
            >
              <span class="topbar-workspace-avatar" aria-hidden="true">
                {workspaceInitial(selectedWorkspaceName())}
              </span>
              <span class="topbar-workspace-name">
                {selectedWorkspaceName()}
              </span>
              <Show when={loadedWorkspaces().length > 1}>
                <ChevronsUpDown
                  class="topbar-workspace-caret"
                  size={15}
                  aria-hidden="true"
                />
              </Show>
            </button>
            <Show when={switcherOpen()}>
              <div
                class="topbar-workspace-menu"
                id={switcherId()}
                // The inline create <form> is invalid content for role="menu"
                // (menus allow only menuitem-family children); while it is open
                // present the popover as a dialog instead. The menu's roving
                // model already stands down inside the create form.
                role={createOpen() ? "dialog" : "menu"}
                aria-labelledby={`${switcherId()}-label`}
                ref={menuRef}
                onKeyDown={onMenuKeyDown}
              >
                <div
                  class="topbar-workspace-menu-head"
                  id={`${switcherId()}-label`}
                >
                  {t("workspace.label")}
                </div>
                <ul class="topbar-workspace-menu-list" role="none">
                  <For each={loadedWorkspaces()}>
                    {(workspace) => (
                      <li role="none">
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={workspace.id === selectedWorkspaceId()}
                          class="topbar-workspace-item"
                          classList={{
                            current: workspace.id === selectedWorkspaceId(),
                          }}
                          onClick={() => choose(workspace.id)}
                        >
                          <span
                            class="topbar-workspace-avatar"
                            aria-hidden="true"
                          >
                            {workspaceInitial(workspaceName(workspace))}
                          </span>
                          <span class="topbar-workspace-item-name">
                            {workspaceName(workspace)}
                          </span>
                          <Show when={workspace.id === selectedWorkspaceId()}>
                            <Check
                              class="topbar-workspace-check"
                              size={16}
                              aria-hidden="true"
                            />
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <Show
                  when={createOpen()}
                  fallback={
                    <button
                      type="button"
                      role="menuitem"
                      class="topbar-workspace-settings"
                      onClick={() => setCreateOpen(true)}
                    >
                      <Plus size={15} aria-hidden="true" />
                      <span>{t("workspace.start.create")}</span>
                    </button>
                  }
                >
                  <form
                    class="topbar-workspace-create"
                    style={{
                      display: "flex",
                      "flex-direction": "column",
                      gap: "8px",
                      padding: "8px",
                    }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void create.run();
                    }}
                  >
                    <label
                      class="tg-field-label"
                      for={`${switcherId()}-create-name`}
                    >
                      {t("workspace.create.nameLabel")}
                    </label>
                    <input
                      id={`${switcherId()}-create-name`}
                      class="tg-input"
                      type="text"
                      value={createName()}
                      onInput={(event) =>
                        onNameInput(event.currentTarget.value)
                      }
                      placeholder={t("workspace.create.namePlaceholder")}
                      autocomplete="off"
                      spellcheck={false}
                      ref={createInputRef}
                    />
                    <label
                      class="tg-field-label"
                      for={`${switcherId()}-create-id`}
                    >
                      {t("workspace.create.idLabel")}
                    </label>
                    <div class="topbar-workspace-handle">
                      <span
                        class="topbar-workspace-handle-at"
                        aria-hidden="true"
                      >
                        @
                      </span>
                      <input
                        id={`${switcherId()}-create-id`}
                        class="tg-input"
                        classList={{ "tg-input-invalid": handleInvalid() }}
                        type="text"
                        inputmode="url"
                        value={createHandle()}
                        onInput={(event) =>
                          onHandleInput(event.currentTarget.value)
                        }
                        placeholder={t("workspace.create.idPlaceholder")}
                        autocomplete="off"
                        autocapitalize="none"
                        spellcheck={false}
                        aria-invalid={handleInvalid()}
                        aria-describedby={`${switcherId()}-create-id-help`}
                      />
                    </div>
                    <p
                      id={`${switcherId()}-create-id-help`}
                      class="topbar-workspace-hint"
                      classList={{ invalid: handleInvalid() }}
                    >
                      {handleInvalid()
                        ? t("workspace.create.idInvalid")
                        : t("workspace.create.idHelp")}
                    </p>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <Button
                        variant="primary"
                        size="sm"
                        type="submit"
                        busy={create.busy()}
                      >
                        {create.busy()
                          ? t("common.creating")
                          : t("common.create")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => setCreateOpen(false)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                    <Show when={create.error()}>
                      {(message) => (
                        <p class="topbar-workspace-error" role="alert">
                          {t("workspace.create.failed", {
                            message: message(),
                          })}
                        </p>
                      )}
                    </Show>
                  </form>
                </Show>
                <A
                  href="/advanced/workspace"
                  class="topbar-workspace-settings"
                  role="menuitem"
                  onClick={() => setSwitcherOpen(false)}
                >
                  <Settings size={15} aria-hidden="true" />
                  <span>{t("workspace.settings")}</span>
                </A>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={workspaces.error}>
        <div class="topbar-workspace-error" role="alert">
          <span>
            {t("workspace.loadFailed", {
              message: (workspaces.error as ControlApiError).message,
            })}
          </span>
          <button
            type="button"
            class="topbar-workspace-retry"
            onClick={() => void refetch()}
          >
            {t("common.retry")}
          </button>
        </div>
      </Show>
    </div>
  );
}
