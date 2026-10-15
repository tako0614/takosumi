// Wide tables (long config keys, identifiers) must scroll inside the content
// column instead of widening the whole page. VitePress makes the <table>
// itself the scroller, which also stops narrow tables from filling the
// column; wrapping each Markdown table lets the wrapper scroll and the table
// stay full width. Tables written as raw HTML are not wrapped.
//
// VitePress gives each table tabindex="0" so keyboard users can scroll it.
// The tab stop moves to the wrapper, which is what scrolls now: a focused
// table inside it would have its focus ring clipped, and Firefox would stop
// on both.
import type { MarkdownRenderer } from "vitepress";

export function scrollableTables(md: MarkdownRenderer): void {
  const { rules } = md.renderer;
  const open = rules.table_open;
  const close = rules.table_close;
  rules.table_open = (tokens, index, options, env, self) => {
    const table = open
      ? open(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
    return `<div class="table-scroll" tabindex="0">${table.replace(' tabindex="0"', "")}`;
  };
  rules.table_close = (tokens, index, options, env, self) => {
    const table = close
      ? close(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
    return `${table}</div>`;
  };
}
