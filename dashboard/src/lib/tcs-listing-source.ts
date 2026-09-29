/**
 * Local consumer implementation of the open TCS v2 `{ git, path? }` wire
 * contract. Takosumi must remain buildable without a sibling `takosumi-store`
 * checkout.
 *
 * `path` names the module a listing is about: the piece of install-relevant
 * context only the catalog knows, because a repository may expose several
 * modules (for example a Cloudflare stack at the root and a managed deployment
 * under `deploy/takoform`). It stays a discovery hint and never install
 * authority — the add flow proves the path against the immutable
 * SourceSnapshot scan before it becomes a module. TCS keeps the root module
 * implicit, so a listing that only announces a repository is still valid.
 */
import { isCanonicalRepositoryDirectoryPath } from "takosumi-contract";

export interface TcsWireListingSource {
  readonly git: string;
  readonly path?: string;
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
  if (!git) return undefined;
  if (!("path" in source)) return { git };
  const path = (source.path as string).trim();
  // A stale or non-canonical hint must never cost the listing its repository:
  // the module choice just stays with the installer's own scan.
  if (path === "." || !isCanonicalRepositoryDirectoryPath(path)) return { git };
  return { git, path };
}

export function tcsListingSourceIdentity(input: unknown): string | undefined {
  const source = parseTcsListingSource(input);
  return source?.git;
}
