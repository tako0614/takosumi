import { expect, test } from "bun:test";

import {
  addTableRole,
  cellLabelHtml,
  cellText,
  type InlineChild,
  labelTableCells,
  type TableToken,
} from "../../docs/.vitepress/stacked-tables.ts";

type Token = TableToken & {
  attrs: Record<string, string>;
  children: InlineChild[] | null;
};

function token(type: string, children: InlineChild[] | null = null): Token {
  const attrs: Record<string, string> = {};
  return {
    type,
    content: children?.map((child) => child.content).join("") ?? "",
    children,
    attrs,
    attrSet(name, value) {
      attrs[name] = value;
    },
  };
}

function text(content: string): InlineChild[] {
  return content === "" ? [] : [{ type: "text", content }];
}

function table(headers: string[], rows: string[][]): Token[] {
  const tokens = [token("table_open"), token("thead_open"), token("tr_open")];
  for (const header of headers) {
    tokens.push(token("th_open"), token("inline", text(header)), token("th_close"));
  }
  tokens.push(token("tr_close"), token("thead_close"), token("tbody_open"));
  for (const row of rows) {
    tokens.push(token("tr_open"));
    for (const cell of row) {
      tokens.push(token("td_open"), token("inline", text(cell)), token("td_close"));
    }
    tokens.push(token("tr_close"));
  }
  tokens.push(token("tbody_close"), token("table_close"));
  return tokens;
}

const label = (html: string): InlineChild => ({ type: "html_inline", content: html });

function cellLabels(tokens: Token[]): (string | undefined)[] {
  return tokens
    .filter((t, i) => t.type === "td_open" && tokens[i + 1])
    .map((t) => {
      const first = tokens[tokens.indexOf(t) + 1].children?.[0];
      return first?.type === "html_inline" ? first.content : undefined;
    });
}

test("labels every body cell after the first in a table of three or more columns", () => {
  const tokens = table(["変数", "既定値", "説明"], [["A", "1", "first"], ["B", "2", "second"]]);
  labelTableCells(tokens, label);

  expect(cellLabels(tokens)).toEqual([
    undefined,
    cellLabelHtml("既定値"),
    cellLabelHtml("説明"),
    undefined,
    cellLabelHtml("既定値"),
    cellLabelHtml("説明"),
  ]);
  expect(cellLabelHtml("既定値")).toBe('<span class="cell-label" aria-hidden="true">既定値</span>');
});

test("leaves two-column tables unlabelled, since the first cell names the row", () => {
  const tokens = table(["症状", "確認するもの"], [["queued", "Run"]]);
  labelTableCells(tokens, label);

  expect(cellLabels(tokens)).toEqual([undefined, undefined]);
});

test("reads each table's own headers when a page has several", () => {
  const tokens = [
    ...table(["a", "b", "c"], [["1", "2", "3"]]),
    ...table(["x", "y"], [["7", "8"]]),
    ...table(["p", "", "r"], [["4", "5", "6"]]),
  ];
  labelTableCells(tokens, label);

  expect(cellLabels(tokens)).toEqual([
    undefined,
    cellLabelHtml("b"),
    cellLabelHtml("c"),
    undefined,
    undefined,
    undefined,
    undefined,
    cellLabelHtml("r"),
  ]);
});

test("keeps table semantics with explicit roles", () => {
  const tokens = table(["a", "b"], [["1", "2"]]);
  labelTableCells(tokens, label);

  const roles = Object.fromEntries(
    tokens.filter((t) => t.attrs.role).map((t) => [t.type, t.attrs.role]),
  );
  expect(roles).toEqual({
    thead_open: "rowgroup",
    tbody_open: "rowgroup",
    tr_open: "row",
    th_open: "columnheader",
    td_open: "cell",
  });
});

test("adds the table role to the tag VitePress renders, inside the scroll wrapper", () => {
  expect(addTableRole('<div class="table-scroll" tabindex="0"><table>\n')).toBe(
    '<div class="table-scroll" tabindex="0"><table role="table">\n',
  );
  expect(addTableRole('<table class="custom">')).toBe('<table role="table" class="custom">');
});

test("uses the plain text of a header written with inline Markdown, escaped", () => {
  expect(
    cellText(
      token("inline", [
        { type: "code_inline", content: "TAKOSUMI_ENVIRONMENT" },
        { type: "text", content: " の" },
        { type: "softbreak", content: "" },
        { type: "strong_open", content: "" },
        { type: "text", content: "値" },
        { type: "strong_close", content: "" },
      ]),
    ),
  ).toBe("TAKOSUMI_ENVIRONMENT の 値");
  expect(cellText(undefined)).toBe("");
  expect(cellLabelHtml('<a & "b">')).toBe(
    '<span class="cell-label" aria-hidden="true">&lt;a &amp; &quot;b&quot;&gt;</span>',
  );
});
