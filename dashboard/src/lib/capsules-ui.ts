/**
 * Shared Capsule-presentation helpers (list + detail).
 */
import { type MessageKey, t } from "../i18n/index.ts";
import { installExperiencePublicEndpoint } from "takosumi-contract";
import type { ActivityEvent, InstallConfig } from "./control-api.ts";

export const PENDING_NEEDS_ATTENTION_AFTER_MS = 30 * 60 * 1000;

/**
 * Presentation status for an Capsule, folding the read-time `freshness`
 * field into the status vocabulary: an `active` app whose freshness is `stale`
 * presents as `stale` (再デプロイが必要). Compatible with both the
 * stored-`stale` backend and the derived-freshness backend.
 */
export function effectiveCapsuleStatus(
  inst: {
    readonly status: string;
    readonly freshness?: "fresh" | "stale";
    readonly updatedAt?: string;
  },
  options: {
    readonly now?: number;
    readonly pendingNeedsAttentionAfterMs?: number;
  } = {},
): string {
  if (pendingNeedsAttention(inst, options)) return "needs_attention";
  if (inst.freshness === "stale" && inst.status === "active") return "stale";
  return inst.status;
}

/** True when the app needs attention: failed, stale, or stuck in setup. */
export function needsAttention(
  inst: {
    readonly status: string;
    readonly freshness?: "fresh" | "stale";
    readonly updatedAt?: string;
  },
  options: {
    readonly now?: number;
    readonly pendingNeedsAttentionAfterMs?: number;
  } = {},
): boolean {
  const status = effectiveCapsuleStatus(inst, options);
  return (
    status === "error" || status === "stale" || status === "needs_attention"
  );
}

/** True when a setup-like Capsule has stayed pending long enough that it
 * should stop looking like normal progress in user-facing screens. */
export function pendingNeedsAttention(
  inst: {
    readonly status: string;
    readonly updatedAt?: string;
  },
  options: {
    readonly now?: number;
    readonly pendingNeedsAttentionAfterMs?: number;
  } = {},
): boolean {
  if (inst.status !== "pending") return false;
  if (!inst.updatedAt) return false;
  const updatedAt = Date.parse(inst.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const now = options.now ?? Date.now();
  const threshold =
    options.pendingNeedsAttentionAfterMs ?? PENDING_NEEDS_ATTENTION_AFTER_MS;
  return Math.max(0, now - updatedAt) >= threshold;
}

/** True when the Capsule belongs in the primary service launcher. */
export function isVisibleServiceCapsule(inst: {
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

export type ReleaseActivationStatus =
  "not_required" | "pending" | "succeeded" | "failed";

export type DeploymentReadiness =
  "settling" | "activation_pending" | "ready" | "activation_failed";

interface LaunchableDeployment {
  readonly id: string;
  readonly installationId?: string;
  readonly applyRunId: string;
  readonly outputsPublic: Readonly<Record<string, unknown>>;
  readonly status: string;
}

function releaseActivationActionStatus(
  action: string,
): Exclude<ReleaseActivationStatus, "not_required"> | undefined {
  switch (action) {
    case "release_activation.succeeded":
      return "succeeded";
    case "release_activation.failed":
      return "failed";
    case "release_activation.pending":
      return "pending";
    default:
      return undefined;
  }
}

function activityString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function releaseActivationEventMatchesDeployment(
  event: ActivityEvent,
  deployment: LaunchableDeployment,
  capsuleId?: string,
): boolean {
  if (!releaseActivationActionStatus(event.action)) return false;
  const metadata = event.metadata;
  const applyRunId = activityString(metadata.applyRunId);
  const deploymentId = activityString(metadata.deploymentId);
  const eventCapsuleId =
    activityString(metadata.capsuleId) ??
    activityString(metadata.installationId);
  const matchesDeploymentIdentity =
    event.runId === deployment.applyRunId ||
    applyRunId === deployment.applyRunId ||
    deploymentId === deployment.id;
  if (event.runId || applyRunId || deploymentId) {
    return matchesDeploymentIdentity;
  }
  return (
    (capsuleId !== undefined && eventCapsuleId === capsuleId) ||
    (deployment.installationId !== undefined &&
      eventCapsuleId === deployment.installationId)
  );
}

function latestReleaseActivationEvent(
  deployment: LaunchableDeployment,
  events: readonly ActivityEvent[],
  capsuleId?: string,
): ActivityEvent | undefined {
  return events
    .filter((event) =>
      releaseActivationEventMatchesDeployment(event, deployment, capsuleId),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export function releaseActivationStatusForDeployment(
  deployment: LaunchableDeployment | undefined,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): ReleaseActivationStatus {
  if (!deployment) return "not_required";
  const event = latestReleaseActivationEvent(deployment, events, capsuleId);
  const eventStatus = event
    ? releaseActivationActionStatus(event.action)
    : undefined;
  if (eventStatus) return eventStatus;
  return Object.prototype.hasOwnProperty.call(
    deployment.outputsPublic,
    "takosumi_release",
  )
    ? "pending"
    : "not_required";
}

/**
 * User-facing readiness after OpenTofu apply. A missing Deployment is still
 * settling, while Capsules with release activation stay non-ready until the
 * matching activity reaches `release_activation.succeeded`.
 */
export function deploymentReadinessAfterApply(
  deployment: LaunchableDeployment | undefined,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): DeploymentReadiness {
  if (!deployment) return "settling";
  switch (releaseActivationStatusForDeployment(deployment, events, capsuleId)) {
    case "pending":
      return "activation_pending";
    case "failed":
      return "activation_failed";
    case "not_required":
    case "succeeded":
      return "ready";
  }
}

export function isDeploymentPubliclyOpenable(
  deployment: LaunchableDeployment | undefined,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): boolean {
  if (!deployment || deployment.status === "destroyed") return false;
  const activation = releaseActivationStatusForDeployment(
    deployment,
    events,
    capsuleId,
  );
  return activation === "not_required" || activation === "succeeded";
}

export function launchUrlFromDeployment(
  deployment: LaunchableDeployment | undefined,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): string | undefined {
  if (!deployment) return undefined;
  if (!isDeploymentPubliclyOpenable(deployment, events, capsuleId)) {
    return undefined;
  }
  return launchUrlFromOutputs(deployment.outputsPublic);
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

export function appSurfaceFromInstallConfigStore(
  config: InstallConfig | undefined,
  language: "ja" | "en",
): AppSurface | undefined {
  const store = config?.store;
  if (!store || store.surface !== "service") return undefined;
  return {
    name: store.name[language] ?? store.suggestedName ?? config.name,
    image: urlValue(store.iconUrl),
    // Even when the OpenTofu module declares no URL output, the public host
    // is knowable: the store install experience's public_endpoint projection
    // named the variable(s), and we set that value at install (it survives in
    // the install config's variableMapping). Derive it so an app whose module
    // just forgot to output its URL is still openable from the tile.
    ...(publicUrlFromInstallConfig(config)
      ? { url: publicUrlFromInstallConfig(config) }
      : {}),
  };
}

/**
 * Reconstruct the intended public URL of a store-installed Capsule from its
 * install inputs, for the case where the deployed module declares no URL
 * output. Reads the `public_endpoint` install-experience projection to learn
 * which variables carry the URL / subdomain, then reads the value we set at
 * install from the config's `variableMapping`. Returns undefined for services
 * that declared no public endpoint (a storage / building-block Capsule).
 */
export function publicUrlFromInstallConfig(
  config: InstallConfig | undefined,
): string | undefined {
  const vars = config?.variableMapping ?? {};
  const readVar = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const value = vars[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  // Best: the store app declared a public_endpoint — use its named url
  // variable, or subdomain + its declared base domain (unambiguous).
  const endpoint = installExperiencePublicEndpoint(
    config?.store?.installExperience,
  );
  if (endpoint) {
    const explicitUrl = readVar(endpoint.urlVariable);
    if (explicitUrl && isUrlString(explicitUrl)) return explicitUrl;
    const subdomain = readVar(endpoint.subdomainVariable);
    const baseDomain = endpoint.baseDomain?.trim().replace(/^\*\.|\.$/gu, "");
    if (subdomain && baseDomain) return `https://${subdomain}.${baseDomain}`;
  }
  // Fallback: a full https URL was set under a standard variable name, even
  // without a projection. Only a complete URL — never guess a base domain.
  for (const key of ["public_url", "app_url"]) {
    const value = readVar(key);
    if (value && isUrlString(value)) return value;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
function urlValue(value: unknown): string | undefined {
  return isUrlString(value) ? value.trim() : undefined;
}

function publicAssetUrlValue(
  value: unknown,
  outputs: Readonly<Record<string, unknown>>,
): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw.trim();
  if (!raw.startsWith("/")) return undefined;
  const base = launchUrlFromOutputs(outputs);
  if (!base) return undefined;
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

function publicIconValue(
  value: unknown,
  outputs: Readonly<Record<string, unknown>>,
): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  return publicAssetUrlValue(raw, outputs) ?? raw;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** Normalize one declared-surface object; null unless it carries a name. */
function surfaceFromObject(
  value: unknown,
  outputs: Readonly<Record<string, unknown>>,
): AppSurface | null {
  const rec = recordValue(value);
  if (!rec) return null;
  const name = nonEmptyString(rec.name);
  if (!name) return null;
  return {
    name,
    icon: publicIconValue(rec.icon, outputs),
    image: publicAssetUrlValue(rec.image, outputs),
    url: urlValue(rec.url),
  };
}

function appDeploymentPublishDeclaresLauncher(
  entry: Record<string, unknown>,
): boolean {
  const type = nonEmptyString(entry.type);
  if (
    type === "interface.ui.surface" ||
    type === "UiSurface" ||
    type === "ui.surface" ||
    type === "launcher"
  ) {
    return true;
  }
  const spec = recordValue(entry.spec);
  return spec?.launcher === true;
}

function surfaceFromAppDeploymentPublish(
  entry: unknown,
  outputs: Readonly<Record<string, unknown>>,
  fallbackName?: string,
): AppSurface | null {
  const rec = recordValue(entry);
  if (!rec || !appDeploymentPublishDeclaresLauncher(rec)) return null;
  const display = recordValue(rec.display) ?? {};
  const name =
    nonEmptyString(display.title) ?? nonEmptyString(rec.name) ?? fallbackName;
  if (!name) return null;
  const declaredOutputs = recordValue(rec.outputs);
  const urlOutput = recordValue(declaredOutputs?.url);
  return {
    name,
    icon: publicIconValue(display.icon, outputs),
    image: publicAssetUrlValue(display.image, outputs),
    url:
      urlValue(urlOutput?.url) ??
      urlValue(urlOutput?.value) ??
      launchUrlFromOutputs(outputs),
  };
}

function surfacesFromAppDeployment(
  outputs: Readonly<Record<string, unknown>>,
): AppSurface[] {
  const value = recordValue(outputs.app_deployment);
  if (!value) return [];
  const publish = value.publish;
  if (!Array.isArray(publish)) return [];
  const fallbackName = nonEmptyString(value.name);
  const surfaces: AppSurface[] = [];
  for (const entry of publish) {
    const surface = surfaceFromAppDeploymentPublish(
      entry,
      outputs,
      fallbackName,
    );
    if (surface) surfaces.push(surface);
  }
  return surfaces;
}

/**
 * The app surfaces a Capsule declares via well-known public outputs. This is
 * the dashboard's opt-in "this is an app" signal — a service with no app
 * metadata returns []. Supported declaration forms:
 *   - `app_deployment.publish`: the current OpenTofu app declaration shape
 *     emitted by installable Capsules such as Takos and yurucommu.
 *   - `apps`: an array of `{ name, icon?, image?, url? }` (multi-surface)
 *   - `app`: a single object, or an array of objects
 *   - flat `app_name` / `app_icon` / `app_image` / `app_url` (single surface;
 *     url falls back to the generic launch URL)
 *   - a bare `launch_url` / `url` / `app_url` / `public_url` fallback for
 *     plain OpenTofu apps that expose only a launchable URL
 * Object/array entries require a `name` (nameless entries are dropped); the
 * flat form allows an absent name (the launcher fills in the service name).
 */
export function appSurfacesFromOutputs(
  outputs: Readonly<Record<string, unknown>>,
): AppSurface[] {
  const surfaces: AppSurface[] = [];

  surfaces.push(...surfacesFromAppDeployment(outputs));

  if (Array.isArray(outputs.apps)) {
    for (const entry of outputs.apps) {
      const surface = surfaceFromObject(entry, outputs);
      if (surface) surfaces.push(surface);
    }
  }
  if (Array.isArray(outputs.app)) {
    for (const entry of outputs.app) {
      const surface = surfaceFromObject(entry, outputs);
      if (surface) surfaces.push(surface);
    }
  } else {
    const single = surfaceFromObject(outputs.app, outputs);
    if (single) surfaces.push(single);
  }

  if (surfaces.length === 0) {
    const name = nonEmptyString(outputs.app_name);
    const icon = publicIconValue(outputs.app_icon, outputs);
    const image = publicAssetUrlValue(outputs.app_image, outputs);
    if (name || icon || image) {
      surfaces.push({
        name,
        icon,
        image,
        url: urlValue(outputs.app_url) ?? launchUrlFromOutputs(outputs),
      });
    }
  }

  if (surfaces.length === 0) {
    const url = launchUrlFromOutputs(outputs);
    if (url) surfaces.push({ url });
  }

  return surfaces;
}

export function appSurfacesFromDeployment(
  deployment: LaunchableDeployment,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): AppSurface[] {
  const surfaces = appSurfacesFromOutputs(deployment.outputsPublic);
  if (isDeploymentPubliclyOpenable(deployment, events, capsuleId)) {
    return surfaces;
  }
  return surfaces.map((surface) => ({ ...surface, url: undefined }));
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

/** Human-readable stale reason recorded on an `capsule.stale` event. */
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
