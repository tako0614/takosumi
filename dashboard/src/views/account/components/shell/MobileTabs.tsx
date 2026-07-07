/**
 * Mobile bottom bar: the app-first everyday destinations only — the launcher,
 * add-an-app, and settings. Icons carry the meaning (labels are dropped for a
 * calmer bar; the accessible name stays on each link). Account and activity
 * history are reached from the profile avatar in the top bar, and deeper hosting
 * management stays inside settings.
 */
import { A, useLocation } from "@solidjs/router";
import { LayoutGrid, Plus, Settings } from "lucide-solid";
import { For } from "solid-js";
import { t } from "../../../../i18n/index.ts";

export default function MobileTabs() {
  const loc = useLocation();
  const tabs = () => [
    { href: "/", label: () => t("nav.apps"), icon: LayoutGrid, end: true },
    { href: "/new", label: () => t("nav.add"), icon: Plus },
    {
      href: "/advanced/workspace",
      label: () => t("nav.workspaceSettingsShort"),
      icon: Settings,
    },
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
            <tab.icon size={24} />
          </A>
        )}
      </For>
    </nav>
  );
}
