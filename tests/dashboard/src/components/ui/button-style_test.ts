import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const componentsCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/components.css"),
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
});
