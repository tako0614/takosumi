/** Retained only for servers whose per-app list route is absent. */
import { createEffect, createResource, For, Show, untrack } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { appOwnershipAvailable } from "../../../../lib/control-api.ts";
import { listWorkspacesCached } from "../../../../lib/workspace-list.ts";
import { clearStoredWorkspaceId, currentWorkspaceId, selectAvailableWorkspaceId, setCurrentWorkspaceId } from "../../../../lib/workspace-state.ts";
import { workspaceName } from "../../../../lib/workspace-labels.ts";
import { fetchFailedMessage } from "../../../../lib/error-copy.ts";
import { Select } from "../../../../components/ui/index.ts";
import { t } from "../../../../i18n/index.ts";

export default function WorkspaceSwitcher() {
  const location = useLocation();
  const navigate = useNavigate();
  const [legacy] = createResource(async () => !await appOwnershipAvailable());
  const [workspaces, { refetch }] = createResource(
    () => !legacy.error && legacy() === true,
    () => listWorkspacesCached({ selectedWorkspaceId: currentWorkspaceId() || undefined }),
  );
  const rows = () => workspaces.error ? [] : workspaces.latest ?? [];
  createEffect(() => {
    if (!legacy.error && legacy() === false) clearStoredWorkspaceId();
    if (!workspaces.loading && !workspaces.error && workspaces.latest) {
      setCurrentWorkspaceId(selectAvailableWorkspaceId(untrack(currentWorkspaceId), rows()));
    }
  });
  return <Show when={!legacy.error && legacy() === true}>
    <Show when={workspaces.error}>
      <button type="button" class="workspace-switcher-retry" onClick={() => void refetch()}>
        {fetchFailedMessage(workspaces.error, t)} {t("common.retry")}
      </button>
    </Show>
    <Show when={rows().length > 1}>
      <Select class="workspace-switcher" value={currentWorkspaceId()}
        aria-label={t("workspace.switcherAria", { name: workspaceName(rows().find((row) => row.id === currentWorkspaceId()) ?? rows()[0]!) })}
        onChange={(event) => {
          setCurrentWorkspaceId(event.currentTarget.value);
          if (/^\/(apps|runs|run-groups)\/[^/]+/u.test(location.pathname)) navigate("/");
        }}>
        <For each={rows()}>{(workspace) => <option value={workspace.id}>{workspaceName(workspace)}</option>}</For>
      </Select>
    </Show>
  </Show>;
}
