/**
 * Mobile bottom bar keeps only everyday destinations. Technical hosting
 * management remains available from account/settings surfaces instead of
 * taking over the first screen on small devices.
 */
import { A, useLocation } from "@solidjs/router";
import { Cloud, LayoutGrid, Plus, Store, UserCircle2 } from "lucide-solid";
import { For } from "solid-js";
import { t } from "../../../../i18n/index.ts";
import { isTakosumiCloudRuntime } from "../../../../lib/deployment-brand.ts";

export default function MobileTabs() {
  const loc = useLocation();
  const tabs = () => [
    { href: "/", label: () => t("nav.apps"), icon: LayoutGrid, end: true },
    { href: "/new", label: () => t("nav.add"), icon: Plus },
    { href: "/store", label: () => t("nav.store"), icon: Store },
    ...(isTakosumiCloudRuntime()
      ? [{ href: "/cloud", label: () => t("nav.cloudResources"), icon: Cloud }]
      : []),
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
            <tab.icon size={24} />
          </A>
        )}
      </For>
    </nav>
  );
}
