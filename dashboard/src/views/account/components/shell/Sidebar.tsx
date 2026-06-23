/**
 * Primary navigation: a persistent left rail. It leads with the everyday
 * surfaces (home launcher / cloud accounts / settings) so management is always
 * one click away — the launcher home stays app-like, the rail keeps wayfinding
 * (where am I, what else is there) that the chromeless shell had lost.
 */
import { A, useLocation } from "@solidjs/router";
import { ArrowLeft, CreditCard, Home, Plug, Plus, Settings } from "lucide-solid";
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
  icon: typeof Home;
  /** Match only the exact path (the "/" home link). */
  end?: boolean;
};

const PRIMARY: NavItem[] = [
  { href: "/", labelKey: "nav.home", icon: Home, end: true },
  { href: "/new", labelKey: "nav.add", icon: Plus },
  { href: "/connections", labelKey: "nav.connections", icon: Plug },
  { href: "/advanced/workspace", labelKey: "nav.spaceSettings", icon: Settings },
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
      <nav class="sidebar-nav" aria-label={t("nav.manage")}>
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
