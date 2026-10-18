import { expect, test } from "@playwright/test";

test.describe("Takosumi docs mobile navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/docs/");
    await expect(page).toHaveURL(/\/docs\/$/u);
    await expect(page).toHaveTitle("Takosumi");
    await expect(page.locator("#app > .Layout")).toBeVisible();
    await expect(page.locator(".VPNav")).toBeVisible();
    await expect(page.locator("#VPContent main")).toBeVisible();
    expect(page.viewportSize()?.width).toBe(390);
  });

  test("does not expose the closed sidebar as keyboard stops", async ({
    page,
  }) => {
    const sidebar = page.locator(".VPSidebar");

    await expect(sidebar).toHaveCount(1);
    await expect(sidebar).not.toHaveClass(/\bopen\b/);
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");

    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press("Tab");
      await expect(page.locator(".VPSidebar :focus")).toHaveCount(0);
    }
  });

  test("returns focus to the sidebar trigger after Escape", async ({ page }) => {
    const sidebar = page.locator(".VPSidebar");
    const trigger = page.locator(".VPLocalNav .menu");

    await trigger.click();
    await expect(sidebar).toHaveClass(/\bopen\b/);
    await expect(sidebar).not.toHaveAttribute("inert");
    await expect(sidebar).not.toHaveAttribute("aria-hidden");

    await page.keyboard.press("Escape");
    await expect(sidebar).not.toHaveClass(/\bopen\b/);
    await expect(trigger).toBeFocused();
  });

  test("closes the expanded top navigation on Escape", async ({ page }) => {
    const trigger = page.locator(".VPNavBarHamburger");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".VPNavScreen")).toBeVisible();

    await page.locator(".VPNavScreen a, .VPNavScreen button").first().focus();
    await page.keyboard.press("Escape");

    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".VPNavScreen")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe("Takosumi docs page width", () => {
  test("lays wide reference tables out as labelled rows that fit the phone", async ({ page }) => {
    await page.goto("/docs/reference/configuration");
    await expect(page.locator(".vp-doc .table-scroll > table").first()).toBeVisible();

    const layout = await page.evaluate(() => {
      const firstRow = document.querySelector(".vp-doc .table-scroll tbody > tr");
      const label = document.querySelector(".vp-doc td > .cell-label");
      const overflows = (element: Element) => element.scrollWidth > element.clientWidth;
      return {
        pageWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        scrollingTables: [
          ...document.querySelectorAll(".vp-doc .table-scroll"),
          ...document.querySelectorAll(".vp-doc .table-scroll > table"),
        ].filter(overflows).length,
        rowDisplay: firstRow ? getComputedStyle(firstRow).display : "",
        labelDisplay: label ? getComputedStyle(label).display : "",
        labelHidden: label?.getAttribute("aria-hidden"),
        tableRole: document.querySelector(".vp-doc .table-scroll > table")?.getAttribute("role"),
      };
    });

    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.scrollingTables).toBe(0);
    expect(layout.rowDisplay).toBe("block");
    expect(layout.labelDisplay).toBe("block");
    expect(layout.labelHidden).toBe("true");
    expect(layout.tableRole).toBe("table");
    // Stacked tables do not scroll, so they are not keyboard stops.
    await expect(page.locator(".vp-doc .table-scroll[tabindex]")).toHaveCount(0);
  });
});

test.describe("Takosumi docs heading links", () => {
  test("reaches a heading whose id has a voiced kana", async ({ page }) => {
    await page.goto("/docs/self-host/bun-postgres#ローカルで安全に起動して確認する");
    await expect(page.locator("#VPContent main")).toBeVisible();

    // :target is the browser's own match of the URL fragment to an element id.
    await expect(page.locator("h2:target")).toContainText("ローカルで安全に起動して確認する");
  });
});

test.describe("Takosumi docs at desktop width", () => {
  test("stacks exactly the tables that do not fit, through a resize", async ({ page }) => {
    // For every wrapper: would its table fit as a table, and is it stacked?
    const measure = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".vp-doc .table-scroll")].map((wrapper) => {
          const stacked = wrapper.classList.contains("is-stacked");
          wrapper.classList.remove("is-stacked");
          const fits = wrapper.scrollWidth <= wrapper.clientWidth + 1;
          wrapper.classList.toggle("is-stacked", stacked);
          return { fits, stacked, overflows: wrapper.scrollWidth > wrapper.clientWidth + 1 };
        }),
      );

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/docs/reference/configuration");
    await expect(page.locator(".vp-doc .table-scroll.is-stacked").first()).toBeVisible();
    const wide = await measure();

    expect(wide.some((table) => table.stacked)).toBe(true);
    expect(wide.some((table) => !table.stacked)).toBe(true);
    for (const table of wide) {
      expect(table.stacked).toBe(!table.fits);
      expect(table.overflows).toBe(false);
    }

    await page.setViewportSize({ width: 700, height: 900 });
    await expect.poll(async () => (await measure()).every((t) => t.stacked === !t.fits)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => JSON.stringify(await measure())).toBe(JSON.stringify(wide));
  });

  test("keeps outline labels and plain-text lines on screen", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/docs/reference/configuration");
    await expect(page.locator(".VPDocAsideOutline .outline-link").first()).toBeVisible();
    const truncatedOutline = await page.evaluate(
      () =>
        [...document.querySelectorAll(".VPDocAsideOutline .outline-link")].filter(
          (link) => link.scrollWidth > link.clientWidth + 1,
        ).length,
    );
    expect(truncatedOutline).toBe(0);

    // The overview's numbered steps are a plain-text block: on a phone they
    // wrap, and no line runs under the copy button.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/docs/concepts/");
    const block = page.locator(".vp-doc div.language-text").first();
    await expect(block).toBeVisible();
    const layout = await block.evaluate((element) => {
      const pre = element.querySelector("pre")!;
      const code = element.querySelector("code")!;
      const button = element.querySelector("button.copy")!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(code);
      const right = Math.max(...[...range.getClientRects()].map((rect) => rect.right));
      return { scrolls: pre.scrollWidth > pre.clientWidth + 1, clearOfCopy: right <= button.left };
    });
    expect(layout.scrolls).toBe(false);
    expect(layout.clearOfCopy).toBe(true);
  });
});

test.describe("Takosumi docs for keyboard and screen-reader users", () => {
  test("names the page chrome in Japanese and keeps sidebar headers honest", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/docs/getting-started/quickstart");
    await expect(page.locator(".VPSkipLink")).toHaveText("本文へ移動");
    await expect(page.locator("#sidebar-aria-label")).toHaveText("サイドバー");

    const sidebar = await page.evaluate(() => {
      const headers = [...document.querySelectorAll(".VPSidebarItem > .item")];
      return {
        asideHeadings: [...document.querySelectorAll("aside :is(h1, h2, h3, h4, h5, h6)")].filter(
          (heading) => heading.getAttribute("role") !== "none",
        ).length,
        buttons: headers
          .filter((header) => header.getAttribute("role") === "button")
          .map((header) => ({
            collapsible: header.parentElement?.classList.contains("collapsible") ?? false,
            expanded: header.getAttribute("aria-expanded"),
          })),
        stopsWithoutButton: headers.filter(
          (header) => header.hasAttribute("tabindex") && header.getAttribute("role") !== "button",
        ).length,
      };
    });

    expect(sidebar.asideHeadings).toBe(0);
    expect(sidebar.stopsWithoutButton).toBe(0);
    expect(sidebar.buttons.length).toBeGreaterThan(0);
    for (const button of sidebar.buttons) {
      expect(button.collapsible).toBe(true);
      expect(button.expanded).toMatch(/^(true|false)$/u);
    }

    const toggle = page.locator(".VPSidebarItem.collapsible > .item[role=button]").first();
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`#${controls}`)).toHaveCount(1);
    await expect(toggle.locator(":scope > .caret[tabindex]")).toHaveCount(0);

    const before = await toggle.getAttribute("aria-expanded");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).not.toHaveAttribute("aria-expanded", before ?? "");
    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", before ?? "");
  });

  test("restores the English names after switching from Japanese", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/docs/getting-started/quickstart");
    await expect(page.locator("#sidebar-aria-label")).toHaveText("サイドバー");

    // Follow an in-app link to the English page, as the language menu does.
    await page.evaluate(() => {
      const link = [...document.querySelectorAll<HTMLAnchorElement>("a")].find((a) =>
        /\/docs\/en\/getting-started\/quickstart/u.test(a.getAttribute("href") ?? ""),
      );
      link?.click();
    });
    await expect(page.locator("html")).toHaveAttribute("lang", /^en/u);
    await expect(page.locator("#sidebar-aria-label")).toHaveText("Sidebar Navigation");
    await expect(page.locator(".VPNavBarHamburger")).toHaveAttribute("aria-label", "mobile navigation");
  });
});
