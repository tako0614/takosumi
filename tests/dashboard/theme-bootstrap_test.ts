import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "../../dashboard");

test("dashboard bootstraps the theme from a same-origin CSP-compatible asset", async () => {
  const [html, themeBootstrap] = await Promise.all([
    readFile(resolve(dashboardRoot, "index.html"), "utf8"),
    readFile(resolve(dashboardRoot, "public/assets/theme-init.js"), "utf8"),
  ]);

  expect(html).toContain('<script src="/assets/theme-init.js"></script>');
  expect(html).not.toMatch(/<script>\s*\(\(\) =>/u);
  expect(themeBootstrap).toContain('localStorage.getItem("tg_theme")');
  expect(themeBootstrap).toContain("document.documentElement.dataset.theme");
});
