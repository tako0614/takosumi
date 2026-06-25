/**
 * Mobile bottom bar mirroring the sidebar's primary destinations. Icon-only and
 * compact (X-style) — the active tab is just the accent-colored glyph, with the
 * destination name on the accessible label. The top bar names the screen.
 */
import { A, useLocation } from "@solidjs/router";
import { LayoutGrid, Plug, Plus, Settings, Store } from "lucide-solid";
import { t } from "../../../../i18n/index.ts";

export default function MobileTabs() {
  const loc = useLocation();
  const TABS = [
    { href: "/", label: () => t("nav.apps"), icon: LayoutGrid, end: true },
    { href: "/store", label: () => t("nav.store"), icon: Store },
    { href: "/new", label: () => t("nav.add"), icon: Plus },
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
          <tab.icon size={24} />
        </A>
      ))}
    </nav>
  );
}
