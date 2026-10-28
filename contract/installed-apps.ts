/** Value-free Store matching summaries; no Output or Interface inputs. */
import type { CapsuleAppState } from "./capsules.ts";
import {
  installConfigSourceCoordinateMatches,
  type InstallConfigSourceSelector,
  type InstallConfigStoreText,
} from "./install-configs.ts";

export interface InstalledAppSummary {
  readonly capsuleId: string;
  readonly name: string;
  readonly displayName?: InstallConfigStoreText;
  readonly iconUrl?: string;
  readonly state: CapsuleAppState;
  /** Repository and executable module coordinate. A ref is never identity. */
  readonly installedFrom: InstallConfigSourceSelector & {
    /** Display URL omitted identity-bearing content; do not use it for matching. */
    readonly matchable?: false;
  };
}

export interface ListInstalledAppsResponse {
  readonly installedApps: readonly InstalledAppSummary[];
  /** False when bounded discovery could not establish every installed identity. */
  readonly complete: boolean;
}

/**
 * Value-free display URL. Query content is not public-safe; callers must
 * mark a summary unmatchable when removing it loses executable identity.
 * scp keeps its relative-path spelling separate from ssh:// absolute paths.
 */
export function installedAppSourceUrl(value: string): string {
  return sourceUrl(value, false);
}

/** Whether the display URL retains enough identity for exact Store matching. */
export function installedAppSourceIsMatchable(value: string): boolean {
  const identity = sourceUrl(value, true);
  return identity !== "" && identity === installedAppSourceUrl(value);
}

/** Comparison removes userinfo and fragment, retaining executable URL queries. */
function sourceUrl(value: string, preserveQuery: boolean): string {
  const trimmed = value.trim();
  if (/[\\\r\n\0]/u.test(trimmed)) return "";
  if (!trimmed.includes("://")) {
    // Accept both source spelling (git@host:path) and its already-projected
    // host:path spelling so normalization is idempotent.
    const scp = /^(?:[^@/:]+@)?([^@/:?#\s]+):([^?#]+)(\?[^#]*)?(?:#.*)?$/u.exec(trimmed);
    return scp ? `${scp[1]!.toLowerCase()}:${scp[2]!}${preserveQuery ? scp[3] ?? "" : ""}` : "";
  }
  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname) return "";
    url.username = "";
    url.password = "";
    if (!preserveQuery) url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Transport and repository spelling are not part of the Store identity. */
function matchingSourceUrl(value: string): string {
  const safe = sourceUrl(value, true);
  if (!safe) return "";
  if (!safe.includes("://")) {
    const separator = safe.indexOf(":");
    const host = safe.slice(0, separator);
    const path = safe.slice(separator + 1);
    return `https://${host}/${path.toLowerCase()}`;
  }
  const url = new URL(safe);
  const transport = url.protocol === "http:" ? "http" : "https";
  return `${transport}://${url.host}${url.pathname.toLowerCase()}${url.search}`;
}

/** Matches app identity across versions without equating different modules. */
export function matchingInstalledApps<T extends InstalledAppSummary>(
  apps: readonly T[],
  coordinate: InstallConfigSourceSelector,
): readonly T[] {
  return apps.filter((app) =>
    app.state !== "uninstalled" && app.state !== "installing" &&
    app.installedFrom.matchable !== false &&
    installConfigSourceCoordinateMatches(
      { ...app.installedFrom, url: matchingSourceUrl(app.installedFrom.url) },
      { ...coordinate, url: matchingSourceUrl(coordinate.url) },
    ),
  );
}
