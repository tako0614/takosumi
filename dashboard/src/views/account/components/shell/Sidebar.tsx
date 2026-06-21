/**
 * Primary navigation for the normal Takosumi Cloud surface. Technical workspace
 * settings stay available from advanced routes, but the main chrome leads with
 * the service-hosting tasks ordinary users need every day.
 */
import { A, useLocation } from "@solidjs/router";
import {
  Activity,
  ArrowLeft,
  CreditCard,
  Home,
  Plug,
  Plus,
  UserCircle2,
} from "lucide-solid";
import { Show } from "solid-js";
import Wordmark from "../brand/Wordmark.tsx";
import { t } from "../../../../i18n/index.ts";
import type { MessageKey } from "../../../../i18n/index.ts";
import { isTakosumiCloudRuntime } from "../../../../lib/deployment-brand.ts";

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
];

const MANAGE: NavItem[] = [
  { href: "/connections", labelKey: "nav.connections", icon: Plug },
  { href: "/billing", labelKey: "nav.billing", icon: CreditCard },
  { href: "/activity", labelKey: "nav.activity", icon: Activity },
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
        <Wordmark
          href={TAKOS_EMBEDDED ? undefined : "/"}
          size={22}
          showSub={!TAKOS_EMBEDDED && isTakosumiCloudRuntime()}
        />
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
      <nav class="sidebar-nav sidebar-nav-secondary" aria-label={t("nav.manage")}>
        <span class="sidebar-section-label">{t("nav.manage")}</span>
        {MANAGE.map((item) => (
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
