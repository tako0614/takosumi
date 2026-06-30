/**
 * Global Workspace switcher: the single owner of "which Workspace am I
 * working in" for the whole dashboard (GitHub org-switcher analogue).
 *
 * Replaces the per-view `lib/workspace-state.ts` signal: every view
 * now reads the same `workspace-state.ts` signal this control writes. Lists Workspaces
 * via `GET /api/v1/workspaces` and defaults to the first Workspace when none is
 * selected. Creation belongs in setup/admin flows, not in the everyday topbar.
 */
import {
  createEffect,
  createMemo,
  createResource,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  type ControlApiError,
  listWorkspaces,
  type Workspace,
} from "../../../../lib/control-api.ts";
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
  const [workspaces, { refetch }] = createResource(listWorkspaces);
  const loadedWorkspaces = createMemo(() => workspaces() ?? []);
  const selectedWorkspaceId = createMemo(() =>
    selectAvailableWorkspaceId(currentWorkspaceId(), loadedWorkspaces()),
  );

  // Reconcile persisted Workspace selection after sign-in. A browser can keep
  // the previous user's localStorage value, so never keep an id that is absent
  // from the loaded Workspace list.
  const onLoaded = (list: readonly Workspace[]) => {
    const next = selectAvailableWorkspaceId(currentWorkspaceId(), list);
    if (next !== currentWorkspaceId()) {
      setCurrentWorkspaceId(next);
    }
    return list;
  };

  createEffect(() => {
    if (workspaces.loading) return;
    onLoaded(loadedWorkspaces());
  });

  if (typeof window !== "undefined") {
    const refreshWorkspaces = () => void refetch();
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
        <span class="topbar-workspace-label">{t("workspace.label")}</span>
      </Show>
      <Show
        when={!workspaces.loading && loadedWorkspaces().length > 0}
        fallback={
          <Show when={!workspaces.loading && loadedWorkspaces().length === 0}>
            <span class="topbar-workspace-empty">{t("workspace.none")}</span>
          </Show>
        }
      >
        <Select
          id="workspace-switcher"
          name="workspaceId"
          class="topbar-workspace-select"
          aria-label={t("workspace.label")}
          value={selectedWorkspaceId()}
          disabled={loadedWorkspaces().length < 2}
          onChange={(e) => setCurrentWorkspaceId(e.currentTarget.value)}
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
