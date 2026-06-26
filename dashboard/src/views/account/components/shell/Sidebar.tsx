/**
 * Primary navigation: a persistent left rail. It leads with the everyday app
 * surfaces, while hosting internals stay available in a lower management group.
 */
import { A, useLocation } from "@solidjs/router";
import {
  ArrowLeft,
  Cloud,
  CreditCard,
  LayoutGrid,
  Plug,
  Plus,
  Server,
  Settings,
  Store,
} from "lucide-solid";
import { Show } from "solid-js";
import Wordmark from "../brand/Wordmark.tsx";
import SpaceSwitcher from "./SpaceSwitcher.tsx";
import { t } from "../../../../i18n/index.ts";
import type { MessageKey } from "../../../../i18n/index.ts";
import {
  dashboardProductName,
  isTakosEmbeddedRuntime,
  isTakosumiCloudRuntime,
} from "../../../../lib/deployment-brand.ts";

type NavItem = {
  href: string;
  labelKey: MessageKey;
  icon: typeof LayoutGrid;
  /** Match only the exact path (the "/" apps link). */
  end?: boolean;
};

const PRIMARY: NavItem[] = [
  { href: "/", labelKey: "nav.apps", icon: LayoutGrid, end: true },
  { href: "/new", labelKey: "nav.add", icon: Plus },
  { href: "/store", labelKey: "nav.store", icon: Store },
];

const MANAGE: NavItem[] = [
  { href: "/services", labelKey: "nav.services", icon: Server },
  { href: "/connections", labelKey: "nav.connections", icon: Plug },
  {
    href: "/advanced/workspace",
    labelKey: "nav.spaceSettings",
    icon: Settings,
  },
];

export default function Sidebar() {
  const loc = useLocation();
  const takosEmbedded = () => isTakosEmbeddedRuntime();
  const isActive = (item: { href: string; end?: boolean }) =>
    item.end
      ? loc.pathname === item.href
      : loc.pathname === item.href || loc.pathname.startsWith(item.href + "/");

  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <Wordmark
          href={takosEmbedded() ? undefined : "/"}
          size={22}
          productName={dashboardProductName()}
          showSub={!takosEmbedded() && isTakosumiCloudRuntime()}
        />
        <Show when={takosEmbedded()}>
          <span class="sidebar-context-label">{t("nav.deployContext")}</span>
        </Show>
      </div>
      <Show when={takosEmbedded()}>
        <a href="/" class="sidebar-link sidebar-link-back">
          <ArrowLeft size={18} />
          <span class="sidebar-link-label">{t("nav.backToTakos")}</span>
        </a>
      </Show>
      <Show when={!takosEmbedded()}>
        <div class="sidebar-workspace">
          <SpaceSwitcher />
        </div>
      </Show>
      <nav class="sidebar-nav" aria-label={t("nav.primary")}>
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
      <nav class="sidebar-nav sidebar-nav-manage" aria-label={t("nav.manage")}>
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
        <Show when={isTakosumiCloudRuntime()}>
          <A
            href="/cloud"
            class="sidebar-link"
            classList={{ active: isActive({ href: "/cloud" }) }}
          >
            <Cloud size={18} />
            <span class="sidebar-link-label">{t("nav.cloudResources")}</span>
          </A>
        </Show>
        <Show when={isTakosumiCloudRuntime()}>
          <A
            href="/billing"
            class="sidebar-link"
            classList={{ active: isActive({ href: "/billing" }) }}
          >
            <CreditCard size={18} />
            <span class="sidebar-link-label">{t("nav.billing")}</span>
          </A>
        </Show>
      </nav>
    </aside>
  );
}
