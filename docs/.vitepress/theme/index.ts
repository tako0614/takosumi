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
// Code blocks follow the same rule. Without JavaScript every wrapper keeps its
// stop, and below 640px tables are stacked by CSS alone.
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
    const overflows = (element: Element): boolean =>
      element.scrollWidth > element.clientWidth + 1;
    const sync = (): void => {
      pending = false;
      const wrappers = [
        ...document.querySelectorAll<HTMLElement>(".vp-doc .table-scroll"),
      ];
      // Measure every table as a table, then stack the ones that do not fit.
      // Reads and writes are batched so the page lays out once per pass.
      for (const wrapper of wrappers) wrapper.classList.remove("is-stacked");
      const tooWide = wrappers.map(overflows);
      wrappers.forEach((wrapper, index) => {
        wrapper.classList.toggle("is-stacked", tooWide[index]);
      });
      const stillScrolls = wrappers.map(overflows);
      wrappers.forEach((wrapper, index) => {
        if (stillScrolls[index]) wrapper.setAttribute("tabindex", "0");
        else wrapper.removeAttribute("tabindex");
      });
      // Code blocks get a stop from the highlighter; the same rule applies.
      const blocks = [
        ...document.querySelectorAll<HTMLElement>(
          ".vp-doc div[class*='language-'] > pre",
        ),
      ];
      const blockScrolls = blocks.map(overflows);
      blocks.forEach((block, index) => {
        if (blockScrolls[index]) block.setAttribute("tabindex", "0");
        else block.removeAttribute("tabindex");
      });
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

// VitePress hard-codes some accessible names in English, and gives every
// sidebar group header a button role, a tab stop, and a heading, even when the
// group cannot collapse. Japanese pages get Japanese names; switching language
// without a reload keeps the same elements, so each name is written for the
// current page's language, with VitePress's own English otherwise. Group
// headers that cannot collapse lose the button role and tab stop, collapsible
// ones announce whether they are open, and group titles stop being headings so
// the page h1 is the first heading a screen reader finds.
const CHROME_NAMES: readonly [
  selector: string,
  attribute: string | null,
  japanese: string,
  english: string,
][] = [
  ["#sidebar-aria-label", null, "サイドバー", "Sidebar Navigation"],
  ["#main-nav-aria-label", null, "メインナビゲーション", "Main Navigation"],
  ["#doc-footer-aria-label", null, "前後のページ", "Pager"],
  [".VPNavBarHamburger", "aria-label", "サイトのメニュー", "mobile navigation"],
  [".vp-doc button.copy", "title", "コードをコピー", "Copy Code"],
];

function installAccessibleChrome(): void {
  if (typeof window === "undefined") return;

  const install = (): void => {
    if (!document.body) {
      window.requestAnimationFrame(install);
      return;
    }

    const root = document.documentElement;
    if (root.dataset.takosumiAccessibleChrome === "installed") return;
    root.dataset.takosumiAccessibleChrome = "installed";

    let pending = false;
    let groupCount = 0;
    // Every write is skipped when the value is already right, so the
    // mutations this makes settle after one pass. On English pages the names
    // written are VitePress's own defaults, which restores them after a
    // Japanese page without changing a page that never left English.
    const sync = (): void => {
      pending = false;
      const japanese = root.lang.startsWith("ja");
      for (const [selector, attribute, ja, en] of CHROME_NAMES) {
        const text = japanese ? ja : en;
        for (const element of document.querySelectorAll(selector)) {
          if (attribute === null) {
            if (element.textContent !== text) element.textContent = text;
          } else if (element.getAttribute(attribute) !== text) {
            element.setAttribute(attribute, text);
          }
        }
      }
      for (const header of document.querySelectorAll<HTMLElement>(
        ".VPSidebarItem > .item",
      )) {
        const title = header.querySelector(":scope > .text, :scope > .link > .text");
        if (title && /^H[2-6]$/.test(title.tagName) && title.getAttribute("role") !== "none") {
          title.setAttribute("role", "none");
        }
        const group = header.parentElement;
        const list = group?.querySelector<HTMLElement>(":scope > .items");
        if (
          group?.classList.contains("collapsible") &&
          header.getAttribute("role") === "button" &&
          list
        ) {
          const expanded = String(!group.classList.contains("collapsed"));
          if (header.getAttribute("aria-expanded") !== expanded) {
            header.setAttribute("aria-expanded", expanded);
          }
          if (!list.id) list.id = `takosumi-sidebar-group-${++groupCount}`;
          if (header.getAttribute("aria-controls") !== list.id) {
            header.setAttribute("aria-controls", list.id);
          }
          // The header is the button; its caret would be a second stop that
          // does the same thing, named in English ("toggle section").
          const caret = header.querySelector<HTMLElement>(":scope > .caret");
          if (caret) {
            if (caret.hasAttribute("role")) caret.removeAttribute("role");
            if (caret.hasAttribute("tabindex")) caret.removeAttribute("tabindex");
            if (caret.getAttribute("aria-hidden") !== "true") {
              caret.setAttribute("aria-hidden", "true");
            }
          }
          // VitePress toggles on Enter only; a button also toggles on Space.
          if (header.dataset.takosumiSpaceToggle !== "on") {
            header.dataset.takosumiSpaceToggle = "on";
            header.addEventListener("keydown", (event) => {
              if (event.key !== " ") return;
              event.preventDefault();
              header.click();
            });
          }
        } else {
          // Any other header does nothing on Enter; a page link or the
          // VitePress caret inside it stays the tab stop.
          if (header.hasAttribute("role")) header.removeAttribute("role");
          if (header.hasAttribute("tabindex")) header.removeAttribute("tabindex");
        }
      }
    };
    const schedule = (): void => {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(sync);
    };

    new MutationObserver(schedule).observe(root, {
      attributes: true,
      attributeFilter: ["class", "lang"],
      childList: true,
      subtree: true,
    });
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
    installAccessibleChrome();
  },
};

export default theme;
