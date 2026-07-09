/* @refresh reload */
import { lazy, onMount } from "solid-js";
import { render } from "solid-js/web";
import {
  Navigate,
  Route,
  Router,
  useLocation,
  useParams,
} from "@solidjs/router";
import { installStaleAssetReload } from "./lib/chunk-reload.ts";
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

// --- Normal hosted-service surface --------------------------------------------
const AppListView = lazy(() => import("./views/apps/AppListView.tsx"));
const ServiceListView = lazy(() => import("./views/apps/ServiceListView.tsx"));
const AppDetailView = lazy(() => import("./views/apps/AppDetailView.tsx"));
const NewAppView = lazy(() => import("./views/new/NewAppView.tsx"));
const RunsListView = lazy(() => import("./views/runs/RunsListView.tsx"));
const RunView = lazy(() => import("./views/runs/RunView.tsx"));
const RunGroupView = lazy(() => import("./views/runs/RunGroupView.tsx"));
const GraphView = lazy(() => import("./views/graph/GraphView.tsx"));
const ActivityView = lazy(() => import("./views/activity/ActivityView.tsx"));
const NotificationsView = lazy(
  () => import("./views/notifications/NotificationsView.tsx"),
);
const CloudResourcesView = lazy(
  () => import("./views/cloud/CloudResourcesView.tsx"),
);
const WorkspaceSettingsView = lazy(
  () => import("./views/workspace/WorkspaceSettingsView.tsx"),
);
const AccountView = lazy(() => import("./views/account/AccountView.tsx"));

function ConnectionsView() {
  return <WorkspaceSettingsView standaloneTab="connections" />;
}

function BillingView() {
  return <WorkspaceSettingsView standaloneTab="billing" />;
}

function AdvancedWorkspaceView() {
  return <WorkspaceSettingsView />;
}

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
 * `/install?git=…` prefill and the Cloudflare OAuth callback's
 * `/connections?connected=1` both carry load-bearing params). */
function RedirectWithQuery(props: { readonly to: string }) {
  const loc = useLocation();
  return <Navigate href={`${props.to}${loc.search}`} />;
}

/** `/apps/:id` -> `/services/:id` (legacy dashboard links). */
function RedirectLegacyAppDetail() {
  const params = useParams();
  const id = encodeURIComponent(params.id ?? "");
  const tab = params.tab ? `/${encodeURIComponent(params.tab)}` : "";
  return <Navigate href={`/services/${id}${tab}`} />;
}

/** `/installations/:id` -> `/services/:id` while legacy URLs age out. */
function RedirectLegacyInstallationDetail() {
  const params = useParams();
  const id = encodeURIComponent(params.id ?? "");
  const tab = params.tab ? `/${encodeURIComponent(params.tab)}` : "";
  return <Navigate href={`/services/${id}${tab}`} />;
}

/** `/capsules/:id` -> `/services/:id` while final URLs settle. */
function RedirectCapsuleDetail() {
  const params = useParams();
  const id = encodeURIComponent(params.id ?? "");
  const tab = params.tab ? `/${encodeURIComponent(params.tab)}` : "";
  return <Navigate href={`/services/${id}${tab}`} />;
}

function App() {
  return (
    <Router>
      {/* Public — no session required. */}
      <Route path="/sign-in" component={SignInView} />
      <Route path="/sign-in/callback" component={SignInCallbackView} />
      <Route path="/oauth" component={ServerOwnedRouteReload} />
      <Route path="/oauth/*path" component={ServerOwnedRouteReload} />
      <Route path="/legal/:page" component={LegalView} />
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

      {/* Normal hosted-service surface (AuthGuard-gated inside each view). */}
      <Route path="/" component={AppListView} />
      <Route path="/services" component={ServiceListView} />
      <Route path="/new" component={NewAppView} />
      <Route path="/store" component={() => <RedirectWithQuery to="/new" />} />
      <Route path="/cloud" component={CloudResourcesView} />
      <Route path="/connections" component={ConnectionsView} />
      <Route path="/billing" component={BillingView} />
      <Route path="/services/:id" component={AppDetailView} />
      <Route path="/services/:id/:tab" component={AppDetailView} />
      <Route path="/runs" component={RunsListView} />
      <Route path="/runs/:id" component={RunView} />
      <Route path="/run-groups/:id" component={RunGroupView} />
      <Route path="/graph" component={GraphView} />
      <Route path="/activity" component={ActivityView} />
      <Route path="/notifications" component={NotificationsView} />
      <Route
        path="/workspace/settings"
        component={() => <RedirectWithQuery to="/advanced/workspace" />}
      />
      <Route
        path="/workspace/settings/:tab"
        component={(props) => (
          <RedirectWithQuery to={`/advanced/workspace/${props.params.tab}`} />
        )}
      />
      <Route path="/advanced/workspace" component={AdvancedWorkspaceView} />
      <Route
        path="/advanced/workspace/:tab"
        component={AdvancedWorkspaceView}
      />
      <Route path="/account" component={AccountView} />

      {/* Old paths → new homes. /install is the external install link
          (client-handled): it forwards its query to /new, where
          lib/install-link.ts pre-fills the Git form — pre-fill only, the visitor
          always confirms before anything installs. The Cloudflare OAuth
          callback's /connections keeps its result query too. */}
      <Route
        path="/install"
        component={() => <RedirectWithQuery to="/new" />}
      />
      <Route
        path="/installations"
        component={() => <RedirectWithQuery to="/services" />}
      />
      <Route
        path="/installations/:id"
        component={RedirectLegacyInstallationDetail}
      />
      <Route
        path="/installations/:id/:tab"
        component={RedirectLegacyInstallationDetail}
      />
      <Route path="/home" component={() => <Navigate href="/" />} />
      <Route path="/apps" component={() => <Navigate href="/" />} />
      <Route path="/apps/:id" component={RedirectLegacyAppDetail} />
      <Route path="/apps/:id/:tab" component={RedirectLegacyAppDetail} />
      <Route
        path="/capsules"
        component={() => <RedirectWithQuery to="/services" />}
      />
      <Route path="/capsules/:id" component={RedirectCapsuleDetail} />
      <Route path="/capsules/:id/:tab" component={RedirectCapsuleDetail} />
      <Route
        path="/members"
        component={() => <Navigate href="/advanced/workspace/members" />}
      />
      <Route
        path="/backups"
        component={() => <Navigate href="/advanced/workspace/backups" />}
      />
      <Route
        path="/output-shares"
        component={() => <Navigate href="/advanced/workspace/shares" />}
      />
      <Route path="/sources" component={() => <Navigate href="/" />} />
      <Route
        path="/providers"
        component={() => <Navigate href="/connections" />}
      />
      <Route
        path="/account/settings"
        component={() => <Navigate href="/advanced/workspace" />}
      />
      <Route
        path="/account/billing"
        component={() => <Navigate href="/billing" />}
      />
      <Route
        path="/account/profile"
        component={() => <Navigate href="/account" />}
      />
      <Route
        path="/account/sessions"
        component={() => <Navigate href="/account" />}
      />
      <Route
        path="/space/settings"
        component={() => <RedirectWithQuery to="/advanced/workspace" />}
      />
      <Route
        path="/space/settings/:tab"
        component={(props) => (
          <RedirectWithQuery to={`/advanced/workspace/${props.params.tab}`} />
        )}
      />

      {/* Anything else is a real 404 — no silent bounce to home. */}
      <Route path="*" component={NotFoundView} />
    </Router>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("dashboard mount target #root not found");
render(() => <App />, root);
