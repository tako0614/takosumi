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

// The build makes every table wrapper a keyboard stop so a wide table can be
// scrolled (scrollable-tables.ts). A wrapper that does not scroll, such as a
// narrow table or any table stacked on a phone (style.css), would be a stop
// with nothing to do, so keep the stop only while the wrapper overflows.
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
    const sync = (): void => {
      pending = false;
      for (const wrapper of document.querySelectorAll<HTMLElement>(
        ".vp-doc .table-scroll",
      )) {
        if (wrapper.scrollWidth > wrapper.clientWidth) {
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
