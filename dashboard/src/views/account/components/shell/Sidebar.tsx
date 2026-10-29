/**
 * Primary navigation: a persistent left rail with home, store, connections and account.
 */
import { A, useLocation } from "@solidjs/router";
import { ArrowLeft } from "lucide-solid";
import { For, Show } from "solid-js";
import Wordmark from "../brand/Wordmark.tsx";
import { isNavActive, PRIMARY_NAV } from "./nav.ts";
import { t } from "../../../../i18n/index.ts";
import {
  dashboardProductName,
  isTakosEmbeddedRuntime,
} from "../../../../lib/runtime-capabilities.ts";

export default function Sidebar() {
  const loc = useLocation();
  const takosEmbedded = () => isTakosEmbeddedRuntime();

  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <Wordmark
          href={takosEmbedded() ? undefined : "/"}
          size={22}
          productName={dashboardProductName()}
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
      <nav class="sidebar-nav" aria-label={t("nav.primary")}>
        <For each={PRIMARY_NAV}>
          {(item) => (
            <A
              href={item.href}
              class="sidebar-link"
              classList={{ active: isNavActive(loc.pathname, item) }}
              aria-current={
                isNavActive(loc.pathname, item) ? "page" : undefined
              }
            >
              <item.icon size={18} />
              <span class="sidebar-link-label">{t(item.labelKey)}</span>
            </A>
          )}
        </For>
      </nav>
    </aside>
  );
}
