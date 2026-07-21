import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const componentsCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/components.css"),
  "utf8",
);
const buttonSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/components/ui/Button.tsx"),
  "utf8",
);

describe("dashboard button styles", () => {
  test("keeps primary link buttons on the accent foreground color", () => {
    expect(componentsCssSource).toContain(".tg-btn-primary");
    expect(componentsCssSource).toContain(".tg-btn-primary:visited");
    expect(componentsCssSource).toContain(".tg-btn-primary:focus-visible");
    expect(componentsCssSource).toContain("color: var(--tg-accent-fg);");
    expect(componentsCssSource).toContain(
      "-webkit-text-fill-color: var(--tg-accent-fg);",
    );
  });

  // Link-buttons render caller-supplied URLs (the app-handoff return_uri comes
  // from a query parameter), so the anchor must never carry a `javascript:`
  // href. There is no DOM harness for dashboard components, so the guard is
  // pinned at the source that produces the href.
  test("drops a script-capable href instead of rendering it", () => {
    expect(buttonSource).toContain(
      'import { isSafeLinkHref } from "takosumi-contract";',
    );
    expect(buttonSource).toContain("!isSafeLinkHref(local.href)");
  });
});
