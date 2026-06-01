import { Title } from "@solidjs/meta";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";
import AppCard from "~/components/apps/AppCard";
import { listInstallationsForSpace } from "~/lib/api/installations";
import { ApiError } from "~/lib/api/client";

const STORAGE_KEY = "tg_apps_space_id";

export default function Apps() {
  return (
    <>
      <Title>Apps — Takosumi</Title>
      <AuthGuard>{() => <AppsInner />}</AuthGuard>
    </>
  );
}

function AppsInner() {
  const initial = typeof localStorage !== "undefined"
    ? (localStorage.getItem(STORAGE_KEY) ?? "")
    : "";
  const [spaceId, setSpaceId] = createSignal(initial);
  const [draft, setDraft] = createSignal(initial);

  const applySpace = (e: Event) => {
    e.preventDefault();
    const next = draft().trim();
    setSpaceId(next);
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  };

  const [apps] = createResource(
    () => (spaceId() ? spaceId() : null),
    listInstallationsForSpace,
  );

  const hasSpace = createMemo(() => !!spaceId());

  return (
    <AppShell>
      <div class="page-header">
        <h1>Apps</h1>
        <p class="page-sub">Space ごとの install 済みアプリを確認します。</p>
        <div class="page-actions">
          <a href="/apps/install" class="btn btn-primary">
            + Install
          </a>
        </div>
      </div>

      <section class="space-picker">
        <form onSubmit={applySpace}>
          <label>
            Space ID
            <input
              type="text"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              placeholder="space_xxxxxx"
              autocomplete="off"
            />
          </label>
          <button class="btn btn-secondary" type="submit">
            表示
          </button>
        </form>
      </section>

      <Show
        when={hasSpace()}
        fallback={
          <section class="empty-state">
            <p>space を指定するとアプリ一覧を表示します。</p>
          </section>
        }
      >
        <Switch>
          <Match when={apps.loading}>
            <div class="grid-skel">
              <div class="skel-card" />
              <div class="skel-card" />
              <div class="skel-card" />
            </div>
          </Match>
          <Match when={apps.error}>
            <section class="empty-state error-state">
              <p>取得に失敗しました — {(apps.error as ApiError).message}</p>
            </section>
          </Match>
          <Match when={apps()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <section class="empty-state">
                    <p>この space にはまだ何も installed されていません。</p>
                    <a href="/apps/install" class="btn btn-primary">
                      最初のアプリを install →
                    </a>
                  </section>
                }
              >
                <div class="apps-grid">
                  <For each={list()}>{(a) => <AppCard app={a} />}</For>
                </div>
              </Show>
            )}
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
}
