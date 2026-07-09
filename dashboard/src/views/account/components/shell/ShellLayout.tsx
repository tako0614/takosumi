/**
 * Route-level shell layout: every authenticated screen is nested under this
 * one <Route component={ShellLayout}> in `index.tsx`, so views no longer wrap
 * themselves in <AppShell>. The AuthGuard runs before the chrome mounts so the
 * sidebar / top-bar data fetches never fire for signed-out visitors.
 */
import type { RouteSectionProps } from "@solidjs/router";
import AppShell from "./AppShell.tsx";
import AuthGuard from "../auth/AuthGuard.tsx";

export default function ShellLayout(props: RouteSectionProps) {
  return <AuthGuard>{() => <AppShell>{props.children}</AppShell>}</AuthGuard>;
}
