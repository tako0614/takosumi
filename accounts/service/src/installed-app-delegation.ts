import {
  installConfigSourceCoordinateMatches,
  normalizeInstallConfigSourcePath,
  type InstallConfigSourceSelector,
} from "takosumi-contract/install-configs";

/**
 * Operator configuration naming the repositories (and the exact Git refs)
 * whose installed app may use its own Accounts OAuth token as a Workspace
 * delegation, for example Takos installing apps for its user. Every other
 * installed app's token is confined to its own app. The decision is
 * server-side: the app's recorded Source URL and its currently adopted
 * (applied) revision's path and the full ref name the runner resolved for it
 * (`resolvedRef`) are compared with this list; no client claim is consulted.
 */
export const INSTALLED_APP_DELEGATION_SOURCES_ENV =
  "TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES" as const;

export interface InstalledAppDelegationSource extends InstallConfigSourceSelector {
  /**
   * Fully qualified `refs/heads/…` or `refs/tags/…` names; a trailing `*`
   * makes a prefix (`refs/tags/v*`). Required and non-empty.
   */
  readonly refs: readonly string[];
}

const MAX_DELEGATION_SOURCES = 32;
const MAX_DELEGATION_REFS = 32;
const REF_PATTERN = /^refs\/(?:heads|tags)\/[A-Za-z0-9._\/-]+\*?$/u;

function invalid(): TypeError {
  return new TypeError(
    `${INSTALLED_APP_DELEGATION_SOURCES_ENV} must be a JSON array of at most ${MAX_DELEGATION_SOURCES} ` +
      `{ "url": "https://…", "path": ".", "refs": ["refs/heads/main", "refs/tags/v*"] } entries`,
  );
}

function validRef(ref: string): boolean {
  return REF_PATTERN.test(ref) && !ref.includes("..") && !ref.includes("//") &&
    !ref.endsWith("/") && !ref.slice(0, -1).includes("*") && ref.length <= 256;
}

/** Empty or unset means no installed app may delegate. Malformed fails startup. */
export function parseInstalledAppDelegationSources(
  value?: string,
): readonly InstalledAppDelegationSource[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_DELEGATION_SOURCES) throw invalid();
  return Object.freeze(parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid();
    const { url, path, refs } = entry as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "url" && key !== "path" && key !== "refs") ||
      typeof url !== "string" || typeof path !== "string" || !Array.isArray(refs) ||
      refs.length === 0 || refs.length > MAX_DELEGATION_REFS ||
      refs.some((ref) => typeof ref !== "string" || !validRef(ref.trim()))) {
      throw invalid();
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      throw invalid();
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) throw invalid();
    const selector = Object.freeze({
      url: url.trim(),
      path: path.trim(),
      refs: Object.freeze([...new Set((refs as string[]).map((ref) => ref.trim()))]),
    });
    // The comparison itself rejects absolute and traversing paths.
    if (!installConfigSourceCoordinateMatches(selector, selector)) throw invalid();
    return selector;
  }));
}

/**
 * Only the FULL ref name the runner resolved counts: a requested bare name can
 * match other refs by suffix (`1/head` → `refs/pull/1/head`), so it is never
 * expanded here. Anything outside `refs/heads/` and `refs/tags/` (pull request
 * refs, raw commits, an unresolved `HEAD`) never qualifies.
 */
function refMatches(allowed: string, resolvedRef: string): boolean {
  if (!resolvedRef.startsWith("refs/heads/") && !resolvedRef.startsWith("refs/tags/")) return false;
  return allowed.endsWith("*")
    ? resolvedRef.startsWith(allowed.slice(0, -1)) && resolvedRef.length > allowed.length - 1
    : resolvedRef === allowed;
}

/** True when the app's Source coordinate is one of the designated repositories (ref not considered). */
export function installedAppSourceIsDesignated(
  sources: readonly InstalledAppDelegationSource[],
  coordinate: { readonly url: string; readonly path: string },
): boolean {
  return sources.some((selector) => installConfigSourceCoordinateMatches(selector, {
    url: coordinate.url, path: normalizeInstallConfigSourcePath(coordinate.path || "."),
  }));
}

/**
 * True when the deployed revision (URL, path and the snapshot's resolved full
 * ref) is a designated delegate revision. A snapshot without `resolvedRef`
 * (raw commit, or fetched before it was recorded) never delegates.
 */
export function installedAppRevisionDelegates(
  sources: readonly InstalledAppDelegationSource[],
  revision: { readonly url: string; readonly path: string; readonly resolvedRef: string | undefined },
): boolean {
  const ref = revision.resolvedRef;
  if (ref === undefined || ref !== ref.trim() || !ref) return false;
  return sources.some((selector) =>
    installConfigSourceCoordinateMatches(selector, {
      url: revision.url, path: normalizeInstallConfigSourcePath(revision.path || "."),
    }) && selector.refs.some((allowed) => refMatches(allowed, ref))
  );
}
