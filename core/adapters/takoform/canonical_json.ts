export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
const MAX_JSON_DEPTH = 128;

/**
 * Parses UTF-8 I-JSON without the duplicate-name and negative-zero ambiguity
 * of `JSON.parse`. The resulting value can be fed directly to the RFC 8785
 * serializer below.
 */
export function parseCanonicalJson(bytes: Uint8Array): CanonicalJsonValue {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError("JSON is not valid UTF-8", { cause: error });
  }
  return new StrictJsonParser(text).parse();
}

/** RFC 8785 / JCS serialization over an already validated I-JSON value. */
export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function canonicalJson(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(
        "RFC 8785 numbers must be finite and not negative zero",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertNoUnpairedSurrogate(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, CanonicalJsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${canonicalJson(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

class StrictJsonParser {
  #index = 0;
  #depth = 0;

  constructor(private readonly text: string) {}

  parse(): CanonicalJsonValue {
    this.#skipWhitespace();
    const value = this.#parseValue();
    this.#skipWhitespace();
    if (this.#index !== this.text.length) {
      throw new TypeError(`unexpected JSON token at offset ${this.#index}`);
    }
    return value;
  }

  #parseValue(): CanonicalJsonValue {
    const current = this.text[this.#index];
    if (current === "{") return this.#parseObject();
    if (current === "[") return this.#parseArray();
    if (current === '"') return this.#parseString();
    if (this.text.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    return this.#parseNumber();
  }

  #parseObject(): CanonicalJsonValue {
    this.#enterContainer();
    this.#index++;
    this.#skipWhitespace();
    const result: Record<string, CanonicalJsonValue> = {};
    const keys = new Set<string>();
    if (this.#consume("}")) {
      this.#leaveContainer();
      return result;
    }
    for (;;) {
      if (this.text[this.#index] !== '"') {
        throw new TypeError(`expected object name at offset ${this.#index}`);
      }
      const key = this.#parseString();
      if (keys.has(key)) {
        throw new TypeError(
          `duplicate JSON object name ${JSON.stringify(key)}`,
        );
      }
      keys.add(key);
      this.#skipWhitespace();
      if (!this.#consume(":")) {
        throw new TypeError(`expected ':' at offset ${this.#index}`);
      }
      this.#skipWhitespace();
      result[key] = this.#parseValue();
      this.#skipWhitespace();
      if (this.#consume("}")) break;
      if (!this.#consume(",")) {
        throw new TypeError(`expected ',' or '}' at offset ${this.#index}`);
      }
      this.#skipWhitespace();
    }
    this.#leaveContainer();
    return result;
  }

  #parseArray(): CanonicalJsonValue {
    this.#enterContainer();
    this.#index++;
    this.#skipWhitespace();
    const result: CanonicalJsonValue[] = [];
    if (this.#consume("]")) {
      this.#leaveContainer();
      return result;
    }
    for (;;) {
      result.push(this.#parseValue());
      this.#skipWhitespace();
      if (this.#consume("]")) break;
      if (!this.#consume(",")) {
        throw new TypeError(`expected ',' or ']' at offset ${this.#index}`);
      }
      this.#skipWhitespace();
    }
    this.#leaveContainer();
    return result;
  }

  #parseString(): string {
    const start = this.#index;
    this.#index++;
    let escaped = false;
    while (this.#index < this.text.length) {
      const code = this.text.charCodeAt(this.#index);
      if (!escaped && code === 0x22) {
        this.#index++;
        const value = JSON.parse(this.text.slice(start, this.#index)) as string;
        assertNoUnpairedSurrogate(value);
        return value;
      }
      if (!escaped && code < 0x20) {
        throw new TypeError(
          `unescaped control character at offset ${this.#index}`,
        );
      }
      if (escaped) {
        if (!'"\\/bfnrtu'.includes(this.text[this.#index])) {
          throw new TypeError(`invalid JSON escape at offset ${this.#index}`);
        }
        if (this.text[this.#index] === "u") {
          const digits = this.text.slice(this.#index + 1, this.#index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) {
            throw new TypeError(
              `invalid Unicode escape at offset ${this.#index}`,
            );
          }
          this.#index += 4;
        }
        escaped = false;
      } else if (code === 0x5c) {
        escaped = true;
      }
      this.#index++;
    }
    throw new TypeError("unterminated JSON string");
  }

  #parseNumber(): number {
    NUMBER_RE.lastIndex = this.#index;
    const match = NUMBER_RE.exec(this.text);
    if (!match || match.index !== this.#index) {
      throw new TypeError(`expected JSON value at offset ${this.#index}`);
    }
    this.#index = NUMBER_RE.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("JSON number is non-finite or negative zero");
    }
    return value;
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.text[this.#index] ?? "")) {
      const current = this.text[this.#index];
      if (
        current !== " " &&
        current !== "\n" &&
        current !== "\r" &&
        current !== "\t"
      ) {
        throw new TypeError(`invalid JSON whitespace at offset ${this.#index}`);
      }
      this.#index++;
    }
  }

  #consume(value: string): boolean {
    if (this.text[this.#index] !== value) return false;
    this.#index++;
    return true;
  }

  #enterContainer(): void {
    if (this.#depth >= MAX_JSON_DEPTH) {
      throw new TypeError(`JSON nesting exceeds ${MAX_JSON_DEPTH} containers`);
    }
    this.#depth++;
  }

  #leaveContainer(): void {
    this.#depth--;
  }
}

function assertNoUnpairedSurrogate(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new TypeError("JSON string contains an unpaired high surrogate");
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("JSON string contains an unpaired low surrogate");
    }
  }
}
