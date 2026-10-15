// Wide tables (long config keys, identifiers) must scroll inside the content
// column instead of widening the whole page. VitePress makes the <table>
// itself the scroller, which also stops narrow tables from filling the
// column; wrapping each table lets the wrapper scroll and the table stay
// full width.

type RenderRule = (
  tokens: unknown[],
  index: number,
  options: unknown,
  env: unknown,
  self: Renderer,
) => string;

type Renderer = {
  rules: Record<string, RenderRule | undefined>;
  renderToken(tokens: unknown[], index: number, options: unknown): string;
};

export function scrollableTables(md: { renderer: Renderer }): void {
  const open = md.renderer.rules.table_open;
  const close = md.renderer.rules.table_close;
  md.renderer.rules.table_open = (tokens, index, options, env, self) =>
    `<div class="table-scroll">${
      open
        ? open(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options)
    }`;
  md.renderer.rules.table_close = (tokens, index, options, env, self) =>
    `${
      close
        ? close(tokens, index, options, env, self)
        : self.renderToken(tokens, index, options)
    }</div>`;
}
