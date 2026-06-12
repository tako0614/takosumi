/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Navigate, Route, Router, useLocation, useParams } from "@solidjs/router";

// Web fonts referenced by the design tokens (`--tg-font-body` / `--tg-font-mono`).
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";

// Dark "Splatoon ink" design system:
//   tokens (canonical dark palette) → base (reset/body/a11y) → components
//   (shared + ui/* classes) → shell (app chrome + auth) → views (per-view rules).
// Imported once here so the tokens are present on the public `/sign-in` screens
// that render before any AppShell-wrapped screen mounts.
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/views.css";
import "./styles/app-views.css";

// --- auth (public) ----------------------------------------------------------
const SignInView = lazy(() => import("./views/auth/SignInView.tsx"));
const SignInCallbackView = lazy(() =>
  import("./views/auth/SignInView.tsx").then((m) => ({
    default: m.SignInCallbackView,
  }))
);
const NotFoundView = lazy(() => import("./views/NotFoundView.tsx"));

// --- app-centric core ---------------------------------------------------------
const AppListView = lazy(() => import("./views/apps/AppListView.tsx"));
const AppDetailView = lazy(() => import("./views/apps/AppDetailView.tsx"));
const NewAppView = lazy(() => import("./views/new/NewAppView.tsx"));
const RunView = lazy(() => import("./views/runs/RunView.tsx"));
const RunGroupView = lazy(() => import("./views/runs/RunGroupView.tsx"));
const GraphView = lazy(() => import("./views/graph/GraphView.tsx"));
const ActivityView = lazy(() => import("./views/activity/ActivityView.tsx"));
const NotificationsView = lazy(() => import("./views/notifications/NotificationsView.tsx"));
const SpaceSettingsView = lazy(() => import("./views/space/SpaceSettingsView.tsx"));
const AccountView = lazy(() => import("./views/account/AccountView.tsx"));
const TakosStartView = lazy(() => import("./views/account/TakosStartView.tsx"));

// --- redirects ---------------------------------------------------------------

/** Redirect preserving the query string (deep links carry params, e.g.
 * the worker's `/install?git=…` external install link and the Cloudflare
 * OAuth callback's `/connections?connected=1`). */
function RedirectWithQuery(props: { readonly to: string }) {
  const loc = useLocation();
  return <Navigate href={`${props.to}${loc.search}`} />;
}

/** `/installations/:id` → `/apps/:id` (old control-plane detail links). */
function RedirectInstallationDetail() {
  const params = useParams();
  return <Navigate href={`/apps/${encodeURIComponent(params.id ?? "")}`} />;
}

function App() {
  return (
    <Router>
      {/* Public — no session required. */}
      <Route path="/sign-in" component={SignInView} />
      <Route path="/sign-in/callback" component={SignInCallbackView} />
      {/* Marketing-site CTA aliases (the takosumi.com website links /signup
          and /login). */}
      <Route path="/signup" component={() => <Navigate href="/sign-in" />} />
      <Route path="/login" component={() => <Navigate href="/sign-in" />} />

      {/* App-centric core (AuthGuard-gated inside each view). */}
      <Route path="/" component={AppListView} />
      <Route path="/new" component={NewAppView} />
      <Route path="/apps/:id" component={AppDetailView} />
      <Route path="/apps/:id/:tab" component={AppDetailView} />
      <Route path="/runs/:id" component={RunView} />
      <Route path="/run-groups/:id" component={RunGroupView} />
      <Route path="/graph" component={GraphView} />
      <Route path="/activity" component={ActivityView} />
      <Route path="/notifications" component={NotificationsView} />
      <Route path="/space/settings" component={SpaceSettingsView} />
      <Route path="/space/settings/:tab" component={SpaceSettingsView} />
      <Route path="/account" component={AccountView} />
      <Route path="/takos/start" component={TakosStartView} />

      {/* Old paths → new homes. Backend-emitted deep links keep their query:
          the worker's /install external link and the Cloudflare OAuth
          callback's /connections both redirect with params intact. */}
      <Route path="/install" component={() => <RedirectWithQuery to="/new" />} />
      <Route
        path="/connections"
        component={() => <RedirectWithQuery to="/space/settings/connections" />}
      />
      <Route path="/home" component={() => <Navigate href="/" />} />
      <Route path="/installations" component={() => <Navigate href="/" />} />
      <Route path="/installations/:id" component={RedirectInstallationDetail} />
      <Route path="/apps" component={() => <Navigate href="/" />} />
      <Route path="/members" component={() => <Navigate href="/space/settings/members" />} />
      <Route path="/backups" component={() => <Navigate href="/space/settings/backups" />} />
      <Route path="/output-shares" component={() => <Navigate href="/space/settings/shares" />} />
      <Route path="/sources" component={() => <Navigate href="/" />} />
      <Route path="/providers" component={() => <Navigate href="/space/settings/connections" />} />
      <Route path="/account/settings" component={() => <Navigate href="/space/settings" />} />
      <Route path="/account/billing" component={() => <Navigate href="/space/settings/billing" />} />
      <Route path="/account/profile" component={() => <Navigate href="/account" />} />
      <Route path="/account/sessions" component={() => <Navigate href="/account" />} />

      {/* Anything else is a real 404 — no silent bounce to home. */}
      <Route path="*" component={NotFoundView} />
    </Router>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("dashboard mount target #root not found");
render(() => <App />, root);
