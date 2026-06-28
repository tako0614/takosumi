/**
 * Apps home (`/`) — the Workspace app launcher. Only services that DECLARE an
 * app (via well-known OpenTofu outputs) appear here, and a service may declare
 * several launchable surfaces (e.g. a blog's public site + its admin screen),
 * each shown as its own tile. Tapping a tile opens that surface's URL, or the
 * service screen when it has none. The full service list (all Capsules, → the
 * OpenTofu detail) lives on the separate `/services` page.
 */
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Box, Database, Globe, LayoutGrid, Plus, Sparkles } from "lucide-solid";
import type { JSX } from "solid-js";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentWorkspaceId, setCurrentWorkspaceId } from "../../lib/workspace-state.ts";
import {
  type ControlApiError,
  createWorkspace,
  getDeployment,
  type Capsule,
  type Workspace,
  listCapsules,
  listInstallConfigs,
} from "../../lib/control-api.ts";
import {
  type AppSurface,
  appSurfacesFromOutputs,
  isUrlString,
  isVisibleServiceCapsule,
  needsAttention,
} from "../../lib/capsules-ui.ts";
import { t } from "../../i18n/index.ts";
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

/** A type-specific launcher icon so services read as distinct apps, not rows. */
function serviceKindIcon(kind: string | undefined): JSX.Element {
  switch (kind) {
    case "site":
      return <Globe />;
    case "storage":
      return <Database />;
    case "worker":
      return <Box />;
    default:
      return <LayoutGrid />;
  }
}

/**
 * Vivid, deterministic app-icon color per tile. Hue by grid position via the
 * golden angle (137.5°) so consecutive icons land far apart on the wheel — even
 * a few tiles always read as clearly distinct colors. Fixed saturation /
 * lightness keeps every glyph-on-color icon glossy on both themes. (Tiles with
 * a declared image / icon use that instead of the colored glyph.)
 */
function appIconColor(index: number): readonly [string, string] {
  const hue = Math.round((index * 137.508 + 210) % 360);
  return [`hsl(${hue} 72% 56%)`, `hsl(${hue} 76% 44%)`];
}

function Inner() {
  const navigate = useNavigate();
  const workspaceId = () => (currentWorkspaceId() ? currentWorkspaceId() : null);

  const [capsules] = createResource(workspaceId, listCapsules);
  const visibleCapsules = createMemo(() =>
    (capsules() ?? []).filter(isVisibleServiceCapsule),
  );

  // Map each Capsule to a type-specific icon via its install config's
  // catalog kind (site / storage / worker) — the fallback when a surface
  // declares no image or icon of its own.
  const [installConfigs] = createResource(workspaceId, (id) =>
    listInstallConfigs(id),
  );
  const kindByConfigId = createMemo(() => {
    const map = new Map<string, string>();
    for (const config of installConfigs() ?? []) {
      const kind = config.catalog?.kind;
      if (kind) map.set(config.id, kind);
    }
    return map;
  });
  const iconForCapsule = (inst: Capsule): JSX.Element =>
    serviceKindIcon(kindByConfigId().get(inst.installConfigId));

  // Declared app surfaces per service, read from its current Deployment's
  // public outputs. A service with no app metadata contributes no tiles.
  const [surfacesByCapsule] = createResource(
    visibleCapsules,
    async (list) => {
      const map = new Map<string, AppSurface[]>();
      await Promise.all(
        list
          .filter(
            (inst): inst is Capsule & { currentStateVersionId: string } =>
              Boolean(inst.currentStateVersionId),
          )
          .map(async (inst) => {
            try {
              const deployment = await getDeployment(inst.currentStateVersionId);
              const surfaces = appSurfacesFromOutputs(deployment.outputsPublic);
              if (surfaces.length > 0) map.set(inst.id, surfaces);
            } catch {
              // A failed read just means this service contributes no app tiles.
            }
          }),
      );
      return map;
    },
  );

  const appTiles = createMemo<AppTile[]>(() => {
    const map = surfacesByCapsule();
    if (!map) return [];
    const tiles: AppTile[] = [];
    for (const inst of visibleCapsules()) {
      const surfaces = map.get(inst.id);
      if (!surfaces) continue;
      surfaces.forEach((surface, i) =>
        tiles.push({ inst, surface, key: `${inst.id}:${i}` }),
      );
    }
    return tiles;
  });

  const createFirstWorkspace = createAction(async (): Promise<Workspace> => {
    const workspace = await createWorkspace({
      handle: defaultWorkspaceHandle(),
      displayName: t("workspace.defaultName"),
      type: "personal",
    });
    setCurrentWorkspaceId(workspace.id);
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    navigate("/new");
    return workspace;
  });

  const openDetail = (inst: Capsule) =>
    navigate(`/services/${encodeURIComponent(inst.id)}`);

  return (
    <AppShell>
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
          <Match when={capsules.loading}>
            <LauncherSkeleton />
          </Match>
          <Match when={capsules.error}>
            <Toast tone="error">
              {t("common.fetchFailed", {
                message: (capsules.error as ControlApiError).message,
              })}
            </Toast>
          </Match>
          <Match when={capsules()}>
            <Show
              when={visibleCapsules().length > 0}
              fallback={<WorkspaceStartPanel />}
            >
              <Switch>
                <Match when={surfacesByCapsule.loading}>
                  <LauncherSkeleton />
                </Match>
                <Match when={appTiles().length === 0}>
                  <AppsEmptyPanel />
                </Match>
                <Match when={appTiles().length > 0}>
                  <AppLauncher
                    tiles={appTiles()}
                    openDetail={openDetail}
                    iconFor={iconForCapsule}
                  />
                </Match>
              </Switch>
            </Show>
          </Match>
        </Switch>
      </Show>
    </AppShell>
  );
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
        {props.busy ? t("workspace.start.creating") : t("workspace.start.create")}
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
  readonly iconFor: (inst: Capsule) => JSX.Element;
}) {
  return (
    <ul class="av-launcher">
      <For each={props.tiles}>
        {(tile, index) => (
          <li>
            <AppTileView
              tile={tile}
              index={index()}
              icon={props.iconFor(tile.inst)}
              onOpenDetail={() => props.openDetail(tile.inst)}
            />
          </li>
        )}
      </For>
      <li>
        <a class="av-tile av-tile-add" href="/new">
          <span class="av-tile-icon" aria-hidden="true">
            <Plus />
          </span>
          <span class="av-tile-name">{t("apps.add")}</span>
        </a>
      </li>
    </ul>
  );
}

/**
 * One surface tile. The face is the declared image, else a declared icon
 * (image-URL or emoji/glyph), else the service's type icon on a colored tile.
 * A live surface URL renders an anchor (new tab); otherwise a button opens the
 * service screen. Needs-attention shows as a corner dot (+ screen-reader text).
 */
function AppTileView(props: {
  readonly tile: AppTile;
  readonly index: number;
  readonly icon: JSX.Element;
  readonly onOpenDetail: () => void;
}) {
  const surface = () => props.tile.surface;
  const attention = () => needsAttention(props.tile.inst);
  const color = appIconColor(props.index);
  const name = () => surface().name ?? props.tile.inst.name;
  const imageSrc = () =>
    surface().image ??
    (surface().icon && isUrlString(surface().icon)
      ? surface().icon
      : undefined);
  const emojiIcon = () =>
    surface().icon && !isUrlString(surface().icon) ? surface().icon : undefined;

  const body = () => (
    <>
      <span
        class="av-tile-icon"
        classList={{ "av-tile-icon-image": Boolean(imageSrc()) }}
        style={{ "--app-c1": color[0], "--app-c2": color[1] }}
        aria-hidden="true"
      >
        <Switch fallback={props.icon}>
          <Match when={imageSrc()}>
            {(src) => (
              <img class="av-tile-image" src={src()} alt="" loading="lazy" />
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

  return (
    <Show
      when={surface().url}
      fallback={
        <button type="button" class="av-tile" onClick={props.onOpenDetail}>
          {body()}
        </button>
      }
    >
      {(url) => (
        <a
          class="av-tile"
          href={url()}
          target="_blank"
          rel="noreferrer noopener"
        >
          {body()}
        </a>
      )}
    </Show>
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
      <a href="/new" class="av-start-action">
        <Sparkles size={18} aria-hidden="true" />
        <span>{t("apps.start.optionCatalog")}</span>
      </a>
    </section>
  );
}

/** Services exist but none declare an app surface — point to the list / add. */
function AppsEmptyPanel() {
  return (
    <section class="av-start" aria-label={t("apps.empty.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("apps.empty.kicker")}</span>
        <h2 class="av-start-title">{t("apps.empty.title")}</h2>
        <p class="av-start-sub">{t("apps.empty.body")}</p>
      </div>
      <div class="av-start-actions">
        <a href="/new" class="av-start-action">
          <Sparkles size={18} aria-hidden="true" />
          <span>{t("apps.add")}</span>
        </a>
        <a href="/services" class="av-start-secondary">
          <span>{t("apps.empty.viewServices")}</span>
        </a>
      </div>
    </section>
  );
}
