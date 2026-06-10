/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Navigate, Route, Router } from "@solidjs/router";

// Web fonts referenced by account.css (`--tg-font-body` / `--tg-font-mono`).
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";

// The ported dashboard stylesheet (`--tg-*` tokens + shell/page classes). It is
// also imported once from account/components/shell/AppShell.tsx, but importing
// it here guarantees the tokens are present on the public `/sign-in` screens
// that render before any AppShell-wrapped screen mounts.
import "./views/account/account.css";

const AccountIndexView = lazy(() =>
  import("./views/account/AccountMiscViews.tsx").then((m) => ({
    default: m.AccountIndexView,
  }))
);
const SignInView = lazy(() =>
  import("./views/account/AccountMiscViews.tsx").then((m) => ({
    default: m.SignInView,
  }))
);
const SignInCallbackView = lazy(() =>
  import("./views/account/AccountMiscViews.tsx").then((m) => ({
    default: m.SignInCallbackView,
  }))
);
const HomeView = lazy(() =>
  import("./views/account/AccountMiscViews.tsx").then((m) => ({
    default: m.HomeView,
  }))
);
const NotificationsView = lazy(() =>
  import("./views/account/AccountMiscViews.tsx").then((m) => ({
    default: m.NotificationsView,
  }))
);
const InstallByUrlView = lazy(() =>
  import("./views/account/AccountMiscViews.tsx").then((m) => ({
    default: m.InstallByUrlView,
  }))
);
const TakosStartView = lazy(() =>
  import("./views/account/AccountMiscViews.tsx").then((m) => ({
    default: m.TakosStartView,
  }))
);
const AccountHubView = lazy(() =>
  import("./views/account/AccountHubView.tsx").then((m) => ({
    default: m.AccountHubView,
  }))
);
const AccountProfileView = lazy(() =>
  import("./views/account/AccountHubView.tsx").then((m) => ({
    default: m.AccountProfileView,
  }))
);
const AccountSessionsView = lazy(() =>
  import("./views/account/AccountHubView.tsx").then((m) => ({
    default: m.AccountSessionsView,
  }))
);
const AccountSettingsView = lazy(() =>
  import("./views/account/AccountHubView.tsx").then((m) => ({
    default: m.AccountSettingsView,
  }))
);
const AccountBillingView = lazy(() =>
  import("./views/account/AccountHubView.tsx").then((m) => ({
    default: m.AccountBillingView,
  }))
);
const InstallationsListView = lazy(() =>
  import("./views/installations/InstallationsListView.tsx")
);
const InstallationDetailView = lazy(() =>
  import("./views/installations/InstallationDetailView.tsx")
);
const InstallationDangerView = lazy(() =>
  import("./views/installations/InstallationDangerView.tsx")
);
const ConnectionsView = lazy(() =>
  import("./views/connections/ConnectionsView.tsx")
);

// Control-plane views (spec §31, conformance M10) — session-authed dashboard
// over the `/v1/control/*` account-plane pass-through routes.
const ControlInstallationsView = lazy(() =>
  import("./views/control/ControlInstallationsView.tsx")
);
const ControlInstallationDetailView = lazy(() =>
  import("./views/control/ControlInstallationDetailView.tsx")
);
const ControlGraphView = lazy(() =>
  import("./views/control/ControlGraphView.tsx")
);
const ControlSourcesView = lazy(() =>
  import("./views/control/ControlSourcesView.tsx")
);
const ControlProvidersView = lazy(() =>
  import("./views/control/ControlProvidersView.tsx")
);
const ControlOutputSharesView = lazy(() =>
  import("./views/control/ControlOutputSharesView.tsx")
);
const ControlBackupsView = lazy(() =>
  import("./views/control/ControlBackupsView.tsx")
);
const InstallFromGitView = lazy(() =>
  import("./views/control/InstallFromGitView.tsx")
);
const ControlRunView = lazy(() =>
  import("./views/control/ControlRunView.tsx")
);
const ControlRunGroupView = lazy(() =>
  import("./views/control/ControlRunGroupView.tsx")
);
const ControlActivityView = lazy(() =>
  import("./views/control/ControlActivityView.tsx")
);

function App() {
  return (
    <Router>
      {/* Index — self-resolves to /home or /sign-in via the session cookie. */}
      <Route path="/" component={AccountIndexView} />

      {/* Public — no session required. */}
      <Route path="/sign-in" component={SignInView} />
      <Route path="/sign-in/callback" component={SignInCallbackView} />

      {/* Marketing-site CTA aliases. The takosumi.com website links to
          /signup and /login (common wording), but this dashboard only has a
          single sign-in screen. Redirect both to /sign-in so a visitor who
          clicks "始める" / "ログイン" lands on a real screen instead of a
          blank page. The website is owned elsewhere and stays as-is. */}
      <Route path="/signup" component={() => <Navigate href="/sign-in" />} />
      <Route path="/login" component={() => <Navigate href="/sign-in" />} />

      {/* Self-gated (redirect to /sign-in when no account-plane session). */}
      <Route path="/home" component={HomeView} />
      <Route path="/notifications" component={NotificationsView} />
      <Route path="/account" component={AccountHubView} />
      <Route path="/account/profile" component={AccountProfileView} />
      <Route path="/account/sessions" component={AccountSessionsView} />
      <Route path="/account/settings" component={AccountSettingsView} />
      <Route path="/account/billing" component={AccountBillingView} />

      {/* Control-plane surface (spec §31). `/install` and `/installations` map
          to the control views; the legacy account-plane install-by-URL wizard
          and installation detail/danger screens stay reachable under /apps/*. */}
      <Route path="/install" component={InstallFromGitView} />
      <Route path="/installations" component={ControlInstallationsView} />
      <Route path="/installations/:id" component={ControlInstallationDetailView} />
      <Route path="/sources" component={ControlSourcesView} />
      <Route path="/providers" component={ControlProvidersView} />
      <Route path="/graph" component={ControlGraphView} />
      <Route path="/output-shares" component={ControlOutputSharesView} />
      <Route path="/backups" component={ControlBackupsView} />
      <Route path="/runs/:id" component={ControlRunView} />
      <Route path="/run-groups/:id" component={ControlRunGroupView} />
      <Route path="/activity" component={ControlActivityView} />

      {/* Legacy account-plane installation screens (snake-case `/v1/*`). */}
      <Route path="/apps" component={InstallationsListView} />
      <Route path="/apps/install" component={InstallByUrlView} />
      <Route path="/apps/:id" component={InstallationDetailView} />
      <Route path="/apps/:id/danger" component={InstallationDangerView} />

      <Route path="/connections" component={ConnectionsView} />

      <Route path="/takos/start" component={TakosStartView} />

      {/* Catch-all — any unknown path must render something, never a blank
          screen. `AccountIndexView` resolves the session cookie and sends the
          visitor to /home (signed in) or /sign-in (signed out), showing a
          "読み込み中..." state in the meantime. Without this, an unmatched
          route under the SPA 200 fallback would mount the bundle with no
          matching <Route> and paint nothing. */}
      <Route path="*" component={AccountIndexView} />
    </Router>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("dashboard mount target #root not found");
render(() => <App />, root);
