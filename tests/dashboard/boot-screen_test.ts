import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "../../dashboard");

test("dashboard shows an accessible boot status before capability discovery mounts the SPA", async () => {
  const html = await readFile(resolve(dashboardRoot, "index.html"), "utf8");
  const root = html.match(/<div id="root">([\s\S]*?)<\/div>/u)?.[1] ?? "";

  expect(root).toContain('id="dashboard-boot-loading"');
  expect(root).toContain('role="status"');
  expect(root).toContain('aria-live="polite"');
  expect(root).toContain("読み込み中…");
});

test("dashboard replaces the static boot fallback before mounting the SPA", async () => {
  const source = await readFile(
    resolve(dashboardRoot, "src/index.tsx"),
    "utf8",
  );

  expect(source).toContain("root.replaceChildren();");
});
