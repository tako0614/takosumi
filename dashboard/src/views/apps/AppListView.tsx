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
import { Plus, Search, Sparkles } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import AppFace from "../../components/AppFace.tsx";
import { resolveAppIcon } from "../../lib/app-face.ts";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
  setCurrentWorkspaceId,
} from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
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
import { isVisibleServiceCapsule } from "../../lib/capsules-ui.ts";
import { type AppState, appState, appStateRank } from "../../lib/app-page.ts";
import {
  type AuthorizedUiSurface,
  listAuthorizedUiSurfaces,
} from "../../lib/ui-surface-interfaces.ts";
import { locale, type MessageKey, t } from "../../i18n/index.ts";
import { Badge, Button, type Tone, Toast } from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";
import { fetchFailedMessage } from "../../lib/error-copy.ts";
import { OpenAppButton } from "../app/app-ui.tsx";

/** One installed app on Home with the screens it may open. */
interface HomeApp {
  readonly inst: Capsule;
  readonly state: AppState;
  readonly surfaces: readonly AuthorizedUiSurface[];
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

  // Home needs only the Capsule ledger and the authorized screens.
  // `listCapsulesCached` follows the bounded API's nextCursor itself.
  const [capsules, { refetch: refetchCapsules }] = createResource(
    workspaceId,
    (id) => listCapsulesCached(id, { includeDestroyed: false }),
  );
  createEffect(() => {
    const error = capsules.error as ControlApiError | undefined;
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
  const [uiSurfaces, { refetch: refetchUiSurfaces }] = createResource(
    workspaceId,
    (id) => listAuthorizedUiSurfaces(id),
  );
  // Screen discovery can fail independently of the app list: the apps still
  // show, with a notice that their Open buttons could not be read.
  const surfacesFailed = () => Boolean(uiSurfaces.error);
  const surfacesByCapsule = createMemo(() => {
    const map = new Map<string, AuthorizedUiSurface[]>();
    if (uiSurfaces.error) return map;
    for (const surface of uiSurfaces() ?? []) {
      const entries = map.get(surface.capsuleId) ?? [];
      entries.push(surface);
      map.set(surface.capsuleId, entries);
    }
    return map;
  });
  const apps = createMemo<readonly HomeApp[]>(() => {
    const surfaces = surfacesByCapsule();
    return (capsules.error ? [] : (capsules.latest ?? []))
      .filter(isVisibleServiceCapsule)
      .map((inst) => ({
        inst,
        state: appState(inst),
        surfaces: surfaces.get(inst.id) ?? [],
      }))
      .sort(compareHomeApps);
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

  return (
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
        <Match when={capsules.loading || uiSurfaces.loading}>
          <HomeSkeleton />
        </Match>
        <Match when={capsules.error}>
          <Toast tone="error">
            {fetchFailedMessage(capsules.error, t)}
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => void refetchCapsules()}
            >
              {t("common.retry")}
            </Button>
          </Toast>
        </Match>
        <Match when={capsules.latest}>
          <Show when={apps().length > 0} fallback={<WorkspaceStartPanel />}>
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
              <Show when={surfacesFailed()}>
                <Toast tone="error">
                  {t("apps.listIncomplete")}
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => void refetchUiSurfaces()}
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
    </Show>
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
  const pageHref = () => `/workloads/${encodeURIComponent(props.app.inst.id)}`;
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
        iconUrl={icon().imageSrc}
        emoji={icon().emoji}
      />
      <div class="ap-app-info">
        <a class="ap-app-name" href={pageHref()}>
          {name()}
        </a>
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

function defaultWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

/** The Workspace has no installed apps yet. */
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
        <span>{t("apps.start.optionStore")}</span>
      </a>
    </section>
  );
}
