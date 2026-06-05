/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import { Route, Router } from "@solidjs/router";

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

function App() {
  return (
    <Router>
      {/* Index — self-resolves to /home or /sign-in via the session cookie. */}
      <Route path="/" component={AccountIndexView} />

      {/* Public — no session required. */}
      <Route path="/sign-in" component={SignInView} />
      <Route path="/sign-in/callback" component={SignInCallbackView} />

      {/* Self-gated (redirect to /sign-in when no account-plane session). */}
      <Route path="/home" component={HomeView} />
      <Route path="/notifications" component={NotificationsView} />
      <Route path="/account" component={AccountHubView} />
      <Route path="/account/profile" component={AccountProfileView} />
      <Route path="/account/sessions" component={AccountSessionsView} />

      <Route path="/install" component={InstallByUrlView} />
      <Route path="/installations" component={InstallationsListView} />
      <Route path="/installations/:id" component={InstallationDetailView} />
      <Route path="/installations/:id/danger" component={InstallationDangerView} />

      <Route path="/connections" component={ConnectionsView} />

      <Route path="/takos/start" component={TakosStartView} />
    </Router>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("dashboard mount target #root not found");
render(() => <App />, root);
