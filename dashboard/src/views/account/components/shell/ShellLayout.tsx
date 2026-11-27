/**
 * Route-level shell layout: every authenticated screen is nested under this
 * one <Route component={ShellLayout}> in `index.tsx`, so views no longer wrap
 * themselves in <AppShell>. The AuthGuard runs before the chrome mounts so the
 * sidebar / top-bar data fetches never fire for signed-out visitors.
 */
import type { RouteSectionProps } from "@solidjs/router";
import type { JSX } from "solid-js";
import AppShell from "./AppShell.tsx";
import AuthGuard from "../auth/AuthGuard.tsx";
import MobileTabs from "./MobileTabs.tsx";
import PrimaryNavigation from "./Sidebar.tsx";

function sessionRecoveryLayout(body: JSX.Element): JSX.Element {
  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-inner">
          <PrimaryNavigation />
        </div>
      </header>
      <div class="app-shell-main">{body}</div>
      <MobileTabs />
    </div>
  );
}

export default function ShellLayout(props: RouteSectionProps) {
  return (
    <AuthGuard transportRecoveryLayout={sessionRecoveryLayout}>
      {() => <AppShell>{props.children}</AppShell>}
    </AuthGuard>
  );
}
