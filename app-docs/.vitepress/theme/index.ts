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

const theme: Theme = {
  extends: DefaultTheme,
  enhanceApp() {
    installMobileNavigationA11y();
  },
};

export default theme;
