/**
 * Shell navigation — the single source of truth.
 *
 * The dashboard is a consumer app first: the primary nav is the everyday trio
 * (home launcher / store / settings) and is shared verbatim by the desktop
 * sidebar and the mobile bottom bar. Hosting internals are not deleted — they
 * live behind 設定 > 管理 (`/settings/manage`), listed here as
 * MANAGE_DESTINATIONS so the settings hub and any future surface render the
 * same catalog. TopBar section titles derive from the same table so a route
 * rename cannot desync the chrome.
 */
import {
  Archive,
  Boxes,
  Clock3,
  History,
  LayoutGrid,
  Link2,
  Network,
  Server,
  Settings,
  Share2,
  SlidersHorizontal,
  Store,
} from "lucide-solid";
import type { MessageKey } from "../../../../i18n/index.ts";

export type ShellNavItem = {
  readonly href: string;
  readonly labelKey: MessageKey;
  readonly icon: typeof LayoutGrid;
  /** Match only the exact path (the "/" home link). */
  readonly end?: boolean;
};

/** Everyday consumer nav — identical on the sidebar and the mobile bottom bar. */
export const PRIMARY_NAV: readonly ShellNavItem[] = [
  { href: "/", labelKey: "nav.home", icon: LayoutGrid, end: true },
  { href: "/store", labelKey: "nav.store", icon: Store },
  { href: "/settings", labelKey: "nav.settings", icon: Settings },
];

export type ManageDestination = ShellNavItem & {
  readonly descriptionKey: MessageKey;
};

/**
 * Hosting-management destinations surfaced on 設定 > 管理. Relocated from the
 * old top-level nav — every capability stays reachable, none were removed.
 */
export const MANAGE_DESTINATIONS: readonly ManageDestination[] = [
  {
    href: "/services",
    labelKey: "nav.services",
    descriptionKey: "settings.manage.services",
    icon: Server,
  },
  {
    href: "/connections",
    labelKey: "nav.connections",
    descriptionKey: "settings.manage.connections",
    icon: Link2,
  },
  {
    href: "/runs",
    labelKey: "nav.runs",
    descriptionKey: "settings.manage.runs",
    icon: Clock3,
  },
  {
    href: "/graph",
    labelKey: "nav.graph",
    descriptionKey: "settings.manage.graph",
    icon: Network,
  },
  {
    href: "/resources",
    labelKey: "nav.resources",
    descriptionKey: "settings.manage.resources",
    icon: Boxes,
  },
  {
    href: "/activity",
    labelKey: "nav.activity",
    descriptionKey: "settings.manage.activity",
    icon: History,
  },
  {
    href: "/advanced/workspace",
    labelKey: "nav.workspaceSettings",
    descriptionKey: "settings.manage.workspace",
    icon: SlidersHorizontal,
  },
  {
    href: "/advanced/workspace/backups",
    labelKey: "workspaceSettings.tab.backups",
    descriptionKey: "settings.manage.backups",
    icon: Archive,
  },
  {
    href: "/advanced/workspace/shares",
    labelKey: "workspaceSettings.tab.shares",
    descriptionKey: "settings.manage.shares",
    icon: Share2,
  },
] as const;

/** Section title shown in the top bar, by route. Detail routes show the
 * section they belong to (the item's own name stays in the page header). */
export const SECTION_TITLES: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/^\/$/, "nav.home"],
  [/^\/store(\/|$)/, "nav.store"],
  [/^\/settings\/manage(\/|$)/, "settings.manage.title"],
  [/^\/settings(\/|$)/, "nav.settings"],
  [/^\/services(\/|$)/, "nav.services"],
  [/^\/new(\/|$)/, "nav.add"],
  [/^\/connections(\/|$)/, "nav.connections"],
  [/^\/advanced\/workspace(\/|$)/, "nav.workspaceSettings"],
  [/^\/billing(\/|$)/, "nav.billing"],
  [/^\/runs(\/|$)/, "nav.runs"],
  [/^\/run-groups(\/|$)/, "nav.runs"],
  [/^\/graph(\/|$)/, "nav.graph"],
  [/^\/resources(\/|$)/, "nav.resources"],
  [/^\/notifications(\/|$)/, "nav.notifications"],
  [/^\/activity(\/|$)/, "nav.activity"],
  [/^\/account(\/|$)/, "nav.account"],
];

/** Route-active test shared by the sidebar and the bottom bar. */
export function isNavActive(
  pathname: string,
  item: { readonly href: string; readonly end?: boolean },
): boolean {
  if (item.end) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}
