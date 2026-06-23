/**
 * Shared Installation-presentation helpers (list + detail).
 */
import { type MessageKey, t } from "../i18n/index.ts";
import type { ActivityEvent } from "./control-api.ts";

/**
 * Presentation status for an Installation, folding the read-time `freshness`
 * field into the status vocabulary: an `active` app whose freshness is `stale`
 * presents as `stale` (再デプロイが必要). Compatible with both the
 * stored-`stale` backend and the derived-freshness backend.
 */
export function effectiveInstallationStatus(inst: {
  readonly status: string;
  readonly freshness?: "fresh" | "stale";
}): string {
  if (inst.freshness === "stale" && inst.status === "active") return "stale";
  return inst.status;
}

/** True when the app needs attention (error or stale under either model). */
export function needsAttention(inst: {
  readonly status: string;
  readonly freshness?: "fresh" | "stale";
}): boolean {
  const status = effectiveInstallationStatus(inst);
  return status === "error" || status === "stale";
}

/** True when the Installation belongs in the primary service launcher. */
export function isVisibleServiceInstallation(inst: {
  readonly status: string;
}): boolean {
  return inst.status !== "destroyed";
}

/** True for a string value that looks like an http(s) address worth linking. */
export function isUrlString(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/**
 * Pick a launch URL from a Deployment's public outputs. Prefers the well-known
 * `launch_url` / `url` / `app_url` keys; otherwise falls back to the first
 * http(s)-shaped value.
 */
export function launchUrlFromOutputs(
  outputs: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const key of ["launch_url", "url", "app_url", "public_url"]) {
    const value = outputs[key];
    if (isUrlString(value)) return value;
  }
  for (const value of Object.values(outputs)) {
    if (isUrlString(value)) return value;
  }
  return undefined;
}

/**
 * A declared app surface (a launchable screen) from a Capsule's public outputs.
 * One service may declare several — e.g. a blog's public site plus its admin
 * screen — and each becomes its own launcher tile.
 */
export interface AppSurface {
  /** Display name; the launcher falls back to the service name when absent. */
  readonly name?: string;
  /** Emoji / short glyph, or an icon image URL. */
  readonly icon?: string;
  /** Image URL used as the tile face when present. */
  readonly image?: string;
  /** Launch URL; tapping the tile opens it. */
  readonly url?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
function urlValue(value: unknown): string | undefined {
  return isUrlString(value) ? value.trim() : undefined;
}

/** Normalize one declared-surface object; null unless it carries a name. */
function surfaceFromObject(value: unknown): AppSurface | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const name = nonEmptyString(rec.name);
  if (!name) return null;
  return {
    name,
    icon: nonEmptyString(rec.icon),
    image: urlValue(rec.image),
    url: urlValue(rec.url),
  };
}

/**
 * The app surfaces a Capsule declares via well-known public outputs. This is
 * the dashboard's opt-in "this is an app" signal — a service with no app
 * metadata returns []. Supported declaration forms:
 *   - `apps`: an array of `{ name, icon?, image?, url? }` (multi-surface)
 *   - `app`: a single object, or an array of objects
 *   - flat `app_name` / `app_icon` / `app_image` / `app_url` (single surface;
 *     url falls back to the generic launch URL)
 * Object/array entries require a `name` (nameless entries are dropped); the
 * flat form allows an absent name (the launcher fills in the service name).
 */
export function appSurfacesFromOutputs(
  outputs: Readonly<Record<string, unknown>>,
): AppSurface[] {
  const surfaces: AppSurface[] = [];

  if (Array.isArray(outputs.apps)) {
    for (const entry of outputs.apps) {
      const surface = surfaceFromObject(entry);
      if (surface) surfaces.push(surface);
    }
  }
  if (Array.isArray(outputs.app)) {
    for (const entry of outputs.app) {
      const surface = surfaceFromObject(entry);
      if (surface) surfaces.push(surface);
    }
  } else {
    const single = surfaceFromObject(outputs.app);
    if (single) surfaces.push(single);
  }

  if (surfaces.length === 0) {
    const name = nonEmptyString(outputs.app_name);
    const icon = nonEmptyString(outputs.app_icon);
    const image = urlValue(outputs.app_image);
    if (name || icon || image) {
      surfaces.push({
        name,
        icon,
        image,
        url: urlValue(outputs.app_url) ?? launchUrlFromOutputs(outputs),
      });
    }
  }

  return surfaces;
}

/** Friendly label for a well-known public output key; humanized key otherwise. */
const OUTPUT_LABEL_KEYS: Record<string, MessageKey> = {
  launch_url: "app.output.launchUrl",
  url: "app.output.url",
  app_url: "app.output.launchUrl",
  public_url: "app.output.publicUrl",
  endpoint: "app.output.endpoint",
  hostname: "app.output.hostname",
};
export function outputLabel(name: string): string {
  const key = OUTPUT_LABEL_KEYS[name];
  return key ? t(key) : humanizeOutputKey(name);
}

function humanizeOutputKey(name: string): string {
  const normalized = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return name;
  return (normalized.charAt(0).toUpperCase() + normalized.slice(1))
    .replace(/\bUrl\b/gu, "URL")
    .replace(/\bId\b/gu, "ID")
    .replace(/\bApi\b/gu, "API");
}

/** Human-readable stale reason recorded on an `installation.stale` event. */
export function staleReasonFromActivity(
  event: ActivityEvent,
): string | undefined {
  const reasons = event.metadata.reasons;
  if (Array.isArray(reasons)) {
    const text = reasons
      .filter((entry): entry is string => typeof entry === "string")
      .join(", ");
    if (text) return text;
  }
  const changed = event.metadata.changedOutputs;
  const producer = event.metadata.producerInstallationName;
  if (Array.isArray(changed) && typeof producer === "string") {
    const text = changed
      .filter((entry): entry is string => typeof entry === "string")
      .map((name) => `${producer}.${name} changed`)
      .join(", ");
    if (text) return text;
  }
  return undefined;
}
