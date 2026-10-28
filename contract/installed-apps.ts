/** Value-free Store matching summaries; no Output or Interface inputs. */
import type { CapsuleAppAction, CapsuleAppState } from "./capsules.ts";
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
  readonly primaryAction: CapsuleAppAction;
  /** Repository and executable module coordinate. A ref is never identity. */
  readonly installedFrom: InstallConfigSourceSelector;
}

export interface ListInstalledAppsResponse {
  readonly installedApps: readonly InstalledAppSummary[];
}

/**
 * Value-free repository identity for Store discovery only. URL credentials,
 * query and fragment never leave this projection or affect its comparison.
 * This does not replace the executable InstallConfig source selector.
 * scp keeps its relative-path spelling separate from ssh:// absolute paths.
 */
export function installedAppSourceUrl(value: string): string {
  const trimmed = value.trim();
  if (/[\\\r\n\0]/u.test(trimmed)) return "";
  if (!trimmed.includes("://")) {
    // Accept both source spelling (git@host:path) and its already-projected
    // host:path spelling so normalization is idempotent.
    const scp = /^(?:[^@/:]+@)?([^@/:?#\s]+):([^?#]+)(?:[?#].*)?$/u.exec(trimmed);
    return scp ? `${scp[1]!.toLowerCase()}:${scp[2]!}` : "";
  }
  try {
    const url = new URL(trimmed);
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Matches app identity across versions without equating different modules. */
export function matchingInstalledApps<T extends InstalledAppSummary>(
  apps: readonly T[],
  coordinate: InstallConfigSourceSelector,
): readonly T[] {
  return apps.filter((app) =>
    app.state !== "uninstalled" &&
    installConfigSourceCoordinateMatches(
      { ...app.installedFrom, url: installedAppSourceUrl(app.installedFrom.url) },
      { ...coordinate, url: installedAppSourceUrl(coordinate.url) },
    ),
  );
}
