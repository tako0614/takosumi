/**
 * Global Workspace switcher — TopBar control, the single owner of "which Workspace am I
 * working in" for the whole dashboard (GitHub org-switcher analogue).
 *
 * Replaces the per-view `lib/space-state.ts` signal: every view
 * now reads the same `space-state.ts` signal this control writes. Lists Workspaces
 * via `GET /api/v1/spaces` and defaults to the first Space when none is
 * selected. Creation belongs in setup/admin flows, not in the everyday topbar.
 */
import { createResource, For, Show } from "solid-js";
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
  const [spaces] = createResource(listSpaces);

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

  return (
    <div class="topbar-space">
      <Show
        when={!spaces.loading && (spaces() ?? []).length > 0}
        fallback={
          <Select
            id="workspace-switcher"
            name="workspaceId"
            class="topbar-space-select"
            disabled
            aria-label={t("space.label")}
          >
            <option>
              {spaces.loading ? t("common.loading") : t("space.none")}
            </option>
          </Select>
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
          <For each={onLoaded(spaces() ?? [])}>
            {(s) => <option value={s.id}>@{s.handle}</option>}
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
