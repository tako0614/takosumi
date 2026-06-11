/**
 * Space selector (spec §31) — the header control listing deploy-control Spaces.
 *
 * Lists Spaces via `GET /api/v1/spaces`, reflects the shared current-space
 * state (space-state.ts, persisted in localStorage like the rest of the
 * dashboard), and offers "+ New Space" (`POST /api/v1/spaces`). Rendered at
 * the top of every control view so the operator can switch Spaces from anywhere
 * in the §31 surface.
 */
import { createResource, createSignal, For, Show } from "solid-js";
import {
  type ControlApiError,
  createSpace,
  listSpaces,
  type Space,
} from "../../lib/control-api.ts";
import {
  currentSpaceId,
  setCurrentSpaceId,
} from "./space-state.ts";

export default function SpaceSelector() {
  const [spaces, { refetch }] = createResource(listSpaces);
  const [creating, setCreating] = createSignal(false);
  const [handle, setHandle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // When a Space is loaded and none is selected yet, default to the first one
  // so views are not stuck on the "select a space" empty state on first visit.
  const onLoaded = (list: readonly Space[]) => {
    if (!currentSpaceId() && list.length > 0) {
      setCurrentSpaceId(list[0]!.id);
    }
    return list;
  };

  const submitNew = async (e: Event) => {
    e.preventDefault();
    const h = handle().trim();
    if (!h) {
      setError("ハンドルを入力してください。");
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
    <section class="space-selector">
      <div class="space-selector-row">
        <label class="space-selector-field">
          <span class="space-selector-label">Space</span>
          <Show
            when={!spaces.loading && (spaces() ?? []).length > 0}
            fallback={
              <select disabled>
                <option>
                  {spaces.loading ? "読み込み中..." : "Space がありません"}
                </option>
              </select>
            }
          >
            <select
              value={currentSpaceId()}
              onChange={(e) => setCurrentSpaceId(e.currentTarget.value)}
            >
              <For each={onLoaded(spaces() ?? [])}>
                {(s) => (
                  <option value={s.id}>
                    @{s.handle} — {s.displayName}
                  </option>
                )}
              </For>
            </select>
          </Show>
        </label>

        <button
          class="btn btn-secondary btn-sm"
          type="button"
          onClick={() => setCreating((v) => !v)}
        >
          {creating() ? "キャンセル" : "+ 新しい Space"}
        </button>
      </div>

      <Show when={spaces.error}>
        <p class="sign-in-error">
          Space の取得に失敗しました — {(spaces.error as ControlApiError).message}
        </p>
      </Show>

      <Show when={creating()}>
        <form class="space-selector-create" onSubmit={submitNew}>
          <label class="form-field">
            ハンドル（@なし）
            <input
              type="text"
              value={handle()}
              onInput={(e) => setHandle(e.currentTarget.value)}
              placeholder="my-space"
              autocomplete="off"
              spellcheck={false}
            />
          </label>
          <button class="btn btn-primary btn-sm" type="submit" disabled={busy()}>
            {busy() ? "作成中..." : "作成"}
          </button>
          <Show when={error()}>
            {(m) => <p class="sign-in-error">{m()}</p>}
          </Show>
        </form>
      </Show>
    </section>
  );
}
