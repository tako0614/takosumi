/**
 * Mobile bottom bar: the same destinations as the sidebar (home / store /
 * account), from the shared nav model, each with its icon and a
 * short label so the destination reads in words.
 */
import { A, useLocation } from "@solidjs/router";
import { For } from "solid-js";
import { isNavActive, PRIMARY_NAV } from "./nav.ts";
import { t } from "../../../../i18n/index.ts";

export default function MobileTabs() {
  const loc = useLocation();
  return (
    <nav class="mobile-tabs" aria-label={t("nav.primary")}>
      <For each={PRIMARY_NAV}>
        {(tab) => (
          <A
            href={tab.href}
            class="mobile-tab"
            classList={{ active: isNavActive(loc.pathname, tab) }}
            aria-current={isNavActive(loc.pathname, tab) ? "page" : undefined}
          >
            <tab.icon size={22} aria-hidden="true" />
            <span class="mobile-tab-label">{t(tab.labelKey)}</span>
          </A>
        )}
      </For>
    </nav>
  );
}
