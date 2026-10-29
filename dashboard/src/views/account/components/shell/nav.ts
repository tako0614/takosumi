/**
 * Shell navigation — the single source of truth.
 *
 * The primary nav is what people do with Takosumi (TASK-0115):
 *   ホーム   — open and keep the apps you installed
 *   ストア   — find an app and install it (`/new`)
 *   接続     — connect your personal cloud accounts
 *   アカウント — your profile and personal usage
 * The desktop sidebar and the mobile bottom bar render this list verbatim, and
 * the top bar names the section from the same table, so a route rename cannot
 * desync the chrome. Nothing else is a top-level destination: run history,
 * activity, recovery and created resources belong to each app's
 * page, and workspace-wide tools that no behavior needs stay in the API and CLI.
 */
import { LayoutGrid, Plug, Store, UserCircle2 } from "lucide-solid";
import type { MessageKey } from "../../../../i18n/index.ts";

export type ShellNavItem = {
  readonly href: string;
  readonly labelKey: MessageKey;
  readonly icon: typeof LayoutGrid;
  /** Match only the exact path (the "/" home link). */
  readonly end?: boolean;
  /** Other path prefixes that belong to this destination. */
  readonly alsoActiveOn?: readonly string[];
};

/** The four primary destinations — identical on the sidebar and mobile bar. */
export const PRIMARY_NAV: readonly ShellNavItem[] = [
  // An installed app's page and the run details opened from its history are
  // part of keeping your apps, so they keep ホーム selected.
  {
    href: "/",
    labelKey: "nav.home",
    icon: LayoutGrid,
    end: true,
    alsoActiveOn: ["/apps", "/runs", "/run-groups"],
  },
  // ストア = browse + install in one page (`/new`).
  { href: "/new", labelKey: "nav.store", icon: Store },
  { href: "/connections", labelKey: "nav.connections", icon: Plug },
  { href: "/account", labelKey: "nav.account", icon: UserCircle2 },
];

/** Section title shown in the top bar, by route. Detail routes show the
 * section they belong to (the item's own name stays in the page header). */
export const SECTION_TITLES: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/^\/$/, "nav.home"],
  // An installed app's page is titled アプリ / App; ホーム stays selected.
  [/^\/apps(\/|$)/, "nav.app"],
  [/^\/runs(\/|$)/, "nav.home"],
  [/^\/run-groups(\/|$)/, "nav.home"],
  [/^\/new(\/|$)/, "nav.store"],
  [/^\/connections(\/|$)/, "nav.connections"],
  [/^\/account(\/|$)/, "nav.account"],
  [/^\/notifications(\/|$)/, "nav.notifications"],
];

/** Route-active test shared by the sidebar and the bottom bar. */
export function isNavActive(pathname: string, item: ShellNavItem): boolean {
  const matches = (href: string, exact: boolean) =>
    exact
      ? pathname === href
      : pathname === href || pathname.startsWith(href + "/");
  if (matches(item.href, item.end === true)) return true;
  return (item.alsoActiveOn ?? []).some((prefix) => matches(prefix, false));
}
