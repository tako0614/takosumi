/**
 * Mobile bottom bar — mirrors the sidebar's five destinations plus the
 * notifications feed (the desktop reaches it via the TopBar bell; on phones a
 * tab keeps it one tap away). Expert surfaces are inside Installation detail / Space
 * settings, so nothing is nav-chrome-only on desktop.
 */
import { A, useLocation } from "@solidjs/router";
import { Bell, Home, Plus, Settings2, UserCircle2 } from "lucide-solid";
import { t } from "../../../../i18n/index.ts";

export default function MobileTabs() {
  const loc = useLocation();
  const TABS = [
    { href: "/", label: () => t("nav.home"), icon: Home, end: true },
    { href: "/new", label: () => t("nav.add"), icon: Plus },
    {
      href: "/notifications",
      label: () => t("nav.notifications"),
      mobileLabel: () => t("nav.notificationsShort"),
      icon: Bell,
    },
    {
      href: "/workspace/settings",
      label: () => t("nav.spaceSettings"),
      mobileLabel: () => t("nav.spaceSettingsShort"),
      icon: Settings2,
    },
    { href: "/account", label: () => t("nav.account"), icon: UserCircle2 },
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
          <span>{("mobileLabel" in tab ? tab.mobileLabel : tab.label)()}</span>
        </A>
      ))}
    </nav>
  );
}
