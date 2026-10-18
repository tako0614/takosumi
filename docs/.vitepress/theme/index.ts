import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/jetbrains-mono";

import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";

import "./style.css";

const mobileViewport = "(max-width: 959px)";

function installMobileNavigationA11y(): void {
  if (typeof window === "undefined") return;

  const install = (): void => {
    if (!document.body) {
      window.requestAnimationFrame(install);
      return;
    }

    const root = document.documentElement;
    if (root.dataset.takosumiMobileNavigationA11y === "installed") return;
    root.dataset.takosumiMobileNavigationA11y = "installed";

    const mediaQuery = window.matchMedia(mobileViewport);

    const syncSidebarA11y = (): void => {
      const sidebar = document.querySelector<HTMLElement>(".VPSidebar");
      if (!sidebar) return;

      const hidden = mediaQuery.matches && !sidebar.classList.contains("open");
      sidebar.toggleAttribute("inert", hidden);
      if (hidden) sidebar.setAttribute("aria-hidden", "true");
      else sidebar.removeAttribute("aria-hidden");
    };

    const closeNavScreenOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;

      const screen = document.querySelector<HTMLElement>(".VPNavScreen");
      const trigger = document.querySelector<HTMLButtonElement>(
        ".VPNavBarHamburger",
      );
      if (
        !screen ||
        !trigger ||
        trigger.getAttribute("aria-expanded") !== "true"
      ) {
        return;
      }

      event.preventDefault();
      trigger.click();
      trigger.focus();
    };

    const observer = new MutationObserver(syncSidebarA11y);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });

    mediaQuery.addEventListener("change", syncSidebarA11y);
    window.addEventListener("keydown", closeNavScreenOnEscape);
    syncSidebarA11y();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
}

// A table that does not fit its column is stacked into rows (style.css), so no
// column hides off the edge at any width. The build also makes every table
// wrapper a keyboard stop so a wide table can be scrolled
// (scrollable-tables.ts); a wrapper that no longer scrolls would be a stop with
// nothing to do, so the stop stays only while the wrapper still overflows.
// Without JavaScript every wrapper keeps its stop, and below 640px tables are
// stacked by CSS alone.
function installTableScrollStops(): void {
  if (typeof window === "undefined") return;

  const install = (): void => {
    if (!document.body) {
      window.requestAnimationFrame(install);
      return;
    }

    const root = document.documentElement;
    if (root.dataset.takosumiTableScrollStops === "installed") return;
    root.dataset.takosumiTableScrollStops = "installed";

    let pending = false;
    const overflows = (element: Element | null): boolean =>
      element !== null && element.scrollWidth > element.clientWidth + 1;
    const sync = (): void => {
      pending = false;
      for (const wrapper of document.querySelectorAll<HTMLElement>(
        ".vp-doc .table-scroll",
      )) {
        const table = wrapper.querySelector(":scope > table");
        // Measure the table as a table, then stack it only if it does not fit.
        wrapper.classList.remove("is-stacked");
        if (overflows(wrapper) || overflows(table)) {
          wrapper.classList.add("is-stacked");
        }
        if (overflows(wrapper)) {
          wrapper.setAttribute("tabindex", "0");
        } else {
          wrapper.removeAttribute("tabindex");
        }
      }
    };
    const schedule = (): void => {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(sync);
    };

    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    schedule();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
}

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp() {
    installMobileNavigationA11y();
    installTableScrollStops();
  },
};

export default theme;
