/**
 * Primary navigation — the Installation-centric IA. Five everyday destinations; the
 * former "詳細・上級設定" fold is gone because expert surfaces now live INSIDE
 * the screens they relate to (Capsule detail tabs, Workspace settings tabs) instead of
 * as parallel top-level pages. Notifications ride on the TopBar bell.
 */
import { A, useLocation } from "@solidjs/router";
import {
  Activity,
  ArrowLeft,
  Home,
  Plus,
  Settings2,
  UserCircle2,
} from "lucide-solid";
import { Show } from "solid-js";
import Wordmark from "../brand/Wordmark.tsx";
import { t } from "../../../../i18n/index.ts";
import type { MessageKey } from "../../../../i18n/index.ts";

/**
 * True only in the takos-embedded build of this shared dashboard source (set via
 * the takos web Vite `define`). In the standalone platform-worker dashboard build
 * it is undefined, so the "back to Takos product" affordance stays hidden there.
 */
const TAKOS_EMBEDDED =
  (import.meta.env as Record<string, string | undefined>)
    .VITE_TAKOS_EMBEDDED === "1";

type NavItem = {
  href: string;
  labelKey: MessageKey;
  icon: typeof Home;
  /** Match only the exact path (the "/" home link). */
  end?: boolean;
};

const PRIMARY: NavItem[] = [
  { href: "/", labelKey: "nav.home", icon: Home, end: true },
  { href: "/new", labelKey: "nav.add", icon: Plus },
  { href: "/activity", labelKey: "nav.activity", icon: Activity },
  {
    href: "/workspace/settings",
    labelKey: "nav.spaceSettings",
    icon: Settings2,
  },
  { href: "/account", labelKey: "nav.account", icon: UserCircle2 },
];

export default function Sidebar() {
  const loc = useLocation();
  const isActive = (item: NavItem) =>
    item.end
      ? loc.pathname === item.href
      : loc.pathname === item.href || loc.pathname.startsWith(item.href + "/");

  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <Wordmark href={TAKOS_EMBEDDED ? undefined : "/"} size={22} />
        <Show when={TAKOS_EMBEDDED}>
          <span class="sidebar-context-label">{t("nav.deployContext")}</span>
        </Show>
      </div>
      <Show when={TAKOS_EMBEDDED}>
        <a href="/" class="sidebar-link sidebar-link-back">
          <ArrowLeft size={18} />
          <span class="sidebar-link-label">{t("nav.backToTakos")}</span>
        </a>
      </Show>
      <nav class="sidebar-nav" aria-label="Primary">
        {PRIMARY.map((item) => (
          <A
            href={item.href}
            class="sidebar-link"
            classList={{ active: isActive(item) }}
          >
            <item.icon size={18} />
            <span class="sidebar-link-label">{t(item.labelKey)}</span>
          </A>
        ))}
      </nav>
      <div class="sidebar-footer">
        <a
          href="https://takosumi.com/docs"
          target="_blank"
          rel="external noopener"
          class="sidebar-link sidebar-link-sub"
        >
          {t("nav.docs")} →
        </a>
      </div>
    </aside>
  );
}
