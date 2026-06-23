/**
 * Global Workspace switcher — TopBar control, the single owner of "which Workspace am I
 * working in" for the whole dashboard (GitHub org-switcher analogue).
 *
 * Replaces the per-view `lib/space-state.ts` signal: every view
 * now reads the same `space-state.ts` signal this control writes. Lists Workspaces
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
  listSpaces,
  type Space,
} from "../../../../lib/control-api.ts";
import {
  currentSpaceId,
  selectAvailableSpaceId,
  setCurrentSpaceId,
} from "../../../../lib/space-state.ts";
import { t } from "../../../../i18n/index.ts";
import { Select } from "../../../../components/ui/Form.tsx";

export default function SpaceSwitcher() {
  const [spaces, { refetch }] = createResource(listSpaces);
  const loadedSpaces = createMemo(() => spaces() ?? []);

  // Reconcile persisted Workspace selection after sign-in. A browser can keep
  // the previous user's localStorage value, so never keep an id that is absent
  // from the loaded Workspace list.
  const onLoaded = (list: readonly Space[]) => {
    const next = selectAvailableSpaceId(currentSpaceId(), list);
    if (next !== currentSpaceId()) {
      setCurrentSpaceId(next);
    }
    return list;
  };

  createEffect(() => {
    if (spaces.loading) return;
    onLoaded(loadedSpaces());
  });

  if (typeof window !== "undefined") {
    const refreshSpaces = () => void refetch();
    window.addEventListener("takosumi:spaces-changed", refreshSpaces);
    onCleanup(() =>
      window.removeEventListener("takosumi:spaces-changed", refreshSpaces),
    );
  }

  return (
    <div class="topbar-space">
      <Show
        when={!spaces.loading && loadedSpaces().length > 1}
        fallback={
          <Show when={!spaces.loading && loadedSpaces().length === 0}>
            <span class="topbar-space-empty">{t("space.none")}</span>
          </Show>
        }
      >
        <Select
          id="workspace-switcher"
          name="workspaceId"
          class="topbar-space-select"
          aria-label={t("space.label")}
          value={currentSpaceId()}
          onChange={(e) => setCurrentSpaceId(e.currentTarget.value)}
        >
          <For each={loadedSpaces()}>
            {(s) => <option value={s.id}>{s.displayName || s.handle}</option>}
          </For>
        </Select>
      </Show>

      <Show when={spaces.error}>
        <span class="topbar-space-error" role="alert">
          {t("space.loadFailed", {
            message: (spaces.error as ControlApiError).message,
          })}
        </span>
      </Show>
    </div>
  );
}
