/**
 * Local consumer implementation of the open TCS v2 `{ git }` wire contract.
 * Takosumi must remain buildable without a sibling `takosumi-store` checkout.
 *
 * TCS v1 included a repository-relative `path` beside `git`. That field was
 * always presentation/discovery data, never install authority, and v2 removes
 * it from the public listing source altogether. The parser accepts the legacy
 * key only so a v1 response can be read during the migration; it deliberately
 * drops the value before the dashboard sees it.
 */
export interface TcsWireListingSource {
  readonly git: string;
}

const CONTROL = /\p{Cc}/u;

function canonicalTcsGitUrl(raw: string): string | undefined {
  if (CONTROL.test(raw)) return undefined;
  const value = raw.trim();
  if (
    !value ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    const pathname = parsed.pathname
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "");
    if (!pathname || pathname === "/") return undefined;
    parsed.pathname = pathname;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

export function parseTcsListingSource(
  input: unknown,
): TcsWireListingSource | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const source = input as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => key !== "git" && key !== "path") ||
    typeof source.git !== "string" ||
    ("path" in source && typeof source.path !== "string")
  ) {
    return undefined;
  }
  const git = canonicalTcsGitUrl(source.git);
  return git ? { git } : undefined;
}

export function tcsListingSourceIdentity(input: unknown): string | undefined {
  const source = parseTcsListingSource(input);
  return source?.git;
}
