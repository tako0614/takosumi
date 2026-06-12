import "../../styles/wave-d.css";
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Box } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import AppCard from "../account/components/AppCard.tsx";
import { ApiError, rpc } from "../account/lib/api.ts";
import {
  Button,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.ts";

// localStorage key preserved from the takosumi dashboard-ui port so a
// previously-selected space survives the migration into the takos SPA.
const STORAGE_KEY = "tg_apps_space_id";

/**
 * Apps list (Installations index).
 *
 * Ported from takosumi dashboard-ui `routes/apps/index.tsx`. A space-id picker
 * plus a grid of {@link AppCard}, listing the installed apps for the selected
 * space via `GET /v1/app-installations?space_id=<id>` (the same-origin account
 * plane mounted in-process). Ported as-is to avoid behaviour change; in the
 * single-operator world the manual picker may later be replaced by
 * `useAuth().spaces`.
 */
export default function InstallationsListView() {
  return <Page title="アプリ">{() => <InstallationsListInner />}</Page>;
}

function InstallationsListInner() {
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
    rpc.installations.list,
  );

  const hasSpace = createMemo(() => !!spaceId());

  return (
    <AppShell>
      <PageHeader
        eyebrow="Installations"
        title="アプリ"
        subtitle="Space ごとの導入済みアプリを確認します。"
        actions={
          <Button href="/install" variant="primary">
            + アプリを追加
          </Button>
        }
      />

      <form class="wave-d-picker" onSubmit={applySpace}>
        <FormField label="Space ID">
          <Input
            type="text"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            placeholder="space_xxxxxx"
            autocomplete="off"
          />
        </FormField>
        <Button type="submit" variant="secondary">
          表示
        </Button>
      </form>

      <Show
        when={hasSpace()}
        fallback={
          <EmptyState
            ink
            icon={<Box size={28} />}
            title="Space を選択してください"
            message="Space を指定するとアプリ一覧を表示します。"
          />
        }
      >
        <Switch>
          <Match when={apps.loading}>
            <div class="wave-d-apps-grid">
              <Skeleton variant="card" count={3} />
            </div>
          </Match>
          <Match when={apps.error}>
            <EmptyState
              icon={<Box size={28} />}
              title="取得に失敗しました"
              message={(apps.error as ApiError).message}
            />
          </Match>
          <Match when={apps()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <EmptyState
                    ink
                    icon={<Box size={28} />}
                    title="まだアプリがありません"
                    message="この Space にはまだアプリがありません。"
                    action={
                      <Button href="/install" variant="primary">
                        最初のアプリを追加 →
                      </Button>
                    }
                  />
                }
              >
                <div class="wave-d-apps-grid">
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
