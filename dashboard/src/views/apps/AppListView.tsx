import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { Plus, Search, Settings2, Sparkles, X } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import IncomingOwnershipTransfers from "./IncomingOwnershipTransfers.tsx";
import AppFace from "../../components/AppFace.tsx";
import { resolveAppIcon } from "../../lib/app-face.ts";
import { currentWorkspaceId, selectAvailableWorkspaceId, setCurrentWorkspaceId } from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { listCapsulesCached } from "../../lib/capsule-list.ts";
import { getCapsuleAppWithSignal, listAccessibleAppsPage, type AccessibleApp } from "../../lib/control-api.ts";
import { isVisibleServiceCapsule } from "../../lib/capsules-ui.ts";
import { type AppState, appState, openableScreens } from "../../lib/app-page.ts";
import { homeAppOpens, homeAppWaiting, sortHomeApps } from "../../lib/home-launcher.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import { locale, type MessageKey, t } from "../../i18n/index.ts";
import { Button, Input, Toast } from "../../components/ui/index.ts";
import { fetchFailedMessage } from "../../lib/error-copy.ts";
import { appPageHref } from "../../lib/app-links.ts";
import { screenOpenRoute } from "../../lib/open-choice-state.ts";
import { openRouteAnchor, openRouteAria } from "../app/app-ui.tsx";

const PAGE_SIZE = 16;
const SCREEN_READS_IN_FLIGHT = 4;

interface HomeApp {
  readonly id: string;
  readonly name: string;
  readonly displayName?: AccessibleApp["displayName"];
  readonly iconUrl?: string;
  readonly category?: string;
  readonly role?: AccessibleApp["role"];
  readonly ownerDisplayName?: string;
  readonly state: AppState;
  readonly surfaces: ReturnType<typeof openableScreens>;
  readonly needsScreenRead?: boolean;
}

interface HomePage {
  readonly apps: readonly HomeApp[];
  readonly nextCursor?: string;
  readonly surfacesFailed?: boolean;
}

interface ScreenRead {
  readonly detail?: Pick<HomeApp, "surfaces" | "state" | "iconUrl" | "category">;
  readonly failed: boolean;
}

type MarkKind = "alert" | "info" | "warn" | "quiet";
const STATE_MARK: Readonly<Partial<Record<AppState, { readonly label: MessageKey; readonly kind: MarkKind }>>> = {
  needs_attention: { label: "apps.state.needsAttention", kind: "alert" },
  update_available: { label: "apps.state.updateAvailable", kind: "info" },
  installing: { label: "apps.state.installing", kind: "info" },
  uninstalling: { label: "apps.state.uninstalling", kind: "warn" },
  stopped: { label: "apps.state.stopped", kind: "quiet" },
};

export default function AppListView() {
  return <Page title={t("apps.title")}>{() => <Inner />}</Page>;
}

function homeState(state: AccessibleApp["state"]): AppState {
  switch (state) {
    case "needs_attention": return "needs_attention";
    case "update_available": return "update_available";
    case "installing": case "updating": return "installing";
    case "uninstalling": case "uninstall_scheduled": return "uninstalling";
    case "uninstalled": case "stopped": return "stopped";
    default: return "ready";
  }
}

function fromSummary(entry: AccessibleApp): HomeApp {
  const state = homeState(entry.state);
  return {
    id: entry.capsuleId, name: entry.name, displayName: entry.displayName, iconUrl: entry.iconUrl,
    role: entry.role, ownerDisplayName: entry.ownerDisplayName, state, surfaces: [],
    needsScreenRead: state === "ready" || state === "update_available" || state === "needs_attention",
  };
}

/** Only absence of the account collection route selects the old Workspace list. */
async function loadHome(workspaceId: string): Promise<HomePage> {
  const first = await listAccessibleAppsPage();
  if (first) return { ...first, apps: first.apps.map(fromSummary) };
  const workspaces = await listWorkspacesCached();
  const id = selectAvailableWorkspaceId(workspaceId, workspaces);
  setCurrentWorkspaceId(id);
  if (!id) return { apps: [] };
  const [capsules, surfaces] = await Promise.all([
    listCapsulesCached(id, { includeDestroyed: false }),
    listAuthorizedUiSurfaces(id).then((value) => ({ value, failed: false }), () => ({ value: [], failed: true })),
  ]);
  const byApp = new Map<string, (typeof surfaces.value)[number][]>();
  for (const surface of surfaces.value) {
    const own = byApp.get(surface.capsuleId);
    if (own) own.push(surface);
    else byApp.set(surface.capsuleId, [surface]);
  }
  return {
    apps: capsules.filter(isVisibleServiceCapsule).map((inst) => {
      const own = byApp.get(inst.id) ?? [];
      return { id: inst.id, name: inst.name, state: appState(inst), surfaces: own, category: own[0]?.category };
    }),
    surfacesFailed: surfaces.failed,
  };
}

function homeAppName(app: HomeApp): string {
  const label = app.displayName;
  return (typeof label === "string" ? label : label?.[locale()]) ||
    (app.surfaces.length === 1 ? app.surfaces[0]?.name : undefined) || app.name;
}

/** A summary row can link to its own page. Only an authorized screen can launch an app. */
async function readScreen(app: HomeApp, signal: AbortSignal): Promise<ScreenRead> {
  const view = await getCapsuleAppWithSignal(app.id, signal);
  const surfaces = openableScreens(view.screens);
  const state = view.state === "installed" && view.version.updateAvailable ? "update_available" : homeState(view.state);
  return {
    detail: { state, surfaces, iconUrl: app.iconUrl ?? view.iconUrl, category: view.screens[0]?.category },
    failed: view.incomplete?.includes("screens") ?? false,
  };
}

function Inner() {
  const [home, { refetch }] = createResource(
    () => ({ workspaceId: currentWorkspaceId() }),
    ({ workspaceId }) => loadHome(workspaceId),
  );
  const [extra, setExtra] = createSignal<{
    readonly pages: readonly (readonly HomeApp[])[];
    readonly nextCursor?: string;
  }>();
  const [query, setQuery] = createSignal("");
  const [page, setPage] = createSignal(0);
  const [moreFailed, setMoreFailed] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [advancing, setAdvancing] = createSignal(false);
  const [screens, setScreens] = createSignal(new Map<string, ScreenRead>());
  const [retryScreens, setRetryScreens] = createSignal(0);
  const titleId = createUniqueId();
  let searchInput: HTMLInputElement | undefined;
  let pendingPage: Promise<boolean> | undefined;
  let listRead = new AbortController();
  const seenCursors = new Set<string>();
  const retrying = new Set<string>();
  onCleanup(() => listRead.abort());

  const firstPage = () => home.error ? undefined : home.latest;
  const cursor = () => extra() ? extra()?.nextCursor : firstPage()?.nextCursor;
  const apps = createMemo(() => {
    const byId = new Map<string, HomeApp>();
    // Keep earlier pages in place when the server returns more apps.
    for (const batch of [firstPage()?.apps ?? [], ...(extra()?.pages ?? [])]) {
      for (const app of sortHomeApps(batch, homeAppName, locale())) {
        if (!byId.has(app.id)) byId.set(app.id, app);
      }
    }
    return [...byId.values()];
  });
  const names = createMemo(() => new Map(apps().map((app) => [app.id, homeAppName(app)])));
  const term = createMemo(() => query().trim().toLocaleLowerCase(locale()));
  const searchable = createMemo(() => apps().map((app) => ({
    app,
    keys: [names().get(app.id) ?? "", app.name, app.ownerDisplayName ?? ""].map((part) => part.toLocaleLowerCase(locale())),
  })));
  const matches = createMemo(() => {
    const search = term();
    return search
      ? searchable().filter(({ keys }) => keys.some((part) => part.includes(search))).map(({ app }) => app)
      : apps();
  });
  const visible = createMemo(() => matches().slice(page() * PAGE_SIZE, (page() + 1) * PAGE_SIZE), [], {
    equals: (prev, next) => prev.length === next.length && prev.every((app, i) => app === next[i]),
  });

  function loadNext(): Promise<boolean> {
    const next = cursor();
    if (pendingPage) return pendingPage;
    if (!next) return Promise.resolve(false);
    const signal = listRead.signal;
    setLoadingMore(true);
    setMoreFailed(false);
    pendingPage = listAccessibleAppsPage(next, signal).then((data) => {
      if (signal.aborted || !data) return false;
      if (data.nextCursor && (data.nextCursor === next || seenCursors.has(data.nextCursor))) {
        setMoreFailed(true);
        return false;
      }
      seenCursors.add(next);
      setExtra((previous) => ({ pages: [...(previous?.pages ?? []), data.apps.map(fromSummary)], nextCursor: data.nextCursor }));
      return true;
    }, () => {
      if (!signal.aborted) setMoreFailed(true);
      return false;
    }).finally(() => {
      if (!signal.aborted) {
        pendingPage = undefined;
        setLoadingMore(false);
      }
    });
    return pendingPage;
  }

  function changeQuery(value: string) {
    batch(() => { setPage(0); setQuery(value); });
  }
  function clearSearch() { changeQuery(""); searchInput?.focus(); }
  async function forward() {
    const next = page() + 1;
    const signal = listRead.signal;
    const search = term();
    setAdvancing(true);
    try {
      // An intervening server page may have no apps in the selected group.
      while (matches().length <= next * PAGE_SIZE && cursor()) {
        if (!await loadNext() || term() !== search) return;
      }
      if (!signal.aborted && matches().length > next * PAGE_SIZE) setPage(next);
    } finally {
      if (!signal.aborted) setAdvancing(false);
    }
  }
  async function refresh() {
    listRead.abort();
    listRead = new AbortController();
    seenCursors.clear();
    retrying.clear();
    pendingPage = undefined;
    const requested = refetch();
    batch(() => {
      setExtra(undefined); setPage(0); setLoadingMore(false); setMoreFailed(false); setAdvancing(false);
      setScreens(new Map()); setRetryScreens((n) => n + 1);
    });
    await requested;
  }

  // Browse one server page at a time. Search can cover every name by reading
  // the remaining summaries, without fetching details for unrelated apps.
  createEffect(() => {
    if (term() && cursor() && !loadingMore() && !moreFailed() && !home.loading) void untrack(loadNext);
  });

  createEffect(() => {
    retryScreens();
    const shown = visible();
    // Keep successful projections across pages, but cancel work
    // for icons that leave the view. No late response can change the layout's order.
    const pending = untrack(() => shown.filter((app) => app.needsScreenRead && (!screens().has(app.id) || retrying.has(app.id))));
    const controller = new AbortController();
    const { signal } = controller;
    onCleanup(() => controller.abort());
    let index = 0;
    async function worker() {
      while (index < pending.length && !signal.aborted) {
        const app = pending[index++]!;
        const result = await readScreen(app, signal).catch(() => ({ failed: true }));
        if (!signal.aborted) {
          retrying.delete(app.id);
          setScreens((previous) => new Map(previous).set(app.id, result));
        }
      }
    }
    // Let the summary paint before kicking off the first detail batch.
    if (pending.length === 0) return;
    const timer = requestAnimationFrame(() => {
      for (let i = 0; i < Math.min(SCREEN_READS_IN_FLIGHT, pending.length); i++) void worker();
    });
    onCleanup(() => cancelAnimationFrame(timer));
  });

  const failedScreens = () => visible().some((app) => screens().get(app.id)?.failed);
  function retryVisible() {
    for (const app of visible()) if (screens().get(app.id)?.failed) retrying.add(app.id);
    setRetryScreens((n) => n + 1);
  }
  const hasNext = () => matches().length > (page() + 1) * PAGE_SIZE || Boolean(cursor());

  return (
    <>
      <IncomingOwnershipTransfers appNames={names()} onChanged={refresh} />
      <div data-testid="home-apps">
        <Switch>
          <Match when={home.loading && !firstPage()}><LauncherSkeleton /></Match>
          <Match when={home.error}>
            <Toast tone="error">{fetchFailedMessage(home.error, t)}
              <Button variant="secondary" size="sm" type="button" onClick={() => void refresh()}>{t("common.retry")}</Button>
            </Toast>
          </Match>
          <Match when={firstPage()}>
            <Show when={apps().length > 0 || cursor()} fallback={<AppStartPanel />}>
              <div class="av-section-head">
                <h1 id={titleId}>{t("apps.sectionYours")}</h1>
                <Show when={!cursor()}>
                  <span class="av-section-head-count">{apps().length}</span>
                </Show>
              </div>
              <div class="av-home-search" role="search" aria-label={t("apps.search")}>
                <Search size={18} aria-hidden="true" />
                <Input
                  ref={searchInput}
                  type="search"
                  aria-label={t("apps.search")}
                  placeholder={t("apps.search")}
                  value={query()}
                  onInput={(event) => changeQuery(event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") clearSearch(); }}
                />
                <Show when={query()}>
                  <button type="button" aria-label={t("apps.clearSearch")} onClick={clearSearch}>
                    <X size={18} aria-hidden="true" />
                  </button>
                </Show>
              </div>
              <Show when={firstPage()?.surfacesFailed || failedScreens()}>
                <Toast tone="error">
                  {t("apps.listIncomplete")}
                  <Button variant="secondary" size="sm" type="button" onClick={() => firstPage()?.surfacesFailed ? void refresh() : retryVisible()}>{t("common.retry")}</Button>
                </Toast>
              </Show>
              <Show when={moreFailed()}>
                <Toast tone="error">
                  {t("apps.moreFailed")}
                  <Button variant="secondary" size="sm" type="button" onClick={() => void loadNext()}>{t("common.retry")}</Button>
                </Toast>
              </Show>
              <Show when={term() && !matches().length && !cursor()}>
                <p class="av-search-empty" role="status">{t("apps.noMatches")}</p>
              </Show>
              <ul class="av-launcher" aria-labelledby={titleId}>
                <For each={visible()}>
                  {(app) => <HomeAppTile name={names().get(app.id) ?? app.name} app={{ ...app, ...screens().get(app.id)?.detail }} />}
                </For>
                <Show when={!term()}>
                  <li>
                    <a class="av-tile av-tile-add" href="/new">
                      <span class="av-tile-icon" aria-hidden="true"><Plus /></span>
                      <span class="av-tile-name">{t("apps.browse")}</span>
                    </a>
                  </li>
                </Show>
              </ul>
              <Show when={page() > 0 || hasNext() || loadingMore()}>
                <nav class="av-launcher-pages" aria-label={t("apps.pages")}>
                  <Show when={page() > 0}>
                    <Button variant="secondary" size="sm" type="button" disabled={advancing()} onClick={() => setPage((n) => n - 1)}>
                      {t("apps.previous")}
                    </Button>
                  </Show>
                  <Show when={loadingMore()}>
                    <span role="status">{t("common.loading")}</span>
                  </Show>
                  <Show when={hasNext() && (!term() || matches().length > (page() + 1) * PAGE_SIZE)}>
                    <Button variant="secondary" size="sm" type="button" disabled={advancing()} onClick={() => void forward()}>
                      {t("apps.next")}
                    </Button>
                  </Show>
                </nav>
              </Show>
            </Show>
          </Match>
        </Switch>
      </div>
    </>
  );
}

function kindClass(kind: string | undefined): string {
  return kind === "site" || kind === "storage" || kind === "worker"
    ? `av-tile-k-${kind}`
    : "av-tile-k-default";
}

function HomeAppTile(props: { readonly name: string; readonly app: HomeApp }) {
  const name = () => props.name;
  const icon = createMemo(() => {
    const surface = props.app.surfaces[0];
    return surface ? resolveAppIcon(surface.icon, surface.url) : {};
  });
  const mark = () => STATE_MARK[props.app.state];
  const shared = () => props.app.role === "member";
  const captionId = createUniqueId();
  const describedBy = () => (mark() || shared() ? captionId : undefined);
  const route = createMemo(() => {
    const surface = homeAppOpens(props.app) ? props.app.surfaces[0] : undefined;
    return surface ? screenOpenRoute(props.app.id, surface) : undefined;
  });
  const pageHref = () => appPageHref(props.app.id);
  const anchor = createMemo(() => { const open = route(); return open && openRouteAnchor(open); });
  const settings = () => props.app.state === "ready" || props.app.state === "update_available";

  return (
    <li
      data-testid="home-app"
      data-app-state={props.app.state}
      data-app-opens={Boolean(route()) ? "true" : "false"}
      data-capsule-id={props.app.id}
    >
      <span class="av-tile-wrap">
        <a
          class="av-tile"
          classList={{ "av-tile-waiting": homeAppWaiting(props.app) }}
          href={anchor()?.href ?? pageHref()}
          target={anchor()?.target}
          rel={anchor()?.rel}
          data-open-route={route()?.kind}
          aria-label={route() ? openRouteAria(route()!, name()) : name()}
          aria-describedby={describedBy()}
        >
          <span class="av-tile-face">
            <AppFace
              class="av-tile-icon"
              imageFrameClass="av-tile-icon-image"
              monogramFrameClass={kindClass(props.app.category)}
              imageClass="av-tile-image"
              emojiClass="av-tile-emoji"
              monogramClass="av-tile-mono"
              name={name()}
              iconUrl={props.app.iconUrl ?? icon().imageSrc}
              emoji={icon().emoji}
            />
            <Show when={mark()}>
              {(state) => <span class={`av-tile-dot av-tile-dot-${state().kind}`} aria-hidden="true" />}
            </Show>
          </span>
          <span class="av-tile-label">
            <span class="av-tile-name">{name()}</span>
            <Show when={describedBy()}>
              <span class="av-tile-captions" id={captionId}>
                <Show when={mark()}>
                  {(state) => <span class={`av-tile-state av-tile-state-${state().kind}`}>{t(state().label)}</span>}
                </Show>
                <Show when={shared()}>
                  <span class="av-tile-state">{props.app.ownerDisplayName ? t("app.sharing.sharedBy", { name: props.app.ownerDisplayName }) : t("apps.shared")}</span>
                </Show>
              </span>
            </Show>
          </span>
        </a>
        <Show when={settings() || route()}>
          <span class="av-tile-actions">
            <a
              class="av-tile-manage"
              href={settings() ? appPageHref(props.app.id, "settings") : pageHref()}
              aria-label={t(settings() ? "apps.settingsAria" : "apps.manageAria", { name: name() })}
            >
              <Settings2 size={13} aria-hidden="true" />
              <span>{t(settings() ? "app.settings.title" : "apps.manage")}</span>
            </a>
          </span>
        </Show>
      </span>
    </li>
  );
}

function LauncherSkeleton() {
  return (
    <ul class="av-launcher" aria-hidden="true">
      <For each={[0, 1, 2, 3, 4, 5]}>
        {() => <li><span class="av-tile"><span class="tg-skel av-tile-skel" /></span></li>}
      </For>
    </ul>
  );
}

function AppStartPanel() {
  return (
    <section class="av-start" aria-label={t("apps.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("apps.start.kicker")}</span>
        <h2 class="av-start-title">{t("apps.start.titleEmpty")}</h2>
        <p class="av-start-sub">{t("apps.start.bodyEmpty")}</p>
      </div>
      <a href="/new" class="av-start-action">
        <Sparkles size={18} aria-hidden="true" />
        <span>{t("apps.start.optionStore")}</span>
      </a>
    </section>
  );
}
