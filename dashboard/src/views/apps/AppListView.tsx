/**
 * Apps home (`/`) — the Workspace app launcher. Installed state comes from
 * Capsule records, while every visible/openable tile comes from an authorized
 * Capsule-owned `interface.ui.surface` Interface. Store metadata and OpenTofu
 * Outputs are never launcher authorities. The full Capsule list and OpenTofu
 * detail live on the separate `/services` page.
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Plus, Settings2, Sparkles } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
  setCurrentWorkspaceId,
} from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import {
  clearDashboardOverviewCache,
  getDashboardOverviewCached,
} from "../../lib/dashboard-overview.ts";
import {
  clearCapsuleListCache,
  listCapsulesCached,
} from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearInstallConfigListCache } from "../../lib/install-config-list.ts";
import {
  type ControlApiError,
  createWorkspace,
  type Capsule,
  type Workspace,
} from "../../lib/control-api.ts";
import {
  type AppSurface,
  isUrlString,
  isVisibleServiceCapsule,
  needsAttention,
} from "../../lib/capsules-ui.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import { refreshSession } from "../account/lib/session.ts";
import { locale, t } from "../../i18n/index.ts";
import { Button, Toast } from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";

/** One launcher tile: a Takosumi-owned surface belonging to a service. */
interface AppTile {
  readonly inst: Capsule;
  readonly surface: AppSurface;
  readonly key: string;
}

export default function AppListView() {
  return <Page title={t("apps.title")}>{() => <Inner />}</Page>;
}

/** Kind key for the tinted monogram fallback tile (worker/site/storage/…). */
function kindClass(kind: string | undefined): string {
  switch (kind) {
    case "site":
    case "storage":
    case "worker":
      return `av-tile-k-${kind}`;
    default:
      return "av-tile-k-default";
  }
}

/**
 * Fallback face when Takosumi has no icon metadata: initials on a kind-tinted
 * tile. Distinct-by-name + distinct-by-kind keeps unknown services from reading
 * as identical boxes (configured image / emoji icons are preferred).
 */
function monogramInitials(name: string): string {
  const segments = name.split(/[-_\s./]+/).filter(Boolean);
  const chars = (segments[0]?.[0] ?? name[0] ?? "?") + (segments[1]?.[0] ?? "");
  return chars.toUpperCase().slice(0, 2);
}

function Inner() {
  const navigate = useNavigate();
  const workspaceId = () => currentWorkspaceId() || undefined;
  let recoveringWorkspaceSelection = false;

  const clearWorkspaceProjectionCaches = (id: string) => {
    clearDashboardOverviewCache(id);
    clearCapsuleListCache(id);
    clearCurrentStateVersionCache(id);
    clearInstallConfigListCache(id);
  };

  const ensureAccessibleWorkspaceSelection = async (
    options: { readonly force?: boolean } = {},
  ) => {
    if (recoveringWorkspaceSelection) return;
    recoveringWorkspaceSelection = true;
    try {
      const current = currentWorkspaceId();
      const workspaces = await listWorkspacesCached({
        force: options.force,
        selectedWorkspaceId: current || undefined,
      });
      const chosen = selectAvailableWorkspaceId(current, workspaces);
      if (chosen !== current) {
        if (current) clearWorkspaceProjectionCaches(current);
        setCurrentWorkspaceId(chosen);
      }
    } finally {
      recoveringWorkspaceSelection = false;
    }
  };

  onMount(async () => {
    try {
      await ensureAccessibleWorkspaceSelection();
    } catch {
      // The shell workspace switcher and empty-state action handle this case.
    }
  });

  const [overview, { refetch: refetchOverview }] = createResource(
    workspaceId,
    (id) => getDashboardOverviewCached(id, { capsuleLimit: 500 }),
  );
  createEffect(() => {
    const error = overview.error as ControlApiError | undefined;
    const staleWorkspaceId = workspaceId();
    if (
      !staleWorkspaceId ||
      !error ||
      (error.status !== 403 && error.status !== 404)
    ) {
      return;
    }
    clearWorkspaceProjectionCaches(staleWorkspaceId);
    void ensureAccessibleWorkspaceSelection({ force: true });
  });
  const fullProjectionWorkspaceId = createMemo(() =>
    overview()?.nextCapsuleCursor ? workspaceId() : undefined,
  );
  const [fullCapsules, { refetch: refetchFullCapsules }] = createResource(
    fullProjectionWorkspaceId,
    (id) => listCapsulesCached(id, { includeDestroyed: false }),
  );
  const [uiSurfaces, { refetch: refetchUiSurfaces }] = createResource(
    workspaceId,
    async (id) => {
      const session = await refreshSession();
      if (!session) throw new Error("dashboard session is unavailable");
      return await listAuthorizedUiSurfaces(id, session.subject);
    },
  );
  // The supplemental full-list fetches can fail independently of the overview;
  // without surfacing it the launcher silently truncates to the first page.
  const fullFetchError = createMemo(
    () => (fullCapsules.error ?? uiSurfaces.error) as Error | undefined,
  );
  const retryFullFetch = () => {
    if (fullCapsules.error) void refetchFullCapsules();
    if (uiSurfaces.error) void refetchUiSurfaces();
  };
  // `.error` first: reading an errored resource THROWS. A failed supplemental
  // full-list fetch must degrade to the overview's first page (with the
  // fullFetchError toast + retry) rather than white-screening the launcher.
  const capsules = createMemo(() =>
    mergeById(
      overview()?.capsules ?? [],
      fullCapsules.error ? [] : (fullCapsules() ?? []),
    ),
  );
  const visibleCapsules = createMemo(() =>
    (capsules() ?? []).filter(isVisibleServiceCapsule),
  );
  // Capsule is the installed-app ledger. Interface is the only launcher/runtime
  // surface authority; its explicit URL mapping has already been resolved and
  // its exact Principal Binding checked by listAuthorizedUiSurfaces.
  const surfacesByCapsule = createMemo(() => {
    const map = new Map<string, AppSurface[]>();
    if (uiSurfaces.error) return map;
    for (const surface of uiSurfaces() ?? []) {
      const entries = map.get(surface.capsuleId) ?? [];
      entries.push({
        interfaceId: surface.interfaceId,
        url: surface.url,
        ...(surface.name ? { name: surface.name } : {}),
        ...(surface.icon ? { icon: surface.icon } : {}),
        ...(surface.category ? { category: surface.category } : {}),
        ...(surface.sortOrder !== undefined
          ? { sortOrder: surface.sortOrder }
          : {}),
      });
      map.set(surface.capsuleId, entries);
    }
    return map;
  });

  const appTiles = createMemo<AppTile[]>(() => {
    const map = surfacesByCapsule();
    const tiles: AppTile[] = [];
    for (const inst of visibleCapsules()) {
      const surfaces = map.get(inst.id);
      if (!surfaces) continue;
      surfaces.forEach((surface, i) =>
        tiles.push({
          inst,
          surface: surface.name ? surface : { ...surface, name: inst.name },
          key: surface.interfaceId || `${inst.id}:${i}`,
        }),
      );
    }
    return tiles.sort(compareAppTiles);
  });

  const createFirstWorkspace = createAction(async (): Promise<Workspace> => {
    const workspace = await createWorkspace({
      handle: defaultWorkspaceHandle(),
      displayName: t("workspace.defaultName"),
      type: "personal",
    });
    setCurrentWorkspaceId(workspace.id);
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    navigate("/store");
    return workspace;
  });

  return (
    <>
      <Show
        when={workspaceId()}
        fallback={
          <NoWorkspaceStartPanel
            busy={createFirstWorkspace.busy()}
            error={createFirstWorkspace.error()}
            onCreate={() => void createFirstWorkspace.run()}
          />
        }
      >
        <Switch>
          <Match when={overview.loading || uiSurfaces.loading}>
            <LauncherSkeleton />
          </Match>
          <Match when={overview.error}>
            <Toast tone="error">
              {t("common.fetchFailed", {
                message: (overview.error as ControlApiError).message,
              })}
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void refetchOverview()}
              >
                {t("common.retry")}
              </Button>
            </Toast>
          </Match>
          <Match when={overview()}>
            <Show when={fullFetchError()}>
              <Toast tone="error">
                {t("apps.listIncomplete")}
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={retryFullFetch}
                >
                  {t("common.retry")}
                </Button>
              </Toast>
            </Show>
            <Show
              when={appTiles().length > 0}
              fallback={<WorkspaceStartPanel />}
            >
              <AppLauncher tiles={appTiles()} />
            </Show>
          </Match>
        </Switch>
      </Show>
    </>
  );
}

function mergeById<T extends { readonly id: string }>(
  primary: readonly T[],
  secondary: readonly T[],
): readonly T[] {
  if (secondary.length === 0) return primary;
  const byId = new Map<string, T>();
  const merged: T[] = [];
  for (const item of [...primary, ...secondary]) {
    if (byId.has(item.id)) continue;
    byId.set(item.id, item);
    merged.push(item);
  }
  return merged;
}

function compareAppTiles(a: AppTile, b: AppTile): number {
  const declaredOrder =
    (a.surface.sortOrder ?? Number.MAX_SAFE_INTEGER) -
    (b.surface.sortOrder ?? Number.MAX_SAFE_INTEGER);
  if (declaredOrder !== 0) return declaredOrder;
  // Prioritize apps that need attention so broken/stale installs do not get
  // buried behind healthy services on the everyday launcher.
  const attentionRank =
    Number(needsAttention(b.inst)) - Number(needsAttention(a.inst));
  if (attentionRank !== 0) return attentionRank;
  return appTileLabel(a).localeCompare(appTileLabel(b), locale(), {
    sensitivity: "base",
  });
}

function appTileLabel(tile: AppTile): string {
  return tile.surface.name || tile.inst.name;
}

function LauncherSkeleton() {
  return (
    <ul class="av-launcher">
      <For each={Array.from({ length: 6 })}>
        {() => (
          <li>
            <span class="av-tile" aria-hidden="true">
              <span class="tg-skel av-tile-skel" />
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

function NoWorkspaceStartPanel(props: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCreate: () => void;
}) {
  return (
    <section class="av-start" aria-label={t("workspace.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("workspace.start.kicker")}</span>
        <h2 class="av-start-title">{t("workspace.start.title")}</h2>
        <p class="av-start-sub">{t("workspace.start.body")}</p>
      </div>
      <Button
        variant="primary"
        type="button"
        busy={props.busy}
        icon={<Plus size={18} />}
        onClick={props.onCreate}
      >
        {props.busy
          ? t("workspace.start.creating")
          : t("workspace.start.create")}
      </Button>
      <Show when={props.error}>
        {(message) => <Toast tone="error">{message()}</Toast>}
      </Show>
    </section>
  );
}

function AppLauncher(props: { readonly tiles: readonly AppTile[] }) {
  return (
    <>
      <div class="av-section-head">
        {/* Top heading of the launcher page — h1, the page has no other. */}
        <h1>{t("apps.sectionYours")}</h1>
        <span class="av-section-head-count">{props.tiles.length}</span>
      </div>
      <ul class="av-launcher">
        <For each={props.tiles}>
          {(tile) => (
            <li>
              <AppTileView tile={tile} />
            </li>
          )}
        </For>
        <li>
          <a class="av-tile av-tile-add" href="/store">
            <span class="av-tile-icon" aria-hidden="true">
              <Plus />
            </span>
            <span class="av-tile-name">{t("apps.addShort")}</span>
          </a>
        </li>
      </ul>
    </>
  );
}

/**
 * One authorized Interface tile. The face is an Interface-declared icon or the
 * app initials; the resolved URL opens in a new tab. Needs-attention is Capsule
 * lifecycle presentation only and never changes the runtime URL authority.
 */
function AppTileView(props: { readonly tile: AppTile }) {
  const surface = () => props.tile.surface;
  const attention = () => needsAttention(props.tile.inst);
  const name = () => surface().name ?? props.tile.inst.name;
  const openUrl = () => surface().url;
  const [imageFailed, setImageFailed] = createSignal(false);
  const imageSrc = () => {
    if (imageFailed()) return undefined;
    const icon = surface().icon;
    if (!icon) return undefined;
    if (isUrlString(icon)) return icon;
    // A path-style icon (e.g. "/icons/app.svg") resolves against the app's
    // own origin when the surface has a URL.
    if (/[./]/.test(icon) && surface().url) {
      try {
        return new URL(icon, surface().url).href;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const emojiIcon = () => {
    const icon = surface().icon;
    // Only a short glyph is an emoji — a path-ish value must never render as
    // tile text (it would paint "/icons/app.svg" across the face).
    if (!icon || isUrlString(icon) || /[./]/.test(icon)) return undefined;
    return icon;
  };
  // Product-specific marks come only from the Interface document. A Capsule
  // name is fallback presentation text, never an implicit product identity.
  const isMonogram = () => !imageSrc() && !emojiIcon();

  const body = () => (
    <>
      <span
        class="av-tile-icon"
        classList={{
          "av-tile-icon-image": Boolean(imageSrc()),
          [kindClass(surface().category)]: isMonogram(),
        }}
        aria-hidden="true"
      >
        <Switch
          fallback={
            <span class="av-tile-mono">{monogramInitials(name())}</span>
          }
        >
          <Match when={imageSrc()}>
            {(src) => (
              <img
                class="av-tile-image"
                src={src()}
                alt=""
                loading="lazy"
                onError={() => setImageFailed(true)}
              />
            )}
          </Match>
          <Match when={emojiIcon()}>
            {(emo) => <span class="av-tile-emoji">{emo()}</span>}
          </Match>
        </Switch>
        <Show when={attention()}>
          <span class="av-tile-dot" />
        </Show>
      </span>
      <span class="av-tile-name">{name()}</span>
      <Show when={attention()}>
        <span class="sr-only">{t("apps.needsAttention")}</span>
      </Show>
    </>
  );

  const detailHref = () =>
    `/services/${encodeURIComponent(props.tile.inst.id)}`;

  return (
    <span class="av-tile-wrap">
      <Show when={openUrl()}>
        {(url) => (
          <>
            <a
              class="av-tile"
              href={url()}
              target="_blank"
              rel="noreferrer noopener"
            >
              {body()}
            </a>
          </>
        )}
      </Show>
      <span class="av-tile-actions">
        {/* Every tile repeats the same visible "管理"; the accessible name
            says which app it manages (WCAG 2.4.4). */}
        <a
          class="av-tile-manage"
          href={detailHref()}
          aria-label={t("apps.manageAria", { name: name() })}
        >
          <Settings2 size={13} aria-hidden="true" />
          <span>{t("apps.manage")}</span>
        </a>
      </span>
    </span>
  );
}

function defaultWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

/** Workspace exists but has no authorized Capsule UI-surface Interfaces. */
function WorkspaceStartPanel() {
  return (
    <section class="av-start" aria-label={t("apps.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("apps.start.kicker")}</span>
        <h2 class="av-start-title">{t("apps.start.titleEmpty")}</h2>
        <p class="av-start-sub">{t("apps.start.bodyEmpty")}</p>
      </div>
      <a href="/store" class="av-start-action">
        <Sparkles size={18} aria-hidden="true" />
        <span>{t("apps.start.optionStore")}</span>
      </a>
    </section>
  );
}
