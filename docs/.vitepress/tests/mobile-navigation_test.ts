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
    await page.goto("/docs/concepts/self-host#ローカルで安全に起動して確認する");
    await expect(page.locator("#VPContent main")).toBeVisible();

    // :target is the browser's own match of the URL fragment to an element id.
    await expect(page.locator("h3:target")).toContainText("ローカルで安全に起動して確認する");
  });
});

test.describe("Takosumi docs at desktop width", () => {
  test("stacks only the tables that do not fit, and never truncates the outline", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/docs/reference/configuration");
    await expect(page.locator(".vp-doc .table-scroll.is-stacked").first()).toBeVisible();

    const layout = await page.evaluate(() => {
      const overflows = (element: Element | null) =>
        element !== null && element.scrollWidth > element.clientWidth + 1;
      const wrappers = [...document.querySelectorAll(".vp-doc .table-scroll")];
      return {
        overflowing: wrappers.filter((w) => overflows(w) || overflows(w.querySelector(":scope > table"))).length,
        stacked: wrappers.filter((w) => w.classList.contains("is-stacked")).length,
        tables: wrappers.length,
        truncatedOutline: [...document.querySelectorAll(".VPDocAsideOutline .outline-link")]
          .filter(overflows).length,
      };
    });

    expect(layout.overflowing).toBe(0);
    expect(layout.stacked).toBeGreaterThan(0);
    expect(layout.stacked).toBeLessThan(layout.tables);
    expect(layout.truncatedOutline).toBe(0);
  });
});
