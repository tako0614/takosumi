/**
 * Local consumer implementation of the open TCS `{ git, path }` wire
 * contract. Takosumi must remain buildable without a sibling
 * `takosumi-store` checkout.
 */
export interface TcsWireListingSource {
  readonly git: string;
  readonly path: string;
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

function canonicalTcsModulePath(raw: string): string | undefined {
  if (CONTROL.test(raw)) return undefined;
  let value = raw.trim();
  if (!value || value === ".") return ".";
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return undefined;
  }

  value = value.replace(/\/+$/u, "");
  while (value.startsWith("./")) value = value.slice(2);
  if (!value || value === ".") return ".";

  const canonical: string[] = [];
  for (const rawSegment of value.split("/")) {
    if (!rawSegment) return undefined;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment).normalize("NFC");
    } catch {
      return undefined;
    }
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      CONTROL.test(segment)
    ) {
      return undefined;
    }
    canonical.push(segment);
  }
  return canonical.join("/");
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
    typeof source.path !== "string"
  ) {
    return undefined;
  }
  const git = canonicalTcsGitUrl(source.git);
  const path = canonicalTcsModulePath(source.path);
  return git && path ? { git, path } : undefined;
}

export function tcsListingSourceIdentity(input: unknown): string | undefined {
  const source = parseTcsListingSource(input);
  return source ? `${source.git}#${source.path}` : undefined;
}
