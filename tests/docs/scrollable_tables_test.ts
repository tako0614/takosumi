import { expect, test } from "bun:test";

import { scrollableTables } from "../../docs/.vitepress/scrollable-tables.ts";

type Rule = (...args: unknown[]) => string;

function markdown(rules: Record<string, Rule> = {}) {
  return {
    renderer: {
      rules,
      renderToken: (tokens: string[], index: number) => tokens[index],
    },
  };
}

function render(md: ReturnType<typeof markdown>, rule: string, tokens: string[], index: number) {
  return md.renderer.rules[rule]!(tokens, index, {}, {}, md.renderer);
}

test("wraps each table in one focusable scroll container", () => {
  const md = markdown();
  scrollableTables(md as never);

  expect(render(md, "table_open", ['<table tabindex="0">'], 0)).toBe(
    '<div class="table-scroll" tabindex="0"><table>',
  );
  expect(render(md, "table_close", ["</table>"], 0)).toBe("</table></div>");
});

test("keeps an existing table renderer inside the wrapper", () => {
  const md = markdown({
    table_open: () => '<table tabindex="0" class="custom">',
    table_close: () => "</table><!-- end -->",
  });
  scrollableTables(md as never);

  expect(render(md, "table_open", [], 0)).toBe(
    '<div class="table-scroll" tabindex="0"><table class="custom">',
  );
  expect(render(md, "table_close", [], 0)).toBe("</table><!-- end --></div>");
});
