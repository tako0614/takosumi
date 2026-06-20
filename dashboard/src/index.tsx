/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import {
  Navigate,
  Route,
  Router,
  useLocation,
  useParams,
} from "@solidjs/router";
import { installStaleAssetReload } from "./lib/chunk-reload.ts";

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
const NotFoundView = lazy(() => import("./views/NotFoundView.tsx"));

// --- Capsule-centric core -----------------------------------------------------
const AppListView = lazy(() => import("./views/apps/AppListView.tsx"));
const AppDetailView = lazy(() => import("./views/apps/AppDetailView.tsx"));
const NewAppView = lazy(() => import("./views/new/NewAppView.tsx"));
const RunView = lazy(() => import("./views/runs/RunView.tsx"));
const RunGroupView = lazy(() => import("./views/runs/RunGroupView.tsx"));
const GraphView = lazy(() => import("./views/graph/GraphView.tsx"));
const ActivityView = lazy(() => import("./views/activity/ActivityView.tsx"));
const NotificationsView = lazy(
  () => import("./views/notifications/NotificationsView.tsx"),
);
const SpaceSettingsView = lazy(
  () => import("./views/space/SpaceSettingsView.tsx"),
);
const AccountView = lazy(() => import("./views/account/AccountView.tsx"));

// --- redirects ---------------------------------------------------------------

/** Redirect preserving the query string (the external install link's
 * `/install?git=…` prefill and the Cloudflare OAuth callback's
 * `/connections?connected=1` both carry load-bearing params). */
function RedirectWithQuery(props: { readonly to: string }) {
  const loc = useLocation();
  return <Navigate href={`${props.to}${loc.search}`} />;
}

/** `/apps/:id` -> `/capsules/:id` (legacy dashboard links). */
function RedirectLegacyAppDetail() {
  const params = useParams();
  const id = encodeURIComponent(params.id ?? "");
  const tab = params.tab ? `/${encodeURIComponent(params.tab)}` : "";
  return <Navigate href={`/capsules/${id}${tab}`} />;
}

/** `/installations/:id` -> `/capsules/:id` while legacy URLs age out. */
function RedirectLegacyInstallationDetail() {
  const params = useParams();
  const id = encodeURIComponent(params.id ?? "");
  const tab = params.tab ? `/${encodeURIComponent(params.tab)}` : "";
  return <Navigate href={`/capsules/${id}${tab}`} />;
}

function App() {
  return (
    <Router>
      {/* Public — no session required. */}
      <Route path="/sign-in" component={SignInView} />
      <Route path="/sign-in/callback" component={SignInCallbackView} />
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

      {/* Capsule-centric core (AuthGuard-gated inside each view). */}
      <Route path="/" component={AppListView} />
      <Route path="/capsules" component={AppListView} />
      <Route path="/new" component={NewAppView} />
      <Route path="/capsules/:id" component={AppDetailView} />
      <Route path="/capsules/:id/:tab" component={AppDetailView} />
      <Route path="/runs/:id" component={RunView} />
      <Route path="/run-groups/:id" component={RunGroupView} />
      <Route path="/graph" component={GraphView} />
      <Route path="/activity" component={ActivityView} />
      <Route path="/notifications" component={NotificationsView} />
      <Route path="/space/settings" component={SpaceSettingsView} />
      <Route path="/space/settings/:tab" component={SpaceSettingsView} />
      <Route path="/account" component={AccountView} />

      {/* Old paths → new homes. /install is the external install link
          (client-handled): it forwards its query to /new, where
          lib/install-link.ts seeds the Git form — pre-fill only, the visitor
          always confirms before anything installs. The Cloudflare OAuth
          callback's /connections keeps its result query too. */}
      <Route
        path="/install"
        component={() => <RedirectWithQuery to="/new" />}
      />
      <Route
        path="/installations"
        component={() => <RedirectWithQuery to="/capsules" />}
      />
      <Route
        path="/installations/:id"
        component={RedirectLegacyInstallationDetail}
      />
      <Route
        path="/installations/:id/:tab"
        component={RedirectLegacyInstallationDetail}
      />
      <Route
        path="/connections"
        component={() => <RedirectWithQuery to="/space/settings/connections" />}
      />
      <Route path="/home" component={() => <Navigate href="/" />} />
      <Route path="/apps" component={() => <Navigate href="/capsules" />} />
      <Route path="/apps/:id" component={RedirectLegacyAppDetail} />
      <Route path="/apps/:id/:tab" component={RedirectLegacyAppDetail} />
      <Route
        path="/members"
        component={() => <Navigate href="/space/settings/members" />}
      />
      <Route
        path="/backups"
        component={() => <Navigate href="/space/settings/backups" />}
      />
      <Route
        path="/output-shares"
        component={() => <Navigate href="/space/settings/shares" />}
      />
      <Route path="/sources" component={() => <Navigate href="/" />} />
      <Route
        path="/providers"
        component={() => <Navigate href="/space/settings/connections" />}
      />
      <Route
        path="/account/settings"
        component={() => <Navigate href="/space/settings" />}
      />
      <Route
        path="/account/billing"
        component={() => <Navigate href="/space/settings/billing" />}
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

const root = document.getElementById("root");
if (!root) throw new Error("dashboard mount target #root not found");
render(() => <App />, root);
