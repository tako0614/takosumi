import { expect, test } from "bun:test";

import { scrollableTables } from "../../docs/.vitepress/scrollable-tables.ts";

function renderer(rules: Record<string, unknown> = {}) {
  return {
    rules: rules as never,
    renderToken: (tokens: unknown[], index: number) => String(tokens[index]),
  };
}

test("wraps each table in a scroll container", () => {
  const md = { renderer: renderer() };
  scrollableTables(md);
  const tokens = ["<table>", "</table>"];

  expect(md.renderer.rules.table_open!(tokens, 0, {}, {}, md.renderer)).toBe(
    '<div class="table-scroll"><table>',
  );
  expect(md.renderer.rules.table_close!(tokens, 1, {}, {}, md.renderer)).toBe(
    "</table></div>",
  );
});

test("keeps an existing table renderer inside the wrapper", () => {
  const md = {
    renderer: renderer({
      table_open: () => '<table class="custom">',
      table_close: () => "</table><!-- end -->",
    }),
  };
  scrollableTables(md);

  expect(md.renderer.rules.table_open!([], 0, {}, {}, md.renderer)).toBe(
    '<div class="table-scroll"><table class="custom">',
  );
  expect(md.renderer.rules.table_close!([], 0, {}, {}, md.renderer)).toBe(
    "</table><!-- end --></div>",
  );
});
