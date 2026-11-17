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
  readonly workspaceId: string;
  readonly requestedQuery: string;
  readonly appliedQuery?: string;
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
    id: entry.capsuleId, name: entry.name ?? entry.capsuleId, displayName: entry.displayName, iconUrl: entry.iconUrl,
    role: entry.role, ownerDisplayName: entry.ownerDisplayName, state,
    surfaces: openableScreens(entry.screens ?? []), category: entry.screens?.[0]?.category,
    screensFailed: entry.incomplete?.includes("screens"),
    needsScreenRead: entry.screens === undefined && (state === "ready" || state === "update_available" || state === "needs_attention"),
  };
}

/** Only absence of the account collection route selects the old Workspace list. */
async function loadHome(workspaceId: string, q: string, signal: AbortSignal): Promise<HomePage> {
  const first = await listAccessibleAppsPage(undefined, signal, q);
  const scope = { workspaceId, requestedQuery: q };
  if (first) return { ...first, ...scope, apps: first.apps.map(fromSummary) };
  const workspaces = await listWorkspacesCached();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const id = selectAvailableWorkspaceId(workspaceId, workspaces);
  setCurrentWorkspaceId(id);
  if (!id) return { ...scope, apps: [] };
  const [capsules, surfaces] = await Promise.all([
    listCapsulesCached(id, { includeDestroyed: false }),
    listAuthorizedUiSurfaces(id).then((value) => ({ value, failed: false }), () => ({ value: [], failed: true })),
  ]);
  const byApp = new Map<string, (typeof surfaces.value)[number][]>();
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  for (const surface of surfaces.value) {
    const own = byApp.get(surface.capsuleId);
    if (own) own.push(surface);
    else byApp.set(surface.capsuleId, [surface]);
  }
  return {
    ...scope,
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
  const [extra, setExtra] = createSignal<{
    readonly pages: readonly (readonly HomeApp[])[];
    readonly nextCursor?: string;
  }>();
  const [query, setQueryValue] = createSignal("");
  const [acceptedPage, setAcceptedPage] = createSignal<HomePage>();
  const [browsePage, setBrowsePage] = createSignal<HomePage>();
  const term = createMemo(() => query().trim().toLowerCase());
  const [serverQuery, setServerQuery] = createSignal("");
  const [requestRevision, setRequestRevision] = createSignal(0);
  const [visible, setVisible] = createSignal<readonly HomeApp[]>([]);
  const [moreFailed, setMoreFailed] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [seekNextMatch, setSeekNextMatch] = createSignal(false);
  const [screens, setScreens] = createSignal(new Map<string, ScreenRead>());
  const [retryScreens, setRetryScreens] = createSignal(0);
  let pendingPage: Promise<boolean> | undefined;
  let listRead = new AbortController();
  const [requestInvalidated, setRequestInvalidated] = createSignal(false);
  const seenCursors = new Set<string>();
  const retrying = new Set<string>();
  onCleanup(() => listRead.abort());

  function resetCollection() {
    listRead.abort();
    listRead = new AbortController();
    seenCursors.clear(); retrying.clear(); pendingPage = undefined;
    batch(() => {
      setExtra(undefined); setLoadingMore(false); setMoreFailed(false); setSeekNextMatch(false);
      setScreens(new Map()); setVisible([]); setRetryScreens((n) => n + 1);
    });
  }

  function setQuery(value: string) {
    batch(() => {
      if (value.trim().toLowerCase() !== term()) { resetCollection(); setRequestInvalidated(true); }
      setQueryValue(value);
    });
  }

  const [home, { refetch }] = createResource(
    () => ({ workspaceId: currentWorkspaceId(), q: serverQuery(), revision: requestRevision() }),
    async ({ workspaceId, q }) => {
      resetCollection();
      setRequestInvalidated(false);
      const signal = listRead.signal;
      const isCurrent = () => !signal.aborted && q === term() && workspaceId === currentWorkspaceId();
      try {
        const page = await loadHome(workspaceId, q, signal);
        if (!isCurrent()) return undefined;
        batch(() => { setAcceptedPage(page); if (!q) setBrowsePage(page); });
        return page;
      } catch (error) {
        if (!isCurrent()) return undefined;
        throw error;
      }
    },
  );
  createEffect(() => {
    const q = term();
    const commitQuery = () => {
      if (q !== untrack(serverQuery)) setServerQuery(q);
      else if (untrack(requestInvalidated)) setRequestRevision((n) => n + 1);
    };
    if (!q) { commitQuery(); return; }
    const timer = setTimeout(commitQuery, 200);
    onCleanup(() => clearTimeout(timer));
  });

  const firstPage = () => {
    if (home.error) return undefined;
    const page = acceptedPage();
    if (page?.workspaceId === currentWorkspaceId() && page.requestedQuery === term()) return page;
    // While typing retain only the last accepted browse preview, never old search results.
    const browse = browsePage();
    return browse?.workspaceId === currentWorkspaceId() ? browse : undefined;
  };
  const cursor = () => firstPage()?.requestedQuery !== serverQuery() || term() !== serverQuery()
    ? undefined : extra() ? extra()?.nextCursor : firstPage()?.nextCursor;
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
  const searchable = createMemo(() => apps().map((app) => ({
    app,
    keys: [app.name, ...(typeof app.displayName === "string" ? [app.displayName] : Object.values(app.displayName ?? {})),
      app.role === "member" ? app.ownerDisplayName ?? "" : ""].map((part) => part.toLowerCase()),
  })));
  const matches = createMemo(() => {
    const search = term();
    if (firstPage()?.appliedQuery === search) return apps();
    return search
      ? searchable().filter(({ keys }) => keys.some((part) => part.includes(search))).map(({ app }) => app)
      : apps();
  });

  function loadNext(): Promise<boolean> {
    const next = cursor();
    if (pendingPage) return pendingPage;
    if (!next || home.loading) return Promise.resolve(false);
    const signal = listRead.signal;
    const q = term();
    const workspaceId = currentWorkspaceId();
    const appliedQuery = firstPage()?.appliedQuery;
    const isCurrent = () => !signal.aborted && q === term() && workspaceId === currentWorkspaceId();
    setLoadingMore(true);
    setMoreFailed(false);
    pendingPage = listAccessibleAppsPage(next, signal, q).then((data) => {
      if (!isCurrent()) return false;
      if (!data || data.appliedQuery !== appliedQuery) { setMoreFailed(true); return false; }
      if (data.nextCursor && (data.nextCursor === next || seenCursors.has(data.nextCursor))) {
        setMoreFailed(true);
        return false;
      }
      const page = data.apps.map(fromSummary);
      seenCursors.add(next);
      setSeekNextMatch(page.length === 0 && data.nextCursor !== undefined);
      setExtra((previous) => ({ pages: [...(previous?.pages ?? []), page], nextCursor: data.nextCursor }));
      return true;
    }).catch(() => {
      if (isCurrent()) setMoreFailed(true);
      return false;
    }).finally(() => {
      if (isCurrent()) {
        pendingPage = undefined;
        setLoadingMore(false);
      }
    });
    return pendingPage;
  }

  async function refresh() {
    resetAppOwnershipCache();
    await refetch();
  }

  const searchComplete = () => Boolean(firstPage() && firstPage()!.requestedQuery === term() &&
    serverQuery() === term() && !requestInvalidated() && !home.loading && !home.error && !cursor() && !loadingMore() &&
    !moreFailed() && !firstPage()?.surfacesFailed);
  const searching = () => Boolean(term() && !home.error && !moreFailed() &&
    (requestInvalidated() || serverQuery() !== term() || home.loading || loadingMore()));

  // Modern search continues only across empty candidate pages; nonempty pages
  // wait for scrolling. Legacy servers still need a full client-side search.
  createEffect(() => {
    if (term() && cursor() && !loadingMore() && !moreFailed() && !home.loading &&
      (firstPage()?.appliedQuery === undefined || apps().length === 0 || seekNextMatch())) void untrack(loadNext);
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
    searchComplete, searching, setVisible, screens, loadingMore, moreFailed, failedScreens, retryVisible, refresh, loadNext };
}
