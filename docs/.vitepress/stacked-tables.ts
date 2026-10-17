// On a phone, a sideways scroll hid the descriptions of most reference
// tables. Below 640px the theme lays each table row out as a block instead
// (see theme/style.css). This plugin adds what that layout needs from the
// markup:
//
// - In a table with three or more columns, each body cell after the first
//   carries its column name in data-label, which the stacked layout prints
//   above the value. In a two-column table the first cell already names the
//   row, so the second needs no label.
// - Explicit ARIA table roles, because browsers drop table semantics from
//   elements whose display is changed.

type InlineChild = { type: string; content: string };

export type TableToken = {
  type: string;
  content: string;
  children: InlineChild[] | null;
  attrSet(name: string, value: string): void;
};

const ROLES: Readonly<Record<string, string>> = {
  table_open: "table",
  thead_open: "rowgroup",
  tbody_open: "rowgroup",
  tr_open: "row",
  th_open: "columnheader",
  td_open: "cell",
};

/** Plain text of a header cell, without its inline Markdown. */
export function cellText(inline: TableToken | undefined): string {
  if (!inline) return "";
  if (!inline.children) return inline.content.trim();
  return inline.children
    .map((child) => {
      if (child.type === "text" || child.type === "code_inline") {
        return child.content;
      }
      return child.type === "softbreak" ? " " : "";
    })
    .join("")
    .trim();
}

/** Add table roles, and column labels to the cells of wide tables. */
export function labelTableCells(tokens: readonly TableToken[]): void {
  let headers: string[] = [];
  let inHead = false;
  let column = 0;
  tokens.forEach((token, index) => {
    const role = ROLES[token.type];
    if (role) token.attrSet("role", role);
    switch (token.type) {
      case "table_open":
        headers = [];
        break;
      case "thead_open":
        inHead = true;
        break;
      case "thead_close":
        inHead = false;
        break;
      case "tr_open":
        column = 0;
        break;
      case "th_open":
        if (inHead) headers.push(cellText(tokens[index + 1]));
        break;
      case "td_open": {
        const label = headers[column];
        if (headers.length >= 3 && column > 0 && label) {
          token.attrSet("data-label", label);
        }
        column += 1;
        break;
      }
    }
  });
}

type MarkdownIt = {
  core: {
    ruler: {
      push(
        name: string,
        rule: (state: { tokens: TableToken[] }) => void,
      ): void;
    };
  };
};

export function stackedTables(md: MarkdownIt): void {
  md.core.ruler.push("label_table_cells", (state) => {
    labelTableCells(state.tokens);
  });
}
