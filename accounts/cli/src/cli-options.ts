/**
 * Parse `--flag` / `--key value` / `--key=value` options.
 *
 * This is a deliberately small hand-rolled parser. Because it cannot know
 * which flags expect a value, a bare `--key` whose following token also
 * starts with `--` is treated as a boolean `true` (so `--dry-run --json`
 * sets both booleans). The consequence is that a value that itself begins
 * with `--` (e.g. `--reason "--foo"` passed space-separated) would be
 * mis-parsed as a boolean flag and the value lost.
 *
 * To pass a value that looks like a flag, use the inline `--key=value`
 * form, which is the canonical form for flag-like values and is parsed
 * verbatim regardless of its content:
 *
 *   `--reason=--keep-going`   →  reason = "--keep-going"
 *
 * `--` acts as an end-of-options sentinel: every token after it is ignored
 * by this flag parser (callers that need positional arguments slice them
 * off the argv before calling `parseOptions`).
 */
export function parseOptions(
  args: string[],
): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    // End-of-options sentinel: stop interpreting tokens as flags so a
    // value that looks like a flag can never be silently swallowed.
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(
      /-([a-z])/g,
      (_, letter: string) => letter.toUpperCase(),
    );
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    // A following `--` token is the end-of-options sentinel, not a value.
    if (next === undefined || next === "--" || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

export function stringOption(
  options: Record<string, string | boolean>,
  key: string,
  fallback: string,
): string {
  const value = options[key];
  return typeof value === "string" ? value : fallback;
}

export function optionalStringOption(
  options: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function booleanOption(
  options: Record<string, string | boolean>,
  key: string,
): boolean {
  return options[key] === true;
}

export function optionalIntegerOption(
  options: Record<string, string | boolean>,
  key: string,
): number | undefined {
  const value = options[key];
  if (value === undefined || value === false) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const flagName = key.replace(
      /[A-Z]/g,
      (letter) => `-${letter.toLowerCase()}`,
    );
    throw new TypeError(`--${flagName} must be a positive integer`);
  }
  return parsed;
}

export function optionalNonNegativeIntegerOption(
  options: Record<string, string | boolean>,
  key: string,
): number | undefined {
  const value = options[key];
  if (value === undefined || value === false) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    const flagName = key.replace(
      /[A-Z]/g,
      (letter) => `-${letter.toLowerCase()}`,
    );
    throw new TypeError(`--${flagName} must be a non-negative integer`);
  }
  return parsed;
}

export function optionalNonNegativeIntegerStrictOption(
  options: Record<string, string | boolean>,
  key: string,
): number | undefined {
  const value = options[key];
  if (value === undefined || value === false) return undefined;
  if (value === true) {
    throw new TypeError(`--${kebabCase(key)} requires a value`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`--${kebabCase(key)} must be a non-negative integer`);
  }
  return parsed;
}

export function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Parse a positive-integer option with a fallback default.
 *
 * Throws `TypeError` on an invalid value, matching every sibling option
 * helper (`optionalIntegerOption`, `optionalNonNegativeIntegerStrictOption`,
 * `validatePostgresUrl`, …). Callers catch the error and surface
 * `error.message` like the other helpers, so the contract is uniform and
 * there is no error-as-value string a caller could mistake for a port.
 */
export function integerOption(
  options: Record<string, string | boolean>,
  key: string,
  fallback: number,
): number {
  const value = options[key];
  if (value === undefined || value === false) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`--${kebabCase(key)} must be a positive integer`);
  }
  return parsed;
}

export function commaSeparatedOption(
  options: Record<string, string | boolean>,
  key: string,
): readonly string[] {
  const value = optionalStringOption(options, key);
  if (!value) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function installationIdempotencyKey(
  options: Record<string, string | boolean>,
): string {
  return optionalStringOption(options, "idempotencyKey") ?? crypto.randomUUID();
}

export async function optionalEnvString(
  key: string,
): Promise<string | undefined> {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

export function validatePostgresUrl(value: string, label: string): string {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a postgres:// or postgresql:// URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new TypeError(`${label} must be a postgres:// or postgresql:// URL`);
  }
  return value;
}

export function validateHttpUrl(value: string, label: string): string {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an http:// or https:// URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${label} must be an http:// or https:// URL`);
  }
  return value;
}
import process from "node:process";
