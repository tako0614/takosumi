/**
 * Home (`/`) — every installed app, the "keep my apps" overview (TASK-0115).
 *
 * Each card shows the app's state in words (needs attention, update
 * available, installing, uninstall scheduled) and offers "Open" when the app
 * has a screen. Installed state comes from Capsule records; every Open target
 * comes from an authorized Capsule-owned `interface.ui.surface` Interface.
 * Store metadata and OpenTofu Outputs are never launcher authorities. The
 * card's name opens the app page, where the app is kept.
 */
import "../app/app-page.css";
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js";
import { Search, Sparkles } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import AppFace from "../../components/AppFace.tsx";
import { resolveAppIcon } from "../../lib/app-face.ts";
import { currentWorkspaceId, selectAvailableWorkspaceId, setCurrentWorkspaceId } from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { listCapsulesCached } from "../../lib/capsule-list.ts";
import { getCapsuleApp, listAccessibleApps, type AccessibleApp } from "../../lib/control-api.ts";
import { isVisibleServiceCapsule } from "../../lib/capsules-ui.ts";
import { type AppState, appState, appStateRank, openableScreens } from "../../lib/app-page.ts";
import {
  listAuthorizedUiSurfaces,
} from "../../lib/ui-surface-interfaces.ts";
import { locale, type MessageKey, t } from "../../i18n/index.ts";
import { Badge, Button, type Tone, Toast } from "../../components/ui/index.ts";
import { fetchFailedMessage } from "../../lib/error-copy.ts";
import { OpenAppButton } from "../app/app-ui.tsx";
import { appPageHref } from "../../lib/app-links.ts";

/** One installed app on Home with the screens it may open. */
interface HomeApp {
  readonly inst: { readonly id: string; readonly name: string };
  readonly displayName?: string;
  readonly iconUrl?: string;
  readonly role?: AccessibleApp["role"];
  readonly ownerDisplayName?: string;
  readonly state: AppState;
  readonly surfaces: readonly { readonly name?: string; readonly url: string; readonly icon?: string }[];
}

const STATE_BADGE: Readonly<Partial<Record<AppState, { readonly label: MessageKey; readonly tone: Tone }>>> = {
  needs_attention: { label: "apps.state.needsAttention", tone: "danger" },
  update_available: { label: "apps.state.updateAvailable", tone: "info" },
  installing: { label: "apps.state.installing", tone: "info" },
  uninstalling: { label: "apps.state.uninstalling", tone: "warn" },
  stopped: { label: "apps.state.stopped", tone: "muted" },
};

export default function AppListView() {
  return <Page title={t("apps.title")}>{() => <Inner />}</Page>;
}

/** 404 is the only compatibility signal; service/auth failures stay visible. */
async function loadHomeApps(): Promise<{ readonly apps: readonly HomeApp[]; readonly surfacesFailed: boolean }> {
  const accessible = await listAccessibleApps();
  if (accessible !== undefined) {
    const rows = await Promise.all(accessible.map(async (entry): Promise<HomeApp> => {
      let surfaces: HomeApp["surfaces"] = [];
      let state = homeState(entry);
      // A launcher URL must come from the app's authorized screen projection.
      // The value-free apps list itself is never an external URL authority.
      try {
        const view = await getCapsuleApp(entry.capsuleId);
        surfaces = openableScreens(view.screens);
        if (state === "ready" && view.state === "installed" && view.version.updateAvailable) state = "update_available";
      } catch { /* The app remains manageable when screen discovery is unavailable. */ }
      return {
        inst: { id: entry.capsuleId, name: entry.name },
        displayName: typeof entry.displayName === "string" ? entry.displayName : entry.displayName?.[locale()],
        iconUrl: entry.iconUrl,
        role: entry.role,
        ownerDisplayName: entry.ownerDisplayName,
        state, surfaces,
      };
    }));
    return { apps: rows, surfacesFailed: false };
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
    apps: capsules.filter(isVisibleServiceCapsule).map((inst) => ({
      inst, state: appState(inst), surfaces: surfaces.value.filter((surface) => surface.capsuleId === inst.id),
    })), surfacesFailed: surfaces.failed,
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
  const [home, { refetch }] = createResource(loadHomeApps);
  const apps = createMemo(() => [...(home.error ? [] : home.latest?.apps ?? [])].sort(compareHomeApps));
  return (
    <Switch>
      <Match when={home.loading}><HomeSkeleton /></Match>
      <Match when={home.error}>
        <Toast tone="error">{fetchFailedMessage(home.error, t)}
          <Button variant="secondary" size="sm" type="button" onClick={() => void refetch()}>{t("common.retry")}</Button>
        </Toast>
      </Match>
      <Match when={home.latest}>
        <Show when={apps().length > 0} fallback={<AppStartPanel />}>
            <div class="ap-home" data-testid="home-apps">
              <div class="ap-home-head">
                {/* The page's only heading. */}
                <h1>
                  {t("apps.sectionYours")}
                  <span class="ap-home-count">{apps().length}</span>
                </h1>
                <Button variant="secondary" href="/new" icon={<Search size={16} />}>
                  {t("apps.browse")}
                </Button>
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
              <ul class="ap-app-grid">
                <For each={apps()}>
                  {(app) => (
                    <li>
                      <HomeAppCard app={app} />
                    </li>
                  )}
                </For>
              </ul>
            </div>
        </Show>
      </Match>
    </Switch>
  );
}

/** Needs attention first, then updates, then installing; alphabetical within. */
function compareHomeApps(a: HomeApp, b: HomeApp): number {
  const rank = appStateRank(a.state) - appStateRank(b.state);
  if (rank !== 0) return rank;
  return homeAppName(a).localeCompare(homeAppName(b), locale(), {
    sensitivity: "base",
  });
}

function homeAppName(app: HomeApp): string {
  if (app.displayName) return app.displayName;
  return app.surfaces.length === 1 && app.surfaces[0]!.name
    ? app.surfaces[0]!.name
    : app.inst.name;
}

/**
 * One installed app. Its name opens the app page; "Open" (when the app has a
 * screen and is not being removed) opens the screen in a new tab.
 */
function HomeAppCard(props: { readonly app: HomeApp }) {
  const name = () => homeAppName(props.app);
  const icon = () => {
    const surface = props.app.surfaces[0];
    return surface ? resolveAppIcon(surface.icon, surface.url) : {};
  };
  const badge = () => STATE_BADGE[props.app.state];
  const canOpen = () =>
    props.app.surfaces.length > 0 &&
    props.app.state !== "uninstalling" &&
    props.app.state !== "stopped" &&
    props.app.state !== "installing";
  const pageHref = () => appPageHref(props.app.inst.id);
  return (
    <article
      class="ap-app-card"
      data-testid="home-app"
      data-app-state={props.app.state}
      data-capsule-id={props.app.inst.id}
    >
      <AppFace
        class="ap-app-face"
        name={name()}
        iconUrl={props.app.iconUrl ?? icon().imageSrc}
        emoji={icon().emoji}
      />
      <div class="ap-app-info">
        <a class="ap-app-name" href={pageHref()}>
          {name()}
        </a>
        <Show when={props.app.role === "member"}>
          <span class="ap-muted">{t("app.sharing.sharedBy", { name: props.app.ownerDisplayName ?? "" })}</span>
        </Show>
        <Show when={badge()}>
          {(state) => (
            <span>
              <Badge tone={state().tone}>{t(state().label)}</Badge>
            </span>
          )}
        </Show>
      </div>
      <div class="ap-app-card-actions">
        <Show
          when={canOpen()}
          fallback={
            <Button variant="primary" size="sm" href={pageHref()}>
              {props.app.state === "needs_attention" || props.app.state === "update_available"
                ? t("apps.review")
                : t("apps.manage")}
            </Button>
          }
        >
          <OpenAppButton surfaces={props.app.surfaces} appName={props.app.inst.name} size="sm" labelWithApp />
          <a
            class="ap-app-manage"
            href={pageHref()}
            aria-label={t("apps.manageAria", { name: name() })}
          >
            {t("apps.manage")}
          </a>
        </Show>
      </div>
    </article>
  );
}

function HomeSkeleton() {
  return (
    <ul class="ap-app-grid" aria-hidden="true">
      <For each={Array.from({ length: 4 })}>
        {() => (
          <li>
            <span class="ap-app-card">
              <span class="tg-skel ap-app-face" />
              <span class="tg-skel" />
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
