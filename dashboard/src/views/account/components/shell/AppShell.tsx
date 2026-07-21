import { createEffect, type JSX, on, Suspense } from "solid-js";
import { useIsRouting, useLocation } from "@solidjs/router";
import Sidebar from "./Sidebar.tsx";
import TopBar from "./TopBar.tsx";
import MobileTabs from "./MobileTabs.tsx";
import { ConfirmDialogRenderer } from "../../../../components/ConfirmDialogRenderer.tsx";
import { Spinner } from "../../../../components/ui/index.ts";
import { t } from "../../../../i18n/index.ts";
// Dashboard design system (tokens → base → components → shell → views). Imported once
// here so every screen wrapped in <AppShell> gets the styles even when the
// dashboard is consumed via the in-process takos-web alias.
import "../../../../styles/tokens.css";
import "../../../../styles/base.css";
import "../../../../styles/components.css";
import "../../../../styles/shell.css";
import "../../../../styles/views.css";

interface Props {
  children: JSX.Element;
}

/**
 * Dashboard chrome: a persistent left sidebar (primary nav: home / cloud
 * accounts / settings) + a top bar (add / notifications / profile menu) over the
 * content well, with mobile bottom tabs. The home screen stays an app launcher;
 * the sidebar restores the wayfinding the chromeless shell had removed.
 */
export default function AppShell(props: Props) {
  const location = useLocation();
  // True while a navigation is resolving — including the download of a lazy
  // route chunk (e.g. the heavy /new screen) and any route data. Without a
  // signal here, SolidRouter keeps the PREVIOUS page on screen during that load
  // while the URL and the path-derived header title already flip, so a slow
  // load looks frozen ("only the title changed to 追加, the store is still
  // there"). The progress bar + stale fade below make the transition visible.
  const isRouting = useIsRouting();
  let mainRef: HTMLElement | undefined;
  // On SPA navigation, move focus to the content well so keyboard/AT users
  // land on the new page instead of staying on the old nav control.
  //
  // Keyed on the page, NOT the raw pathname: detail screens put their tab strip
  // in the trailing segment (`/services/:id/:tab`), and throwing focus out of
  // the tab strip on every tab click made those strips unusable by keyboard.
  // It also waits for the routing transition to settle — `location.pathname`
  // flips as soon as the URL commits, which on a slow lazy route meant focusing
  // <main> while it still held the PREVIOUS page.
  const pageKey = () => {
    const segments = location.pathname.split("/").filter(Boolean);
    const isDetailTab =
      segments.length === 3 &&
      (segments[0] === "services" || segments[0] === "advanced");
    return isDetailTab ? segments.slice(0, 2).join("/") : location.pathname;
  };
  createEffect(
    on(
      () => [pageKey(), isRouting()] as const,
      ([, routing], previous) => {
        if (routing) return;
        if (previous && previous[0] === pageKey()) return;
        mainRef?.focus();
      },
      { defer: true },
    ),
  );
  return (
    <div class="app-shell">
      {/* The router intercepts same-origin anchors and only scrolls the hash
          target, so the browser's native "focus the fragment" never ran — the
          skip link moved the viewport but not focus, and the next Tab walked
          straight back into the sidebar. */}
      <a
        href="#main"
        class="skip-link"
        onClick={(event) => {
          event.preventDefault();
          mainRef?.focus();
          mainRef?.scrollIntoView();
        }}
      >
        {t("shell.skipToContent")}
      </a>
      <Sidebar />
      <div class="app-shell-main">
        <div
          class="route-progress"
          classList={{ active: isRouting() }}
          aria-hidden="true"
        />
        <TopBar />
        <main
          class="app-shell-content"
          classList={{ routing: isRouting() }}
          id="main"
          tabindex="-1"
          ref={mainRef}
        >
          {/* A Suspense boundary here is load-bearing: it turns route changes
              into real transitions. Without it, navigating to a not-yet-loaded
              lazy route (e.g. /new from the store) commits the URL immediately
              and blanks the content until the chunk arrives, so the header title
              flips to "追加" over a still-store body. With it, the current page
              stays intact until the next one is ready, then swaps atomically —
              and `useIsRouting()` above drives the progress bar meanwhile. The
              fallback only shows on a direct/first load with no page to keep. */}
          <Suspense
            fallback={
              <div class="route-loading" role="status">
                <Spinner size={22} />
              </div>
            }
          >
            {props.children}
          </Suspense>
        </main>
      </div>
      <MobileTabs />
      <ConfirmDialogRenderer />
    </div>
  );
}
