/**
 * Tiny recursive-descent XML parser for the limited tag-set produced by AWS
 * Query API responses (RDS / EC2 / etc.).
 *
 * Scope kept intentionally narrow:
 *  - element nodes with text or nested element children
 *  - whitespace between elements is ignored
 *  - XML declaration (`<?xml ... ?>`) is skipped
 *  - comments (`<!-- ... -->`) are skipped
 *  - CDATA sections are inlined as text
 *  - self-closing tags are supported
 *  - the basic XML entities (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`) are decoded
 *
 * NOT supported (deliberately): namespaces, DTDs, processing instructions
 * other than the XML declaration, attribute parsing for content extraction
 * (attributes are parsed but discarded — AWS Query API responses use element
 * content, not attributes, for data).
 *
 * The output shape is intentionally Object-with-array-children so callers can
 * walk it with simple path-based helpers (`findFirstChild`, `findText`).
 */
export interface XmlNode {
  readonly name: string;
  /** Direct child element nodes (text-only is captured in `text`). */
  readonly children: readonly XmlNode[];
  /** Concatenated text content of the element (CDATA + text children). */
  readonly text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(`xml parse: ${message}`);
    this.name = "XmlParseError";
  }
}

interface MutableXmlNode {
  name: string;
  children: MutableXmlNode[];
  text: string;
}

/**
 * Parse an XML document into a {@link XmlNode} tree. Throws
 * {@link XmlParseError} on malformed input.
 */
export function parseXml(input: string): XmlNode {
  const parser = new Parser(input);
  parser.skipProlog();
  const root = parser.readElement();
  parser.skipWhitespace();
  // Trailing content after the root element is ignored (AWS sometimes appends
  // whitespace / a trailing newline).
  return freeze(root);
}

/**
 * Walk a node's descendants depth-first looking for the first descendant
 * whose name matches `path` (a `.`-separated chain of element names, relative
 * to `root`). Returns `undefined` when not found.
 *
 * Examples:
 *   findFirstNode(root, "DBInstance.Endpoint.Address")
 *   findFirstNode(root, "Endpoint")  // first Endpoint anywhere under root
 */
export function findFirstNode(
  root: XmlNode,
  path: string,
): XmlNode | undefined {
  const segments = path.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) return undefined;
  return walkPath([root], segments);
}

/**
 * Convenience wrapper for {@link findFirstNode} that returns the trimmed text
 * content (or `undefined` when the element is missing). Returns the
 * concatenated text content (no descendants), so callers should use this for
 * leaf elements only.
 */
export function findFirstText(
  root: XmlNode,
  path: string,
): string | undefined {
  const node = findFirstNode(root, path);
  if (!node) return undefined;
  // Prefer direct text content; if the element has no direct text but has a
  // single child (the common AWS "wrapper" case) fall through to whatever
  // raw text the parser captured.
  return node.text.trim().length > 0 ? node.text.trim() : undefined;
}

function walkPath(
  start: readonly XmlNode[],
  segments: readonly string[],
): XmlNode | undefined {
  // `segments[0]` is the next name to find. Search recursively in start[*].
  const [head, ...rest] = segments;
  for (const node of start) {
    const found = findDescendantByName(node, head);
    if (!found) continue;
    if (rest.length === 0) return found;
    const next = walkPath(found.children, rest);
    if (next) return next;
  }
  return undefined;
}

function findDescendantByName(
  node: XmlNode,
  name: string,
): XmlNode | undefined {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findDescendantByName(child, name);
    if (found) return found;
  }
  return undefined;
}

class Parser {
  readonly #input: string;
  #pos = 0;

  constructor(input: string) {
    this.#input = input;
  }

  skipProlog(): void {
    this.skipWhitespace();
    if (this.#peek("<?xml")) {
      const end = this.#input.indexOf("?>", this.#pos);
      if (end < 0) throw new XmlParseError("unterminated XML declaration");
      this.#pos = end + 2;
    }
    this.skipWhitespaceAndComments();
  }

  skipWhitespace(): void {
    while (this.#pos < this.#input.length) {
      const ch = this.#input.charCodeAt(this.#pos);
      // 9=tab 10=LF 13=CR 32=space
      if (ch === 9 || ch === 10 || ch === 13 || ch === 32) {
        this.#pos += 1;
        continue;
      }
      break;
    }
  }

  skipWhitespaceAndComments(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.#peek("<!--")) {
        const end = this.#input.indexOf("-->", this.#pos);
        if (end < 0) throw new XmlParseError("unterminated comment");
        this.#pos = end + 3;
        continue;
      }
      break;
    }
  }

  readElement(): MutableXmlNode {
    this.skipWhitespaceAndComments();
    if (this.#input[this.#pos] !== "<") {
      throw new XmlParseError(`expected '<' at offset ${this.#pos}`);
    }
    this.#pos += 1;

    const nameStart = this.#pos;
    while (
      this.#pos < this.#input.length &&
      !this.#isTagBoundary(this.#input[this.#pos])
    ) {
      this.#pos += 1;
    }
    const name = this.#input.slice(nameStart, this.#pos);
    if (!name) throw new XmlParseError("missing element name");

    // Skip attributes — we don't surface them to callers, but we still need to
    // walk past them to find the closing `>` or `/>`.
    while (this.#pos < this.#input.length) {
      this.skipWhitespace();
      if (this.#input[this.#pos] === "/") {
        if (this.#input[this.#pos + 1] !== ">") {
          throw new XmlParseError(
            `expected '/>' for self-closing element ${name}`,
          );
        }
        this.#pos += 2;
        return { name, children: [], text: "" };
      }
      if (this.#input[this.#pos] === ">") {
        this.#pos += 1;
        break;
      }
      // attr-name
      while (
        this.#pos < this.#input.length &&
        this.#input[this.#pos] !== "=" &&
        this.#input[this.#pos] !== "/" &&
        this.#input[this.#pos] !== ">" &&
        !this.#isWhitespace(this.#input[this.#pos])
      ) {
        this.#pos += 1;
      }
      this.skipWhitespace();
      if (this.#input[this.#pos] === "=") {
        this.#pos += 1;
        this.skipWhitespace();
        const quote = this.#input[this.#pos];
        if (quote !== '"' && quote !== "'") {
          throw new XmlParseError(
            `expected quoted attribute value in element ${name}`,
          );
        }
        this.#pos += 1;
        const valEnd = this.#input.indexOf(quote, this.#pos);
        if (valEnd < 0) {
          throw new XmlParseError(
            `unterminated attribute value in element ${name}`,
          );
        }
        this.#pos = valEnd + 1;
      }
    }

    const node: MutableXmlNode = { name, children: [], text: "" };
    let textBuffer = "";

    while (this.#pos < this.#input.length) {
      if (this.#peek("</")) {
        this.#pos += 2;
        const closeStart = this.#pos;
        while (
          this.#pos < this.#input.length &&
          this.#input[this.#pos] !== ">"
        ) this.#pos += 1;
        const closeName = this.#input.slice(closeStart, this.#pos).trim();
        if (closeName !== name) {
          throw new XmlParseError(
            `expected </${name}> but got </${closeName}>`,
          );
        }
        this.#pos += 1;
        node.text = textBuffer.trim();
        return node;
      }
      if (this.#peek("<!--")) {
        const end = this.#input.indexOf("-->", this.#pos);
        if (end < 0) throw new XmlParseError("unterminated comment");
        this.#pos = end + 3;
        continue;
      }
      if (this.#peek("<![CDATA[")) {
        const end = this.#input.indexOf("]]>", this.#pos);
        if (end < 0) throw new XmlParseError("unterminated CDATA");
        textBuffer += this.#input.slice(this.#pos + 9, end);
        this.#pos = end + 3;
        continue;
      }
      if (this.#input[this.#pos] === "<") {
        const child = this.readElement();
        node.children.push(child);
        continue;
      }
      const next = this.#input.indexOf("<", this.#pos);
      const sliceEnd = next < 0 ? this.#input.length : next;
      textBuffer += decodeEntities(this.#input.slice(this.#pos, sliceEnd));
      this.#pos = sliceEnd;
    }
    throw new XmlParseError(`unterminated element ${name}`);
  }

  #peek(literal: string): boolean {
    return this.#input.startsWith(literal, this.#pos);
  }

  #isWhitespace(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }

  #isTagBoundary(ch: string): boolean {
    return this.#isWhitespace(ch) || ch === ">" || ch === "/";
  }
}

function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(
    /&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g,
    (_, body) => {
      switch (body) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          if (body.startsWith("#x") || body.startsWith("#X")) {
            const code = parseInt(body.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : "";
          }
          if (body.startsWith("#")) {
            const code = parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : "";
          }
          return "";
      }
    },
  );
}

function freeze(node: MutableXmlNode): XmlNode {
  return {
    name: node.name,
    text: node.text,
    children: node.children.map(freeze),
  };
}
