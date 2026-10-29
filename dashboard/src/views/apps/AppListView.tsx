/**
 * Home (`/`) — the app launcher: every installed app as an icon tile.
 *
 * Apps that can be opened come first, in name order. Tapping one opens its
 * screen in a new tab; the small "Manage" link under it opens the app page.
 * Apps that cannot be opened yet (installing, never applied, failed, being
 * removed, stopped) still get a tile, drawn muted with a status mark, and
 * tapping it opens the app page, where the app is kept. Nothing is folded
 * away. Installed state comes from the app list; every Open target comes from
 * the app's authorized screen projection (an `interface.ui.surface`
 * Interface). Store metadata and OpenTofu Outputs are never launcher
 * authorities.
 */
import {
  createMemo,
  createResource,
  createUniqueId,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Plus, Settings2, Sparkles } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import IncomingOwnershipTransfers from "./IncomingOwnershipTransfers.tsx";
import AppFace from "../../components/AppFace.tsx";
import { resolveAppIcon } from "../../lib/app-face.ts";
import { currentWorkspaceId, selectAvailableWorkspaceId, setCurrentWorkspaceId } from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { listCapsulesCached } from "../../lib/capsule-list.ts";
import { getCapsuleApp, listAccessibleApps, type AccessibleApp } from "../../lib/control-api.ts";
import { isVisibleServiceCapsule } from "../../lib/capsules-ui.ts";
import { type AppState, appState, openableScreens } from "../../lib/app-page.ts";
import { homeAppOpens, homeAppWaiting, sortHomeApps } from "../../lib/home-launcher.ts";
import {
  listAuthorizedUiSurfaces,
} from "../../lib/ui-surface-interfaces.ts";
import { locale, type MessageKey, t } from "../../i18n/index.ts";
import { Button, Toast } from "../../components/ui/index.ts";
import { fetchFailedMessage } from "../../lib/error-copy.ts";
import { appPageHref } from "../../lib/app-links.ts";

/** One installed app on Home with the screens it may open. */
interface HomeApp {
  readonly inst: { readonly id: string; readonly name: string };
  readonly displayName?: string;
  readonly iconUrl?: string;
  /** The screen's declared category; tints the monogram face. */
  readonly category?: string;
  readonly role?: AccessibleApp["role"];
  readonly ownerDisplayName?: string;
  readonly state: AppState;
  readonly surfaces: readonly { readonly name?: string; readonly url: string; readonly icon?: string }[];
}

/** The small status mark: a dot on the icon and a word under the name. */
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

/** 404 is the only compatibility signal; service/auth failures stay visible. */
async function loadHomeApps(): Promise<{ readonly apps: readonly HomeApp[]; readonly surfacesFailed: boolean }> {
  const accessible = await listAccessibleApps();
  if (accessible !== undefined) {
    let surfacesFailed = false;
    const rows: HomeApp[] = new Array(accessible.length);
    let nextIndex = 0;
    const readApp = async (entry: AccessibleApp): Promise<HomeApp> => {
      let surfaces: HomeApp["surfaces"] = [];
      let category: string | undefined;
      let state = homeState(entry);
      // A launcher URL must come from the app's authorized screen projection.
      // The value-free apps list itself is never an external URL authority.
      try {
        const view = await getCapsuleApp(entry.capsuleId);
        surfaces = openableScreens(view.screens);
        category = view.screens[0]?.category;
        if (state === "ready" && view.state === "installed" && view.version.updateAvailable) state = "update_available";
      } catch { surfacesFailed = true; }
      return {
        inst: { id: entry.capsuleId, name: entry.name },
        displayName: typeof entry.displayName === "string" ? entry.displayName : entry.displayName?.[locale()],
        iconUrl: entry.iconUrl,
        ...(category ? { category } : {}),
        role: entry.role,
        ownerDisplayName: entry.ownerDisplayName,
        state, surfaces,
      };
    };
    await Promise.all(Array.from({ length: Math.min(4, accessible.length) }, async () => {
      while (nextIndex < accessible.length) {
        const index = nextIndex++;
        rows[index] = await readApp(accessible[index]!);
      }
    }));
    return { apps: rows, surfacesFailed };
  }
  const workspaces = await listWorkspacesCached();
  const id = selectAvailableWorkspaceId(currentWorkspaceId(), workspaces);
  setCurrentWorkspaceId(id);
  if (!id) return { apps: [], surfacesFailed: false };
  const [capsules, surfaces] = await Promise.all([
    listCapsulesCached(id, { includeDestroyed: false }),
    listAuthorizedUiSurfaces(id).then((value) => ({ value, failed: false }), () => ({ value: [], failed: true })),
  ]);
  return {
    apps: capsules.filter(isVisibleServiceCapsule).map((inst) => {
      const own = surfaces.value.filter((surface) => surface.capsuleId === inst.id);
      const category = own[0]?.category;
      return { inst, state: appState(inst), surfaces: own, ...(category ? { category } : {}) };
    }), surfacesFailed: surfaces.failed,
  };
}
function homeState(app: AccessibleApp): AppState {
  switch (app.state) {
    case "needs_attention": return "needs_attention";
    case "update_available": return "update_available";
    case "installing": case "updating": return "installing";
    case "uninstalling": case "uninstall_scheduled": return "uninstalling";
    case "uninstalled": case "stopped": return "stopped";
    default: return "ready";
  }
}
function Inner() {
  const [home, { refetch }] = createResource(() => ({ workspaceId: currentWorkspaceId(), locale: locale() }), loadHomeApps);
  const apps = createMemo(() => sortHomeApps(home.error ? [] : home.latest?.apps ?? [], homeAppName, locale()));
  return (
    <>
    <IncomingOwnershipTransfers appNames={new Map(apps().map((app) => [app.inst.id, app.displayName ?? app.inst.name]))} onChanged={async () => { await refetch(); }} />
    <Switch>
      <Match when={home.loading}><LauncherSkeleton /></Match>
      <Match when={home.error}>
        <Toast tone="error">{fetchFailedMessage(home.error, t)}
          <Button variant="secondary" size="sm" type="button" onClick={() => void refetch()}>{t("common.retry")}</Button>
        </Toast>
      </Match>
      <Match when={home.latest}>
        <Show when={apps().length > 0} fallback={<AppStartPanel />}>
          <div data-testid="home-apps">
            <div class="av-section-head">
              {/* The page's only heading. */}
              <h1>{t("apps.sectionYours")}</h1>
              <span class="av-section-head-count">{apps().length}</span>
            </div>
            <Show when={home.latest?.surfacesFailed}>
              <Toast tone="error">
                {t("apps.listIncomplete")}
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => void refetch()}
                >
                  {t("common.retry")}
                </Button>
              </Toast>
            </Show>
            <ul class="av-launcher">
              <For each={apps()}>
                {(app) => (
                  <li
                    data-testid="home-app"
                    data-app-state={app.state}
                    data-app-opens={homeAppOpens(app) ? "true" : "false"}
                    data-capsule-id={app.inst.id}
                  >
                    <HomeAppTile app={app} />
                  </li>
                )}
              </For>
              <li>
                {/* Installing starts in the store; same place as the ストア tab. */}
                <a class="av-tile av-tile-add" href="/new">
                  <span class="av-tile-icon" aria-hidden="true">
                    <Plus />
                  </span>
                  <span class="av-tile-name">{t("apps.browse")}</span>
                </a>
              </li>
            </ul>
          </div>
        </Show>
      </Match>
    </Switch>
    </>
  );
}

function homeAppName(app: HomeApp): string {
  if (app.displayName) return app.displayName;
  return app.surfaces.length === 1 && app.surfaces[0]!.name
    ? app.surfaces[0]!.name
    : app.inst.name;
}

/** Kind key for the tinted monogram face (worker/site/storage/…). */
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
 * One app tile: the icon (or a kind-tinted monogram) with the name under it.
 * An app that opens links to its first authorized screen and keeps a small
 * "Manage" link to its page; every other app links to its page. The status
 * mark's words are the link's accessible description.
 */
function HomeAppTile(props: { readonly app: HomeApp }) {
  const name = () => homeAppName(props.app);
  const icon = () => {
    const surface = props.app.surfaces[0];
    return surface ? resolveAppIcon(surface.icon, surface.url) : {};
  };
  const mark = () => STATE_MARK[props.app.state];
  const shared = () => props.app.role === "member";
  const captionId = createUniqueId();
  const describedBy = () => (mark() || shared() ? captionId : undefined);
  const openUrl = () => (homeAppOpens(props.app) ? props.app.surfaces[0]?.url : undefined);
  const pageHref = () => appPageHref(props.app.inst.id);
  const tileClass = () => (homeAppWaiting(props.app) ? "av-tile av-tile-waiting" : "av-tile");

  const body = () => (
    <>
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
      <span class="av-tile-name">{name()}</span>
      <Show when={describedBy()}>
        <span class="av-tile-captions" id={captionId}>
          <Show when={mark()}>
            {(state) => <span class={`av-tile-state av-tile-state-${state().kind}`}>{t(state().label)}</span>}
          </Show>
          <Show when={shared()}>
            <span class="av-tile-state">{t("app.sharing.sharedBy", { name: props.app.ownerDisplayName ?? "" })}</span>
          </Show>
        </span>
      </Show>
    </>
  );

  return (
    <span class="av-tile-wrap">
      <Show
        when={openUrl()}
        fallback={
          <a class={tileClass()} href={pageHref()} aria-label={name()} aria-describedby={describedBy()}>
            {body()}
          </a>
        }
      >
        {(url) => (
          <>
            <a
              class={tileClass()}
              href={url()}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t("app.open.aria", { name: name() })}
              aria-describedby={describedBy()}
            >
              {body()}
            </a>
            <span class="av-tile-actions">
              {/* Every open tile repeats the same visible "Manage"; the
                  accessible name says which app it manages (WCAG 2.4.4). */}
              <a
                class="av-tile-manage"
                href={pageHref()}
                aria-label={t("apps.manageAria", { name: name() })}
              >
                <Settings2 size={13} aria-hidden="true" />
                <span>{t("apps.manage")}</span>
              </a>
            </span>
          </>
        )}
      </Show>
    </span>
  );
}

function LauncherSkeleton() {
  return (
    <ul class="av-launcher" aria-hidden="true">
      <For each={Array.from({ length: 6 })}>
        {() => (
          <li>
            <span class="av-tile">
              <span class="tg-skel av-tile-skel" />
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** No apps have been installed yet. */
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
