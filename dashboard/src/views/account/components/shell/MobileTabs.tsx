/**
 * Mobile bottom bar: the same everyday trio as the sidebar (home / store /
 * settings), from the shared nav model. Icons carry the meaning (labels are
 * dropped for a calmer bar; the accessible name stays on each link). Hosting
 * management is reached through 設定 > 管理.
 */
import { A, useLocation } from "@solidjs/router";
import { For } from "solid-js";
import { isNavActive, PRIMARY_NAV } from "./nav.ts";
import { t } from "../../../../i18n/index.ts";

export default function MobileTabs() {
  const loc = useLocation();
  return (
    <nav class="mobile-tabs" aria-label="Mobile primary">
      <For each={PRIMARY_NAV}>
        {(tab) => (
          <A
            href={tab.href}
            class="mobile-tab"
            classList={{ active: isNavActive(loc.pathname, tab) }}
            aria-label={t(tab.labelKey)}
          >
            <tab.icon size={24} />
          </A>
        )}
      </For>
    </nav>
  );
}
