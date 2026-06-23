/**
 * Mobile bottom bar mirroring the sidebar's primary destinations, so phones get
 * the same one-tap wayfinding (home / provider access / settings) instead of
 * burying everything in the profile menu.
 */
import { A, useLocation } from "@solidjs/router";
import { Home, Plug, Settings } from "lucide-solid";
import { t } from "../../../../i18n/index.ts";

export default function MobileTabs() {
  const loc = useLocation();
  const TABS = [
    { href: "/", label: () => t("nav.home"), icon: Home, end: true },
    { href: "/connections", label: () => t("nav.connections"), icon: Plug },
    {
      href: "/advanced/workspace",
      label: () => t("nav.spaceSettingsShort"),
      icon: Settings,
    },
  ] as const;
  const isActive = (href: string, end?: boolean) =>
    end
      ? loc.pathname === href
      : loc.pathname === href || loc.pathname.startsWith(href + "/");
  return (
    <nav class="mobile-tabs" aria-label="Mobile primary">
      {TABS.map((tab) => (
        <A
          href={tab.href}
          class="mobile-tab"
          classList={{
            active: isActive(tab.href, "end" in tab ? tab.end : false),
          }}
          aria-label={tab.label()}
        >
          <tab.icon size={20} />
          <span>{tab.label()}</span>
        </A>
      ))}
    </nav>
  );
}
