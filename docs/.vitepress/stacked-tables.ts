// On a phone, a sideways scroll hid the descriptions of most reference
// tables. Below 640px the theme lays each table row out as a block instead
// (see theme/style.css). This plugin adds what that layout needs from the
// markup:
//
// - In a table with three or more columns, each body cell after the first
//   starts with its column name in a span that only the stacked layout
//   shows. The span is aria-hidden: assistive technology already announces
//   the column header. In a two-column table the first cell names the row,
//   so the second needs no label.
// - Explicit ARIA table roles, because browsers drop table semantics from
//   elements whose display is changed. VitePress renders <table> from a fixed
//   string that ignores token attributes, so the table's own role is added to
//   that rendered tag.
//
// The types below are the small part of markdown-it this rule touches, so the
// unit test can drive it with plain objects.

export type InlineChild = { type: string; content: string };

export type TableToken = {
  type: string;
  content: string;
  children: InlineChild[] | null;
  attrSet(name: string, value: string): void;
};

const ROLES: Readonly<Record<string, string>> = {
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

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The label the stacked layout shows above a cell's value. */
export function cellLabelHtml(text: string): string {
  return `<span class="cell-label" aria-hidden="true">${escapeHtml(text)}</span>`;
}

/** Add table roles, and column labels to the cells of wide tables. */
export function labelTableCells(
  tokens: readonly TableToken[],
  label: (html: string) => InlineChild,
): void {
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
        const text = headers[column];
        const inline = tokens[index + 1];
        if (headers.length >= 3 && column > 0 && text && inline?.children) {
          inline.children.unshift(label(cellLabelHtml(text)));
        }
        column += 1;
        break;
      }
    }
  });
}

type RenderRule = (
  tokens: unknown,
  index: number,
  options: unknown,
  env: unknown,
  self: { renderToken(tokens: unknown, index: number, options: unknown): string },
) => string;

type MarkdownIt = {
  renderer: { rules: Record<string, RenderRule | undefined> };
  core: {
    ruler: {
      push(
        name: string,
        rule: (state: {
          tokens: TableToken[];
          Token: new (type: string, tag: string, nesting: number) => InlineChild;
        }) => void,
      ): void;
    };
  };
};

/** Give the rendered <table> tag its role, whatever renders the tag. */
export function addTableRole(html: string): string {
  return html.replace(/<table(?=[\s>])/, '<table role="table"');
}

export function stackedTables(md: MarkdownIt): void {
  const { rules } = md.renderer;
  const open = rules.table_open;
  rules.table_open = (tokens, index, options, env, self) =>
    addTableRole(
      open
        ? open(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options),
    );
  md.core.ruler.push("label_table_cells", (state) => {
    labelTableCells(state.tokens, (html) => {
      const token = new state.Token("html_inline", "", 0);
      token.content = html;
      return token;
    });
  });
}
