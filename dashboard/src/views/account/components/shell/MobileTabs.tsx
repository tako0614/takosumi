/**
 * Mobile bottom bar for the normal hosted-service flow. Keep it to the core
 * consumer destinations; advanced workspace settings are reachable from account
 * / advanced routes instead of occupying a primary phone tab.
 */
import { A, useLocation } from "@solidjs/router";
import { Bell, Home, Plus, UserCircle2 } from "lucide-solid";
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
