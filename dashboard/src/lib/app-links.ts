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

/** Section fragments the app page honors, mapped to their element ids. */
export const APP_PAGE_SECTIONS = {
  attention: "attention",
  version: "version",
  settings: "settings",
  connections: "connections",
  created: "created",
  linked: "linked",
  history: "history",
  danger: "danger",
} as const;

export type AppPageSection = keyof typeof APP_PAGE_SECTIONS;

/** The canonical page of one installed app, optionally at one section. */
export function appPageHref(capsuleId: string, section?: AppPageSection): string {
  const path = `/apps/${encodeURIComponent(capsuleId)}`;
  return section ? `${path}#${APP_PAGE_SECTIONS[section]}` : path;
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
 * repository and ref pre-filled, nothing started. Without a known https
 * repository it is the store.
 */
export function reinstallHref(input: {
  readonly repositoryUrl?: string;
  readonly ref?: string;
  readonly name?: string;
}): string {
  const url = input.repositoryUrl?.trim();
  if (!url || !/^https:\/\//u.test(url)) return "/new";
  const params = new URLSearchParams({ git: url });
  const ref = input.ref?.trim();
  if (ref && ref.length <= 512) params.set("ref", ref);
  const name = input.name?.trim();
  if (name && name.length <= 96) params.set("name", name);
  return `/new?${params.toString()}`;
}
