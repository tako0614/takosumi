/**
 * The selected workspace (スペース in the Japanese UI) as workspace-scoped
 * pages show it. Workspaces stay out of the way: a page names the workspace it
 * is showing only when there are two or more, so one person with one
 * workspace never reads the word.
 */
import { createResource, onCleanup, Show } from "solid-js";
import { listWorkspacesCached } from "../../../lib/workspace-list.ts";
import { currentWorkspaceId } from "../../../lib/workspace-state.ts";
import { workspaceName } from "../../../lib/workspace-labels.ts";
import type { Workspace } from "../../../lib/control-api.ts";
import { t } from "../../../i18n/index.ts";

export function createCurrentWorkspace() {
  const [workspaces, { refetch }] = createResource(
    () => currentWorkspaceId() || "",
    (selected) =>
      listWorkspacesCached({ selectedWorkspaceId: selected || undefined }),
  );
  if (typeof window !== "undefined") {
    const refresh = () => void refetch();
    window.addEventListener("takosumi:workspaces-changed", refresh);
    onCleanup(() =>
      window.removeEventListener("takosumi:workspaces-changed", refresh),
    );
  }
  // An errored resource throws on read; a failed list just names nothing.
  const list = (): readonly Workspace[] =>
    workspaces.error ? [] : (workspaces.latest ?? []);
  const current = () =>
    list().find((workspace) => workspace.id === currentWorkspaceId());
  return {
    list,
    current,
    /** Two or more workspaces: the only case where a page names its workspace. */
    multiple: () => list().length >= 2,
    loading: () => workspaces.loading,
  };
}

/** "スペース「仕事」" above a workspace-scoped section, only with 2+ workspaces. */
export function WorkspaceScopeNote(props: {
  readonly context: ReturnType<typeof createCurrentWorkspace>;
}) {
  return (
    <Show when={props.context.multiple() ? props.context.current() : undefined}>
      {(workspace) => (
        <p class="acct-workspace-note">
          {t("workspace.scopeNote", { name: workspaceName(workspace()) })}
        </p>
      )}
    </Show>
  );
}
