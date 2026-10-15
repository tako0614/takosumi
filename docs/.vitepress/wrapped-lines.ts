// Japanese prose in these docs is hard-wrapped. Markdown turns each wrap into
// a space, and browsers keep that space between Japanese characters, so pages
// read "実行者を あとから". A wrap disappears when both neighbours are wide
// CJK characters, or when the line ends in Japanese punctuation: the docs
// write "接続です。Run、state" with no space after 。 and 、. Breaks next to
// Latin words stay spaces, which matches "Git に置いた".

const WIDE = /^[⺀-鿿豈-﫿＀-￯]$/u;
const WIDE_PUNCTUATION =
  /^[　-〿！-／：-＠［-｀｛-･]$/u;

export function joinsWithoutSpace(before: string, after: string): boolean {
  if (before === "" || after === "") return false;
  return (
    WIDE_PUNCTUATION.test(before) || (WIDE.test(before) && WIDE.test(after))
  );
}

/** Join hard-wrapped source lines the way the rendered page reads them. */
export function joinWrappedLines(lines: readonly string[]): string {
  let joined = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (joined === "") {
      joined = line;
    } else {
      joined += joinsWithoutSpace(joined.at(-1) ?? "", line[0]) ? "" : " ";
      joined += line;
    }
  }
  return joined;
}

const DESCRIPTION_LIMIT = 200;

function isBlockStart(text: string): boolean {
  return (
    text.startsWith("#") ||
    text.startsWith("<") ||
    text.startsWith("```") ||
    text.startsWith("---") ||
    text.startsWith(":::") ||
    text.startsWith("|")
  );
}

/**
 * The first prose paragraph of a Markdown page as plain text, for link
 * previews. Long paragraphs end at the last full sentence that fits.
 */
export function firstParagraphText(markdown: string): string | undefined {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");
  const lines = body.split("\n").map((line) => line.trim());
  const start = lines.findIndex((text) => text !== "" && !isBlockStart(text));
  if (start === -1) return undefined;
  let end = start;
  while (end < lines.length && lines[end] !== "" && !isBlockStart(lines[end])) {
    end += 1;
  }
  const plain = joinWrappedLines(
    lines
      .slice(start, end)
      .join("\n")
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/<[^>]+>/gu, "")
      .replace(/\{#[^}]+\}/gu, "")
      .replace(/[*_`~]/gu, "")
      .split("\n"),
  ).replace(/[ \t]+/gu, " ");
  if (plain === "") return undefined;
  if (plain.length <= DESCRIPTION_LIMIT) return plain;
  const window = plain.slice(0, DESCRIPTION_LIMIT);
  const sentenceEnd = Math.max(
    window.lastIndexOf("。") + 1,
    window.lastIndexOf(". ") + 1,
  );
  return sentenceEnd > 0
    ? window.slice(0, sentenceEnd)
    : `${window.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

type InlineToken = { type: string; content: string };

// Inline markup such as **bold** or [links](…) surrounds the wrapped text;
// look through its open/close tokens to the characters a reader sees.
function visibleCharacter(
  tokens: readonly InlineToken[],
  start: number,
  step: 1 | -1,
): string {
  for (let index = start; index >= 0 && index < tokens.length; index += step) {
    const token = tokens[index];
    if (token.type === "text" || token.type === "code_inline") {
      if (token.content === "") continue;
      return step === 1 ? token.content[0] : (token.content.at(-1) ?? "");
    }
    if (token.type.endsWith("_open") || token.type.endsWith("_close")) continue;
    return "";
  }
  return "";
}

/** Remove soft line breaks inside paragraphs where the reader expects none. */
export function removeWideSoftBreaks(tokens: InlineToken[]): void {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index].type !== "softbreak") continue;
    const before = visibleCharacter(tokens, index - 1, -1);
    const after = visibleCharacter(tokens, index + 1, 1);
    if (joinsWithoutSpace(before, after)) tokens.splice(index, 1);
  }
}

type MarkdownIt = {
  core: {
    ruler: {
      push(
        name: string,
        rule: (state: {
          tokens: { type: string; children: InlineToken[] | null }[];
        }) => void,
      ): void;
    };
  };
};

export function wrappedLines(md: MarkdownIt): void {
  md.core.ruler.push("join_wide_wrapped_lines", (state) => {
    for (const token of state.tokens) {
      if (token.type === "inline" && token.children) {
        removeWideSoftBreaks(token.children);
      }
    }
  });
}
