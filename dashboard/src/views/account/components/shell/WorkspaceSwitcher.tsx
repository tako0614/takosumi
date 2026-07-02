/**
 * Global Workspace switcher: the single owner of "which Workspace am I
 * working in" for the whole dashboard (GitHub org-switcher analogue).
 *
 * Replaces the per-view `lib/workspace-state.ts` signal: every view
 * now reads the same `workspace-state.ts` signal this control writes. Lists Workspaces
 * via `GET /api/v1/workspaces` and defaults to the first Workspace when none is
 * selected. Creation belongs in setup/admin flows, not in the everyday topbar.
 */
import { A } from "@solidjs/router";
import { Settings } from "lucide-solid";
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
import { Select } from "../../../../components/ui/Form.tsx";

interface Props {
  readonly compact?: boolean;
}

export default function WorkspaceSwitcher(props: Props = {}) {
  const [workspaces, { refetch }] = createResource(() =>
    listWorkspacesCached(),
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

  if (typeof window !== "undefined") {
    const refreshWorkspaces = () => {
      clearWorkspaceListCache();
      void refetch();
    };
    window.addEventListener("takosumi:workspaces-changed", refreshWorkspaces);
    onCleanup(() =>
      window.removeEventListener(
        "takosumi:workspaces-changed",
        refreshWorkspaces,
      ),
    );
  }

  return (
    <div class="topbar-workspace" classList={{ compact: props.compact }}>
      <Show when={!props.compact}>
        <div class="topbar-workspace-header">
          <span class="topbar-workspace-label">{t("workspace.label")}</span>
          <Show when={loadedWorkspaces().length > 1}>
            <span class="topbar-workspace-count">{t("workspace.change")}</span>
          </Show>
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
              aria-expanded={switcherOpen()}
              aria-controls={switcherId()}
              onClick={() => setSwitcherOpen((open) => !open)}
            >
              <span class="topbar-workspace-name">
                {selectedWorkspaceName()}
              </span>
              <Show when={loadedWorkspaces().length > 1}>
                <span class="topbar-workspace-current-action">
                  {t("workspace.change")}
                </span>
              </Show>
            </button>
            <Show when={switcherOpen()}>
              <Select
                id={switcherId()}
                name="workspaceId"
                class="topbar-workspace-select"
                aria-label={t("workspace.select")}
                value={selectedWorkspaceId()}
                onChange={(e) => {
                  setCurrentWorkspaceId(e.currentTarget.value);
                  setSwitcherOpen(false);
                }}
              >
                <For each={loadedWorkspaces()}>
                  {(workspace) => (
                    <option
                      value={workspace.id}
                      selected={workspace.id === selectedWorkspaceId()}
                    >
                      {workspace.displayName || workspace.handle}
                    </option>
                  )}
                </For>
              </Select>
            </Show>
          </div>
        </Show>
        <Show
          when={!props.compact && !workspaces.loading && selectedWorkspaceId()}
        >
          <A
            href="/advanced/workspace"
            class="topbar-workspace-settings"
            aria-label={t("workspace.settings")}
            title={t("workspace.settings")}
          >
            <Settings size={16} />
          </A>
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
