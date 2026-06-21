/**
 * Global Workspace switcher — TopBar control, the single owner of "which Workspace am I
 * working in" for the whole dashboard (GitHub org-switcher analogue).
 *
 * Replaces the per-view `lib/space-state.ts` signal: every view
 * now reads the same `space-state.ts` signal this control writes. Lists Workspaces
 * via `GET /api/v1/spaces`, defaults to the first Space when none is selected
 * (a personal Space is auto-created on first login, so views are not stuck on
 * an empty state), and offers an inline "new Space" popover
 * (`POST /api/v1/spaces`).
 */
import { createResource, createSignal, For, Show } from "solid-js";
import { Plus } from "lucide-solid";
import {
  type ControlApiError,
  createSpace,
  listSpaces,
  type Space,
} from "../../../../lib/control-api.ts";
import {
  currentSpaceId,
  selectAvailableSpaceId,
  setCurrentSpaceId,
} from "../../../../lib/space-state.ts";
import { t } from "../../../../i18n/index.ts";
import Button from "../../../../components/ui/Button.tsx";
import { Input, Select } from "../../../../components/ui/Form.tsx";

export default function SpaceSwitcher() {
  const [spaces, { refetch }] = createResource(listSpaces);
  const [creating, setCreating] = createSignal(false);
  const [handle, setHandle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

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

  const submitNew = async (e: Event) => {
    e.preventDefault();
    const h = handle().trim();
    if (!h) {
      setError(t("space.handleRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const space = await createSpace({ handle: h });
      setCurrentSpaceId(space.id);
      setHandle("");
      setCreating(false);
      await refetch();
    } catch (err) {
      setError((err as ControlApiError).message ?? String(err));
    } finally {
      setBusy(false);
    }
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

      <button
        type="button"
        class="topbar-icon-btn topbar-create-space"
        aria-label={t("space.new")}
        aria-expanded={creating()}
        onClick={() => setCreating((v) => !v)}
      >
        <Plus size={16} />
      </button>

      <Show when={creating()}>
        <form class="topbar-space-pop" onSubmit={submitNew}>
          <label class="topbar-space-pop-label" for="new-space-handle">
            {t("space.handleLabel")}
          </label>
          <Input
            id="new-space-handle"
            type="text"
            value={handle()}
            onInput={(e) => setHandle(e.currentTarget.value)}
            placeholder={t("space.handlePlaceholder")}
            autocomplete="off"
            spellcheck={false}
          />
          <div class="topbar-space-pop-actions">
            <Button variant="primary" size="sm" type="submit" busy={busy()}>
              {busy() ? t("common.creating") : t("common.create")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setCreating(false)}
            >
              {t("common.cancel")}
            </Button>
          </div>
          <Show when={error()}>
            {(m) => (
              <p class="topbar-space-pop-error" role="alert">
                {m()}
              </p>
            )}
          </Show>
        </form>
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
