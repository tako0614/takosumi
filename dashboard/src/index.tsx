/* @refresh reload */
import { lazy, onMount, untrack } from "solid-js";
import { render } from "solid-js/web";
import {
  Navigate,
  Route,
  Router,
  useLocation,
  useParams,
} from "@solidjs/router";
import { installStaleAssetReload } from "./lib/chunk-reload.ts";
import { initializeTakosumiRuntimeCapabilities } from "./lib/runtime-capabilities.ts";
import { installHandoffTarget } from "./lib/app-handoff.ts";
import { resolveLegacyAppUrl } from "./lib/app-links.ts";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import "./lib/theme.ts";

// Web fonts referenced by the design tokens (`--tg-font-body` / `--tg-font-mono`).
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";

// Takosumi dashboard design system:
//   tokens (app palette) → base (reset/body/a11y) → components
//   (shared + ui/* classes) → shell (app chrome + auth) → views (per-view rules).
// Imported once here so the tokens are present on the public `/sign-in` screens
// that render before any AppShell-wrapped screen mounts.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/views.css";
import "./styles/app-views.css";

installStaleAssetReload();

// --- auth (public) ----------------------------------------------------------
const SignInView = lazy(() => import("./views/auth/SignInView.tsx"));
const SignInCallbackView = lazy(() =>
  import("./views/auth/SignInView.tsx").then((m) => ({
    default: m.SignInCallbackView,
  })),
);
const LegalView = lazy(() => import("./views/legal/LegalView.tsx"));
const NotFoundView = lazy(() => import("./views/NotFoundView.tsx"));

// --- Signed-in surface ---------------------------------------------------------
// Every authenticated screen nests under ShellLayout (AuthGuard + AppShell) —
// views no longer wrap themselves in the chrome. The primary destinations are
// the four behaviors in views/account/components/shell/nav.ts.
const ShellLayout = lazy(
  () => import("./views/account/components/shell/ShellLayout.tsx"),
);
const AppListView = lazy(() => import("./views/apps/AppListView.tsx"));
const AppPage = lazy(() => import("./views/app/AppPage.tsx"));
const InstallView = lazy(() => import("./views/new/InstallView.tsx"));
const RunView = lazy(() => import("./views/runs/RunView.tsx"));
const RunGroupView = lazy(() => import("./views/runs/RunGroupView.tsx"));
const NotificationsView = lazy(
  () => import("./views/notifications/NotificationsView.tsx"),
);
const ConnectionsView = lazy(
  () => import("./views/workspace/ConnectionsView.tsx"),
);
const AccountView = lazy(() => import("./views/account/AccountView.tsx"));

// --- redirects ---------------------------------------------------------------

/**
 * These paths are owned by the Accounts/OIDC server handler, not the dashboard
 * SPA. If a stale tab or cached shell routes them through Solid, force a real
 * document navigation so the worker can return the proper 302/JSON response.
 */
function ServerOwnedRouteReload() {
  onMount(() => {
    const key = "takosumi.dashboard.server-route-reload@v1";
    const href = window.location.href;
    if (sessionStorage.getItem(key) === href) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, href);
    window.location.replace(href);
  });
  return null;
}

/** Redirect preserving the query string (the external install link's
 * `/install?git=…` prefill and a provider OAuth helper callback's
 * `/connections?connected=1` both carry load-bearing params). */
function RedirectWithQuery(props: { readonly to: string }) {
  const loc = useLocation();
  return <Navigate href={`${props.to}${loc.search}`} />;
}

function InstallEntryRoute() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const handoff = params.get("handoff");
  if (handoff !== null) {
    // Protocol-handler path (`web+takosumi:install?…` → `/install?handoff=<…>`).
    // Build a fresh query from the decoded, whitelisted scheme fields so outer
    // parameters cannot turn a handoff into an automatic install.
    return <Navigate href={installHandoffTarget(handoff)} />;
  }
  return <Navigate href={`/new${location.search}`} />;
}

/**
 * Older app-page paths (`/workloads/:id[/:tab]`, `/services/…`,
 * `/capsules/…`, `/apps/:id/:tab`) -> the canonical `/apps/:id`, with the old
 * tab as the section fragment the page scrolls to.
 */
function RedirectLegacyAppPage() {
  const location = useLocation();
  return <Navigate href={resolveLegacyAppUrl(location.pathname) ?? "/"} />;
}

/**
 * The store and install page. An old `/new?capsule=<id>` link — that locator
 * alone — opens the app's own page instead. Only the URL this route was
 * entered with counts: the install page's own in-page navigation keeps it.
 */
function NewRoute() {
  const location = useLocation();
  const appPage = resolveLegacyAppUrl("/new", untrack(() => location.search));
  return appPage ? <Navigate href={appPage} /> : <InstallView />;
}

/**
 * Where an old Workspace-settings tab lives now. Connections are the 接続
 * page; members, billing and the workspace itself are アカウント sections. Value
 * sharing and the management export left the UI (API and CLI only), so their
 * old tabs land on the workspace section; per-app screen recovery moved to each
 * app's page, which ホーム lists.
 */
function legacyWorkspaceSettingsTarget(tab: string | undefined): string {
  switch (tab) {
    case "members":
      return "/account/members";
    case "connections":
      return "/connections";
    case "billing":
      return "/account/billing";
    case "interface-recovery":
      return "/";
    default:
      return "/account/workspace";
  }
}

function RedirectLegacyWorkspaceSettingsTab() {
  const params = useParams<{ tab: string }>();
  return <RedirectWithQuery to={legacyWorkspaceSettingsTarget(params.tab)} />;
}

function App() {
  return (
    <Router>
      {/* Public — no session required. */}
      <Route path="/sign-in" component={SignInView} />
      <Route path="/sign-in/callback" component={SignInCallbackView} />
      <Route path="/install" component={InstallEntryRoute} />
      <Route path="/oauth" component={ServerOwnedRouteReload} />
      <Route path="/oauth/*path" component={ServerOwnedRouteReload} />
      <Route path="/legal/:page" component={() => <LegalView />} />
      <Route path="/support" component={() => <LegalView page="support" />} />
      {/* Legacy external aliases. Current website CTAs avoid open signup, but
          old links should still land on the only sign-in screen. */}
      <Route
        path="/signup"
        component={() => <RedirectWithQuery to="/sign-in" />}
      />
      <Route
        path="/login"
        component={() => <RedirectWithQuery to="/sign-in" />}
      />

      {/* Signed-in surface — ShellLayout owns AuthGuard + chrome. Primary
          destinations: / (ホーム), /new (ストア: browse AND install in one
          page), /connections (接続), /account (アカウント). An app's page
          (`/apps/:id`, canonical) and the run details opened from its history
          stay routable. */}
      <Route component={ShellLayout}>
        <Route path="/" component={AppListView} />
        <Route path="/new" component={NewRoute} />
        <Route path="/connections" component={ConnectionsView} />
        <Route path="/account" component={AccountView} />
        <Route path="/account/:section" component={AccountView} />
        <Route path="/apps/:id" component={AppPage} />
        <Route path="/runs/:id" component={RunView} />
        {/* Notifications link grouped updates here. */}
        <Route path="/run-groups/:id" component={RunGroupView} />
        <Route path="/notifications" component={NotificationsView} />
      </Route>

      {/* The store browser and the add flow are ONE page (`/new`). `/store` was
          the second, duplicate store surface and is now just a compatibility
          entrance for older links — query intact, so a store deep link still
          pre-fills. */}
      <Route path="/store" component={() => <RedirectWithQuery to="/new" />} />

      {/* Old paths → where that behavior lives now. Screens that were internal
          concepts (run list, activity, the all-apps list)
          became parts of each app's page, which ホーム lists. Settings,
          management and Workspace tabs became 接続 and アカウント. /install is
          the external install link (client-handled): it forwards its query to
          /new, where lib/install-link.ts pre-fills the Git form — pre-fill
          only, the visitor always confirms before anything installs. A
          provider OAuth helper callback's /connections keeps its result query
          too. The all-apps list is ホーム, so /apps lands there; an app's
          own page is /apps/:id. */}
      <Route path="/home" component={() => <Navigate href="/" />} />
      <Route path="/apps" component={() => <Navigate href="/" />} />
      <Route path="/workloads" component={() => <Navigate href="/" />} />
      <Route path="/runs" component={() => <Navigate href="/" />} />
      <Route path="/activity" component={() => <Navigate href="/" />} />
      <Route path="/graph" component={() => <Navigate href="/" />} />
      <Route path="/sources" component={() => <Navigate href="/" />} />
      <Route path="/services" component={() => <Navigate href="/" />} />
      <Route path="/capsules" component={() => <Navigate href="/" />} />
      <Route path="/apps/:id/:tab" component={RedirectLegacyAppPage} />
      <Route path="/workloads/:id" component={RedirectLegacyAppPage} />
      <Route path="/workloads/:id/:tab" component={RedirectLegacyAppPage} />
      <Route path="/services/:id" component={RedirectLegacyAppPage} />
      <Route path="/services/:id/:tab" component={RedirectLegacyAppPage} />
      <Route path="/capsules/:id" component={RedirectLegacyAppPage} />
      <Route path="/capsules/:id/:tab" component={RedirectLegacyAppPage} />
      <Route path="/settings" component={() => <Navigate href="/account" />} />
      <Route
        path="/settings/account"
        component={() => <Navigate href="/account" />}
      />
      <Route
        path="/settings/billing"
        component={() => <RedirectWithQuery to="/account/billing" />}
      />
      <Route
        path="/settings/manage"
        component={() => <Navigate href="/account" />}
      />
      <Route
        path="/settings/manage/hosted-resources"
        component={() => <Navigate href="/" />}
      />
      <Route
        path="/advanced/workspace"
        component={() => <Navigate href="/account/workspace" />}
      />
      <Route
        path="/advanced/workspace/:tab"
        component={RedirectLegacyWorkspaceSettingsTab}
      />
      <Route
        path="/workspace/settings"
        component={() => <Navigate href="/account/workspace" />}
      />
      <Route
        path="/workspace/settings/:tab"
        component={RedirectLegacyWorkspaceSettingsTab}
      />
      <Route
        path="/members"
        component={() => <Navigate href="/account/members" />}
      />
      <Route
        path="/backups"
        component={() => <Navigate href="/account/workspace" />}
      />
      <Route
        path="/output-shares"
        component={() => <Navigate href="/account/workspace" />}
      />
      <Route
        path="/providers"
        component={() => <Navigate href="/connections" />}
      />
      <Route
        path="/billing"
        component={() => <RedirectWithQuery to="/account/billing" />}
      />
      <Route
        path="/account/settings"
        component={() => <Navigate href="/account/workspace" />}
      />
      <Route
        path="/account/profile"
        component={() => <Navigate href="/account" />}
      />
      <Route
        path="/account/sessions"
        component={() => <Navigate href="/account" />}
      />
      {/* Anything else is a real 404 — no silent bounce to home. */}
      <Route path="*" component={NotFoundView} />
    </Router>
  );
}

function mountDashboard(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("dashboard mount target #root not found");
  // The document shell owns the static boot status until capability discovery
  // completes. Solid inserts rendered nodes before an existing first child, so
  // clear that fallback before mounting or it remains visible below the SPA.
  root.replaceChildren();
  render(
    () => (
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    ),
    root,
  );
}

// Server capabilities are composition truth for the first route too. Mounting
// before discovery completes can permanently select an OSS fallback inside an
// untracked list item even after the capability signal updates.
void initializeTakosumiRuntimeCapabilities().finally(mountDashboard);
