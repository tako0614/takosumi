// Japanese prose in these docs is hard-wrapped. Markdown turns each wrap into
// a space, and browsers keep that space between Japanese characters, so pages
// read "実行者を あとから". A wrap disappears when both neighbours are wide
// CJK characters, or when Japanese punctuation sits on either side: the docs
// write "接続です。Run、state" and "tuple（binding" with no space. Other
// breaks next to Latin words stay spaces, which matches "Git に置いた".

const WIDE = /^[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]$/u;
// CJK symbols and punctuation without the ideographic letters 々〆〇, plus
// the katakana middle dot and full-width ASCII punctuation.
const WIDE_PUNCTUATION =
  /^[\u3000-\u3004\u3008-\u303f\u30fb\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]$/u;

export function joinsWithoutSpace(before: string, after: string): boolean {
  if (before === "" || after === "") return false;
  return (
    WIDE_PUNCTUATION.test(before) ||
    WIDE_PUNCTUATION.test(after) ||
    (WIDE.test(before) && WIDE.test(after))
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
const QUOTE = /^>\s?/u;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/u;
// Only bullets and "1." can interrupt a paragraph; "2. " is wrapped prose.
const LIST_INTERRUPT = /^(?:[-*+]|1[.)])\s+/u;
const FENCE = /^(`{3,}|~{3,})/u;
const ALERT = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/u;
// Prefer a complete short sentence to a long one cut mid-way.
const SHORTEST_SENTENCE = 40;
// A full stop ends a sentence before a capitalised word, so "e.g. the" and
// "?git=..." stay inside theirs.
const SENTENCE_END = /[。！？]|(?<!\.)[.!?](?=\s+[A-Z]|$)/gu;

function isOtherBlock(text: string): boolean {
  return (
    text.startsWith("#") ||
    text.startsWith("<") ||
    FENCE.test(text) ||
    text.startsWith("---") ||
    text.startsWith(":::") ||
    text.startsWith("|")
  );
}

// The lines of the first paragraph, list item or blockquote that is prose,
// with their Markdown block markers removed.
function firstProseLines(lines: readonly string[]): string[] {
  let start = 0;
  for (; start < lines.length; start += 1) {
    const text = lines[start];
    const fence = FENCE.exec(text)?.[1];
    if (fence) {
      start += 1;
      while (start < lines.length && !lines[start].startsWith(fence)) start += 1;
    } else if (text !== "" && !isOtherBlock(text)) {
      break;
    }
  }
  if (start >= lines.length) return [];

  const quoted = QUOTE.test(lines[start]);
  const prose = [lines[start].replace(quoted ? QUOTE : LIST_ITEM, "").replace(ALERT, "")];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (quoted && !QUOTE.test(lines[index])) break;
    const text = quoted ? lines[index].replace(QUOTE, "") : lines[index];
    if (text === "" || isOtherBlock(text) || LIST_INTERRUPT.test(text)) break;
    if (!quoted && QUOTE.test(text)) break;
    prose.push(text);
  }
  return prose;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<\/?[A-Za-z][^>\n]*>/gu, "")
    .replace(/\{#[^}]+\}/gu, "")
    .replace(/[*`~]/gu, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "");
}

/**
 * The first prose paragraph of a Markdown page as plain text, for link
 * previews. Long paragraphs end at the last full sentence that fits.
 */
export function firstParagraphText(markdown: string): string | undefined {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");
  const prose = firstProseLines(body.split("\n").map((line) => line.trim()));
  const plain = joinWrappedLines(
    plainText(prose.join("\n")).split("\n"),
  ).replace(/[ \t]+/gu, " ");
  if (plain === "") return undefined;
  if (plain.length <= DESCRIPTION_LIMIT) return plain;
  let cut = 0;
  for (const match of plain.matchAll(SENTENCE_END)) {
    const end = match.index + 1;
    if (end > DESCRIPTION_LIMIT) break;
    cut = end;
  }
  if (cut >= SHORTEST_SENTENCE) return plain.slice(0, cut);
  // No usable sentence end: cut English at a word boundary, Japanese anywhere.
  const head = plain.slice(0, DESCRIPTION_LIMIT - 1);
  const space = head.lastIndexOf(" ");
  const midWord = /[A-Za-z0-9]/u.test(plain[DESCRIPTION_LIMIT - 1]);
  return `${(midWord && space > DESCRIPTION_LIMIT / 2 ? head.slice(0, space) : head).trimEnd()}…`;
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
