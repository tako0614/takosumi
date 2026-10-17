import { expect, test } from "bun:test";

import {
  cellText,
  labelTableCells,
  type TableToken,
} from "../../docs/.vitepress/stacked-tables.ts";

function token(
  type: string,
  children: { type: string; content: string }[] | null = null,
): TableToken & { attrs: Record<string, string> } {
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

function table(headers: string[], rows: string[][]) {
  const tokens = [token("table_open"), token("thead_open"), token("tr_open")];
  for (const header of headers) {
    tokens.push(token("th_open"), token("inline", [{ type: "text", content: header }]), token("th_close"));
  }
  tokens.push(token("tr_close"), token("thead_close"), token("tbody_open"));
  for (const row of rows) {
    tokens.push(token("tr_open"));
    for (const cell of row) {
      tokens.push(token("td_open"), token("inline", [{ type: "text", content: cell }]), token("td_close"));
    }
    tokens.push(token("tr_close"));
  }
  tokens.push(token("tbody_close"), token("table_close"));
  return tokens;
}

test("labels every body cell after the first in a table of three or more columns", () => {
  const tokens = table(["変数", "既定値", "説明"], [["A", "1", "first"], ["B", "2", "second"]]);
  labelTableCells(tokens);

  const labels = tokens.filter((t) => t.type === "td_open").map((t) => t.attrs["data-label"]);
  expect(labels).toEqual([undefined, "既定値", "説明", undefined, "既定値", "説明"]);
});

test("leaves two-column tables unlabelled, since the first cell names the row", () => {
  const tokens = table(["症状", "確認するもの"], [["queued", "Run"]]);
  labelTableCells(tokens);

  expect(tokens.some((t) => "data-label" in t.attrs)).toBe(false);
});

test("keeps table semantics with explicit roles", () => {
  const tokens = table(["a", "b"], [["1", "2"]]);
  labelTableCells(tokens);

  const roles = Object.fromEntries(
    tokens.filter((t) => t.attrs.role).map((t) => [t.type, t.attrs.role]),
  );
  expect(roles).toEqual({
    table_open: "table",
    thead_open: "rowgroup",
    tbody_open: "rowgroup",
    tr_open: "row",
    th_open: "columnheader",
    td_open: "cell",
  });
});

test("uses the plain text of a header written with inline Markdown", () => {
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
});
