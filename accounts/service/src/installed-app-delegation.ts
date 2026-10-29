import {
  installConfigSourceCoordinateMatches,
  type InstallConfigSourceSelector,
} from "takosumi-contract/install-configs";
import type { Source } from "takosumi-contract/sources";

/**
 * Operator configuration naming the repositories whose installed app may use
 * its own Accounts OAuth token as a Workspace delegation (for example Takos
 * installing apps for its user). Every other installed app's token is confined
 * to its own app. The decision is server-side: the app's recorded Source
 * coordinate is compared with this list; no client claim is consulted.
 */
export const INSTALLED_APP_DELEGATION_SOURCES_ENV =
  "TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES" as const;

export type InstalledAppDelegationSource = InstallConfigSourceSelector;

const MAX_DELEGATION_SOURCES = 32;

function invalid(): TypeError {
  return new TypeError(
    `${INSTALLED_APP_DELEGATION_SOURCES_ENV} must be a JSON array of at most ${MAX_DELEGATION_SOURCES} ` +
      `{ "url": "https://…", "path": "." } repository coordinates`,
  );
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
    const keys = Object.keys(entry);
    const { url, path } = entry as Record<string, unknown>;
    if (keys.some((key) => key !== "url" && key !== "path") || typeof url !== "string" || typeof path !== "string") {
      throw invalid();
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      throw invalid();
    }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) throw invalid();
    const selector = Object.freeze({ url: url.trim(), path: path.trim() });
    // The comparison itself rejects absolute and traversing paths.
    if (!installConfigSourceCoordinateMatches(selector, selector)) throw invalid();
    return selector;
  }));
}

/** True when the app's own Source is one of the operator-designated repositories. */
export function installedAppSourceDelegates(
  sources: readonly InstalledAppDelegationSource[],
  source: Pick<Source, "url" | "defaultPath">,
): boolean {
  return sources.some((selector) =>
    installConfigSourceCoordinateMatches(selector, { url: source.url, path: source.defaultPath || "." })
  );
}
