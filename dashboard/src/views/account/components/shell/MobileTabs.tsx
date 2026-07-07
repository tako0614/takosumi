/**
 * Mobile bottom bar keeps only everyday destinations. Technical hosting
 * management remains available from account/settings surfaces instead of
 * taking over the first screen on small devices.
 */
import { A, useLocation } from "@solidjs/router";
import {
  Clock3,
  Compass,
  LayoutGrid,
  Settings,
  UserCircle2,
} from "lucide-solid";
import { For } from "solid-js";
import { t } from "../../../../i18n/index.ts";

export default function MobileTabs() {
  const loc = useLocation();
  const tabs = () => [
    { href: "/", label: () => t("nav.apps"), icon: LayoutGrid, end: true },
    { href: "/new", label: () => t("nav.add"), icon: Compass },
    { href: "/runs", label: () => t("nav.runs"), icon: Clock3 },
    {
      href: "/advanced/workspace",
      label: () => t("nav.workspaceSettingsShort"),
      icon: Settings,
    },
    { href: "/account", label: () => t("nav.account"), icon: UserCircle2 },
  ];
  const isActive = (href: string, end?: boolean) =>
    end
      ? loc.pathname === href
      : loc.pathname === href || loc.pathname.startsWith(href + "/");
  return (
    <nav class="mobile-tabs" aria-label="Mobile primary">
      <For each={tabs()}>
        {(tab) => (
          <A
            href={tab.href}
            class="mobile-tab"
            classList={{
              active: isActive(tab.href, "end" in tab ? tab.end : false),
            }}
            aria-label={tab.label()}
          >
            <tab.icon size={22} />
            <span class="mobile-tab-label">{tab.label()}</span>
          </A>
        )}
      </For>
    </nav>
  );
}
