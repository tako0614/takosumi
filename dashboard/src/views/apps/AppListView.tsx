/**
 * Apps home (`/`) — the Workspace app launcher. Services appear when they
 * declare app surfaces through well-known OpenTofu outputs, or while pending
 * when their install config has store service metadata. A service may declare
 * several launchable surfaces (e.g. a blog's public site + its admin screen),
 * each shown as its own tile. Tapping a tile opens that surface's URL, or the
 * service screen when it has none. The full service list (all Capsules, → the
 * OpenTofu detail) lives on the separate `/services` page.
 */
import {
  createEffect,
  createMemo,
  createResource,
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
import {
  clearCurrentStateVersionCache,
  listCurrentStateVersionsCached,
} from "../../lib/current-state-versions.ts";
import {
  clearInstallConfigListCache,
  listInstallConfigsCached,
} from "../../lib/install-config-list.ts";
import {
  type ControlApiError,
  createWorkspace,
  type Capsule,
  type InstallConfig,
  type Workspace,
} from "../../lib/control-api.ts";
import {
  type AppSurface,
  appSurfacesFromOutputs,
  appSurfaceFromInstallConfigStore,
  isUrlString,
  isVisibleServiceCapsule,
  needsAttention,
} from "../../lib/capsules-ui.ts";
import { locale, t } from "../../i18n/index.ts";
import { Button, Toast } from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";

/** One launcher tile: a declared surface belonging to a service. */
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
 * Fallback face for an app that declares no icon: its initials on a kind-tinted
 * tile. Distinct-by-name + distinct-by-kind so a screen of undeclared apps
 * never reads as identical boxes (declared image / emoji icons are preferred).
 */
function monogramInitials(name: string): string {
  const segments = name
    .replace(/^(ts-e2e-|takosumi-|takos-)/i, "")
    .split(/[-_\s./]+/)
    .filter(Boolean);
  const chars = (segments[0]?.[0] ?? name[0] ?? "?") + (segments[1]?.[0] ?? "");
  return chars.toUpperCase().slice(0, 2);
}

interface CuratedAppIcon {
  readonly image?: string;
  readonly emoji?: string;
}

/**
 * Curated marks for first-party apps that declare no icon of their own, so
 * official services (Takos, yurucommu, …) show a real graphic instead of an
 * initials monogram. Takos uses its logo image; the others use a
 * representative emoji. Matched by display name (most specific first); unknown
 * apps still fall through to the monogram.
 */
const CURATED_APP_ICONS: readonly (readonly [RegExp, CuratedAppIcon])[] = [
  [/yurucommu/i, { emoji: "🌐" }],
  [/yurumeet/i, { emoji: "💬" }],
  [/takos[-_\s]?office/i, { emoji: "📄" }],
  [/takos[-_\s]?computer/i, { emoji: "🖥️" }],
  [/road[-_\s]?to[-_\s]?me/i, { emoji: "🎯" }],
  [/takos/i, { image: "/tako.png" }],
];
function curatedAppIcon(name: string): CuratedAppIcon | undefined {
  for (const [pattern, icon] of CURATED_APP_ICONS) {
    if (pattern.test(name)) return icon;
  }
  return undefined;
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
  const [fullCapsules] = createResource(fullProjectionWorkspaceId, (id) =>
    listCapsulesCached(id, { includeDestroyed: false }),
  );
  const [fullStateVersions] = createResource(fullProjectionWorkspaceId, (id) =>
    listCurrentStateVersionsCached(id, { includeDestroyed: false }),
  );
  const [fullInstallConfigs] = createResource(fullProjectionWorkspaceId, (id) =>
    listInstallConfigsCached(id),
  );
  const capsules = createMemo(() =>
    mergeById(overview()?.capsules ?? [], fullCapsules() ?? []),
  );
  const visibleCapsules = createMemo(() =>
    (capsules() ?? []).filter(isVisibleServiceCapsule),
  );
  const currentStateVersions = createMemo(() =>
    mergeById(
      overview()?.currentStateVersions ?? [],
      fullStateVersions() ?? [],
    ),
  );

  // Map each Capsule to a type-specific icon via its install config's
  // store kind (site / storage / worker) — the fallback when a surface
  // declares no image or icon of its own.
  const installConfigs = createMemo(() =>
    mergeById(overview()?.installConfigs ?? [], fullInstallConfigs() ?? []),
  );
  const configById = createMemo(() => {
    const map = new Map<string, InstallConfig>();
    for (const config of installConfigs() ?? []) {
      map.set(config.id, config);
    }
    return map;
  });
  const kindForCapsule = (inst: Capsule): string | undefined =>
    configById().get(inst.installConfigId)?.store?.kind;

  // Declared app surfaces per service. The current StateVersion rows are loaded
  // through one Workspace projection request instead of N `getDeployment` reads.
  const surfacesByCapsule = createMemo(() => {
    const deployments = new Map(
      (currentStateVersions() ?? []).map((deployment) => [
        deployment.capsuleId ?? deployment.installationId,
        deployment,
      ]),
    );
    const map = new Map<string, AppSurface[]>();
    for (const inst of visibleCapsules()) {
      const deployment = deployments.get(inst.id);
      if (!deployment) continue;
      // Read the surface URLs straight from the deployment outputs (ungated):
      // tapping an app tile goes to the app's own link, not the management
      // screen, even before release activation. The post-deploy "Open app"
      // button keeps its own activation gate.
      const surfaces = appSurfacesFromOutputs(deployment.outputsPublic);
      if (surfaces.length > 0) map.set(inst.id, surfaces);
    }
    return map;
  });
  const fallbackSurfaceForCapsule = (inst: Capsule): AppSurface | undefined => {
    return appSurfaceFromInstallConfigStore(
      configById().get(inst.installConfigId),
      locale(),
    );
  };

  const appTiles = createMemo<AppTile[]>(() => {
    const map = surfacesByCapsule();
    if (!map) return [];
    const tiles: AppTile[] = [];
    for (const inst of visibleCapsules()) {
      const surfaces = map.get(inst.id);
      if (!surfaces) {
        // Every installed service gets a tile — one concept, not アプリ vs
        // サービス. Without a declared surface the tile has no launch URL, so
        // tapping it opens the service screen instead of an app window.
        const fallback = fallbackSurfaceForCapsule(inst);
        tiles.push({
          inst,
          surface: fallback ?? { name: inst.name },
          key: `${inst.id}:store`,
        });
        continue;
      }
      surfaces.forEach((surface, i) =>
        tiles.push({ inst, surface, key: `${inst.id}:${i}` }),
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

  const openDetail = (inst: Capsule) =>
    navigate(`/services/${encodeURIComponent(inst.id)}`);

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
          <Match when={overview.loading}>
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
            <Show
              when={visibleCapsules().length > 0}
              fallback={<WorkspaceStartPanel />}
            >
              <AppLauncher
                tiles={appTiles()}
                openDetail={openDetail}
                kindFor={kindForCapsule}
              />
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

function AppLauncher(props: {
  readonly tiles: readonly AppTile[];
  readonly openDetail: (inst: Capsule) => void;
  readonly kindFor: (inst: Capsule) => string | undefined;
}) {
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
              <AppTileView
                tile={tile}
                kind={props.kindFor(tile.inst)}
                onOpenDetail={() => props.openDetail(tile.inst)}
              />
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
 * One surface tile. The face is the declared image, else a declared emoji icon,
 * else the app's initials on a kind-tinted monogram tile — so undeclared apps
 * stay distinct rather than reading as identical boxes. A live surface URL
 * renders an anchor (new tab); otherwise a button opens the service screen.
 * Needs-attention shows as a corner dot (+ screen-reader text).
 */
function AppTileView(props: {
  readonly tile: AppTile;
  readonly kind: string | undefined;
  readonly onOpenDetail: () => void;
}) {
  const surface = () => props.tile.surface;
  const attention = () => needsAttention(props.tile.inst);
  const name = () => surface().name ?? props.tile.inst.name;
  const imageSrc = () => {
    if (surface().image) return surface().image;
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
  // First-party apps that declare no icon fall back to a curated mark (Takos
  // logo / representative emoji) before the initials monogram, so official
  // services never read as plain letters.
  const curated = () =>
    imageSrc() || emojiIcon() ? undefined : curatedAppIcon(name());
  const curatedImage = () => curated()?.image;
  const curatedEmoji = () => curated()?.emoji;
  const isMonogram = () =>
    !imageSrc() && !emojiIcon() && !curatedImage() && !curatedEmoji();

  const body = () => (
    <>
      <span
        class="av-tile-icon"
        classList={{
          "av-tile-icon-image": Boolean(imageSrc()) || Boolean(curatedImage()),
          [kindClass(props.kind)]: isMonogram(),
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
              <img class="av-tile-image" src={src()} alt="" loading="lazy" />
            )}
          </Match>
          <Match when={emojiIcon()}>
            {(emo) => <span class="av-tile-emoji">{emo()}</span>}
          </Match>
          <Match when={curatedImage()}>
            {(src) => (
              <img class="av-tile-image" src={src()} alt="" loading="lazy" />
            )}
          </Match>
          <Match when={curatedEmoji()}>
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
      <Show
        when={surface().url}
        fallback={
          <button type="button" class="av-tile" onClick={props.onOpenDetail}>
            {body()}
          </button>
        }
      >
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
        <a class="av-tile-manage" href={detailHref()}>
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

/** Workspace exists but holds no services at all — first-run onboarding. */
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
