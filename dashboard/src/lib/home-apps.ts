import { batch, createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js";
import { sortHomeApps } from "./home-launcher.ts";
import { getCapsuleAppWithSignal, listAccessibleAppsPage, resetAppOwnershipCache, type AccessibleApp } from "./control-api.ts";
import { currentWorkspaceId, selectAvailableWorkspaceId, setCurrentWorkspaceId } from "./workspace-state.ts";
import { listWorkspacesCached } from "./workspace-list.ts";
import { listCapsulesCached } from "./capsule-list.ts";
import { isVisibleServiceCapsule } from "./capsules-ui.ts";
import { type AppState, appState, openableScreens } from "./app-page.ts";
import { listAuthorizedUiSurfaces } from "./ui-surface-interfaces.ts";
import { locale } from "../i18n/index.ts";

/** Home read model and compatibility adapter for older Takosumi servers. */
export interface HomeApp {
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
  readonly screensFailed?: boolean;
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
    role: entry.role, ownerDisplayName: entry.ownerDisplayName, state,
    surfaces: openableScreens(entry.screens ?? []), category: entry.screens?.[0]?.category,
    screensFailed: entry.incomplete?.includes("screens"),
    needsScreenRead: entry.screens === undefined && (state === "ready" || state === "update_available" || state === "needs_attention"),
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
  return (typeof label === "string" ? label : label?.[locale()]) || app.name ||
    (app.surfaces.length === 1 ? app.surfaces[0]?.name : undefined) || app.id;
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


/** Owns collection paging, search and the old-server launch adapter. No DOM or account mutations. */
export function createHomeLibrary() {
  const SCREEN_READS_IN_FLIGHT = 4;
  const [home, { refetch }] = createResource(
    () => ({ workspaceId: currentWorkspaceId() }),
    ({ workspaceId }) => loadHome(workspaceId),
  );
  const [extra, setExtra] = createSignal<{
    readonly pages: readonly (readonly HomeApp[])[];
    readonly nextCursor?: string;
  }>();
  const [query, setQuery] = createSignal("");
  const [visible, setVisible] = createSignal<readonly HomeApp[]>([]);
  const [moreFailed, setMoreFailed] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [screens, setScreens] = createSignal(new Map<string, ScreenRead>());
  const [retryScreens, setRetryScreens] = createSignal(0);
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

  async function refresh() {
    listRead.abort();
    listRead = new AbortController();
    seenCursors.clear();
    retrying.clear();
    pendingPage = undefined;
    resetAppOwnershipCache();
    const requested = refetch();
    batch(() => {
      setExtra(undefined); setLoadingMore(false); setMoreFailed(false);
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

  const failedScreens = () => visible().some((app) => app.screensFailed || screens().get(app.id)?.failed);
  function retryVisible() {
    if (visible().some((app) => app.screensFailed)) { void refresh(); return; }
    for (const app of visible()) if (screens().get(app.id)?.failed) retrying.add(app.id);
    setRetryScreens((n) => n + 1);
  }

  return { home, firstPage, cursor, apps, names, query, setQuery, term, matches,
    setVisible, screens, loadingMore, moreFailed, failedScreens, retryVisible, refresh, loadNext };
}
