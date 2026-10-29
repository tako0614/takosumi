/**
 * Where an installed app lives in the dashboard (TASK-0115 Phase 3a).
 *
 * `/apps/:id` is the one canonical URL of an installed app's page. Its
 * sections are plain fragments (`#settings`, `#history`, `#danger` …) that
 * the page honors on load, so an old tab route, a notification or another
 * page can link straight to the part it means. Older app URLs
 * (`/workloads/:id[/:tab]`, `/services/:id`, `/capsules/:id`, `/new?capsule=`)
 * redirect here.
 */

import { isCanonicalRepositoryDirectoryPath } from "takosumi-contract";

/** Section fragments the app page honors, mapped to their element ids. */
export const APP_PAGE_SECTIONS = {
  attention: "attention",
  version: "version",
  settings: "settings",
  connections: "connections",
  links: "links",
  created: "created",
  history: "history",
  sharing: "sharing",
  danger: "danger",
} as const;

export type AppPageSection = keyof typeof APP_PAGE_SECTIONS;

/** The canonical page of one installed app, optionally at one section. */
export function appPageHref(capsuleId: string, section?: AppPageSection): string {
  const path = `/apps/${encodeURIComponent(capsuleId)}`;
  return section ? `${path}#${APP_PAGE_SECTIONS[section]}` : path;
}

/**
 * The install page of one unfinished install attempt. It shows that attempt
 * as it stands (reading, the sheet, the review) and continues from there.
 */
export function installAttemptHref(installPlanId: string): string {
  if (!/^gip_[a-f0-9]{16}$/u.test(installPlanId)) throw new TypeError("Invalid install attempt id");
  return `/new?installPlan=${installPlanId}`;
}

/** The section a location fragment names, if it names one. */
export function appPageSectionFromHash(hash: string): AppPageSection | undefined {
  const name = hash.replace(/^#/u, "");
  return Object.hasOwn(APP_PAGE_SECTIONS, name) ? (name as AppPageSection) : undefined;
}

/**
 * The section an old `/workloads/:id/:tab` (or `/services/…`, `/capsules/…`)
 * tab segment meant. Unknown tabs land on the top of the page.
 */
export function legacyAppTabSection(tab: string | undefined): AppPageSection | undefined {
  switch (tab) {
    case "deploys":
    case "versions":
    case "version":
      return "version";
    case "settings":
    case "config":
      return "settings";
    case "connections":
      return "connections";
    case "resources":
    case "created":
      return "created";
    case "history":
    case "runs":
    case "activity":
      return "history";
    case "danger":
    case "uninstall":
      return "danger";
    default:
      return undefined;
  }
}

/**
 * Where an older app URL lands: `/workloads/:id[/:tab]`, `/services/…`,
 * `/capsules/…` and `/apps/:id/:tab` open the canonical `/apps/:id` (an old
 * tab as its section fragment), and a bare `/new?capsule=<id>` opens that
 * app's page. Anything else is not an older app URL.
 */
export function resolveLegacyAppUrl(pathname: string, search = ""): string | undefined {
  const match = /^\/(workloads|services|capsules|apps)\/([^/]+)(?:\/([^/]+))?\/?$/u.exec(pathname);
  if (match) {
    const [, root, rawId, tab] = match;
    // `/apps/:id` itself is the canonical page, not a redirect.
    if (root === "apps" && tab === undefined) return undefined;
    let id: string;
    try {
      id = decodeURIComponent(rawId!);
    } catch {
      return undefined;
    }
    return appPageHref(id, legacyAppTabSection(tab));
  }
  if (pathname === "/new") {
    const capsuleId = legacyInstallLocatorCapsuleId(search);
    return capsuleId ? appPageHref(capsuleId) : undefined;
  }
  return undefined;
}

/**
 * The app an old `/new?capsule=<id>` link named, when that locator is the
 * whole query. A link that also carries an app handoff or install prefill
 * stays on the install page, which owns those parameters.
 */
export function legacyInstallLocatorCapsuleId(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== "capsule") return undefined;
  const id = params.get("capsule") ?? "";
  return /^cap_[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : undefined;
}

/**
 * The install page for installing an uninstalled app again: its Git
 * repository, the ref it last ran, its Source subtree and module path
 * pre-filled, nothing started. Without a known https repository it is the
 * store. A ref is carried only when it is known (never the Source's default
 * ref in its place).
 */
export function reinstallHref(input: {
  readonly repositoryUrl?: string;
  readonly ref?: string;
  /** Git subtree the Source syncs. */
  readonly sourcePath?: string;
  /** OpenTofu module path inside that subtree. */
  readonly path?: string;
  readonly name?: string;
}): string {
  const url = credentialFreeHttpsUrl(input.repositoryUrl);
  if (!url) return "/new";
  const params = new URLSearchParams({ git: url });
  const ref = input.ref?.trim();
  if (ref && ref.length <= 512) params.set("ref", ref);
  const sourcePath = input.sourcePath?.trim();
  if (sourcePath && isCanonicalRepositoryDirectoryPath(sourcePath)) params.set("sourcePath", sourcePath);
  const path = input.path?.trim();
  if (path && isCanonicalRepositoryDirectoryPath(path)) params.set("path", path);
  const name = input.name?.trim();
  if (name && name.length <= 96) params.set("name", name);
  return `/new?${params.toString()}`;
}

/**
 * An https Git URL with any user info, query and fragment removed, so no
 * credential embedded in a stored URL (`user:token@`, `?access_token=`) can
 * reach a link.
 */
function credentialFreeHttpsUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
