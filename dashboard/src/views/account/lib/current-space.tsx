/**
 * The selected space as the space-scoped pages show it. Spaces stay out of
 * the way: a page names the space it is showing only when there are two or
 * more, so one person with one space never reads the word.
 */
import { createResource, onCleanup, Show } from "solid-js";
import { listWorkspacesCached } from "../../../lib/workspace-list.ts";
import { currentWorkspaceId } from "../../../lib/workspace-state.ts";
import { spaceName } from "../../../lib/space-labels.ts";
import type { Workspace } from "../../../lib/control-api.ts";
import { t } from "../../../i18n/index.ts";

export function createCurrentSpace() {
  const [spaces, { refetch }] = createResource(
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
    spaces.error ? [] : (spaces.latest ?? []);
  const current = () =>
    list().find((workspace) => workspace.id === currentWorkspaceId());
  return {
    list,
    current,
    /** Two or more spaces: the only case where a page names its space. */
    multiple: () => list().length >= 2,
    loading: () => spaces.loading,
  };
}

/** "スペース「仕事」" above a space-scoped section, only with 2+ spaces. */
export function SpaceScopeNote(props: {
  readonly space: ReturnType<typeof createCurrentSpace>;
}) {
  return (
    <Show when={props.space.multiple() ? props.space.current() : undefined}>
      {(workspace) => (
        <p class="acct-space-note">
          {t("space.scopeNote", { name: spaceName(workspace()) })}
        </p>
      )}
    </Show>
  );
}
