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
import { Check, ChevronsUpDown, Settings } from "lucide-solid";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  type ControlApiError,
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
import { t } from "../../../../i18n/index.ts";

interface Props {
  readonly compact?: boolean;
}

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return (trimmed[0] ?? "?").toUpperCase();
}

export default function WorkspaceSwitcher(props: Props = {}) {
  const [workspaces, { refetch }] = createResource(() =>
    listWorkspacesCached({ selectedWorkspaceId: currentWorkspaceId() }),
  );
  const [switcherOpen, setSwitcherOpen] = createSignal(false);
  const loadedWorkspaces = createMemo(() => workspaces() ?? []);
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
  const onLoaded = (list: readonly Workspace[]) => {
    const next = selectAvailableWorkspaceId(currentWorkspaceId(), list);
    if (next !== currentWorkspaceId()) {
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
  if (typeof window !== "undefined") {
    const refreshWorkspaces = () => {
      clearWorkspaceListCache();
      void refetch();
    };
    window.addEventListener("takosumi:workspaces-changed", refreshWorkspaces);
    // Dismiss the popover on an outside click or Escape.
    const onPointerDown = (event: MouseEvent) => {
      if (!switcherOpen()) return;
      if (rootRef && !rootRef.contains(event.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSwitcherOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener(
        "takosumi:workspaces-changed",
        refreshWorkspaces,
      );
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    });
  }

  const choose = (id: string) => {
    setCurrentWorkspaceId(id);
    setSwitcherOpen(false);
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
            <span class="topbar-workspace-empty">
              {workspaces.loading
                ? t("workspace.loading")
                : t("workspace.none")}
            </span>
          }
        >
          <div class="topbar-workspace-picker">
            <button
              type="button"
              class="topbar-workspace-current"
              aria-haspopup="menu"
              aria-expanded={switcherOpen()}
              aria-controls={switcherId()}
              onClick={() => setSwitcherOpen((open) => !open)}
            >
              <span class="topbar-workspace-avatar" aria-hidden="true">
                {workspaceInitial(selectedWorkspaceName())}
              </span>
              <span class="topbar-workspace-name">
                {selectedWorkspaceName()}
              </span>
              <Show when={loadedWorkspaces().length > 1}>
                <ChevronsUpDown class="topbar-workspace-caret" size={15} />
              </Show>
            </button>
            <Show when={switcherOpen()}>
              <div class="topbar-workspace-menu" id={switcherId()} role="menu">
                <div class="topbar-workspace-menu-head">
                  {t("workspace.label")}
                </div>
                <ul class="topbar-workspace-menu-list">
                  <For each={loadedWorkspaces()}>
                    {(workspace) => (
                      <li>
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
                            <Check class="topbar-workspace-check" size={16} />
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <A
                  href="/advanced/workspace"
                  class="topbar-workspace-settings"
                  onClick={() => setSwitcherOpen(false)}
                >
                  <Settings size={15} />
                  <span>{t("workspace.settings")}</span>
                </A>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={workspaces.error}>
        <span class="topbar-workspace-error" role="alert">
          {t("workspace.loadFailed", {
            message: (workspaces.error as ControlApiError).message,
          })}
        </span>
      </Show>
    </div>
  );
}
