/**
 * Shared Capsule-presentation helpers (list + detail).
 */
import { type MessageKey, t } from "../i18n/index.ts";
import {
  installExperiencePublicEndpoint,
  type JsonValue,
} from "takosumi-contract";
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
  if (
    !Object.prototype.hasOwnProperty.call(
      deployment.outputsPublic,
      "takosumi_release",
    )
  ) {
    return "not_required";
  }
  // A `takosumi_release` deployment stays non-openable (pending) until its
  // matching activation reaches release_activation.succeeded — a release URL is
  // never exposed on unconfirmed activation.
  return "pending";
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

/**
 * Canonical "is this deployment's app surface openable right now" gate, shared
 * by the launcher tile, the service detail, and RunView. A `takosumi_release`
 * deployment is openable only once its activation reaches
 * release_activation.succeeded; everything else opens when activation is
 * not required.
 */
export function isDeploymentOpenable(
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
  if (!isDeploymentOpenable(deployment, events, capsuleId)) {
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

/**
 * User-facing display name from the install config's store metadata (the name
 * the store listing advertised, e.g. "Takos Storage"), as opposed to the
 * instance name the user typed (e.g. "storage4"). The launcher tile and the
 * detail header derive the same value from here.
 */
export function capsuleDisplayName(
  config: InstallConfig | undefined,
  language: "ja" | "en",
): string | undefined {
  const store = config?.store;
  if (!store) return undefined;
  return store.name[language] ?? store.suggestedName;
}

export function appSurfaceFromInstallConfigStore(
  config: InstallConfig | undefined,
  language: "ja" | "en",
): AppSurface | undefined {
  const store = config?.store;
  if (!store || store.surface !== "service") return undefined;
  return {
    name: capsuleDisplayName(config, language) ?? config.name,
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
  if (isDeploymentOpenable(deployment, events, capsuleId)) {
    return surfaces;
  }
  // Not openable yet (activation pending / failed): keep the tile but strip the
  // live URL so it falls back to the service screen instead of a link that
  // 404s — matching the detail + run gating.
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

/**
 * Distinguishing labels for the 公開リンク rows. Several well-known output
 * keys share one friendly label (`launch_url` / `app_url` / `public_url` all
 * read 公開アドレス), so a service exposing more than one of them rendered
 * near-identical rows. Colliding labels fall back to the humanized raw key
 * (unique per key); should two keys ALSO humanize identically, the URL's
 * host+path disambiguates.
 */
export function publicLinkRowLabels(
  entries: readonly (readonly [string, unknown])[],
): readonly string[] {
  const friendly = entries.map(([name]) => outputLabel(name));
  const friendlyCounts = countBy(friendly);
  const resolved = entries.map(([name], index) =>
    (friendlyCounts.get(friendly[index]!) ?? 0) > 1
      ? humanizeOutputKey(name)
      : friendly[index]!,
  );
  const resolvedCounts = countBy(resolved);
  return entries.map(([, value], index) => {
    const label = resolved[index]!;
    if ((resolvedCounts.get(label) ?? 0) <= 1) return label;
    const hostPath = urlHostPathLabel(value);
    return hostPath ? `${label} (${hostPath})` : label;
  });
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function urlHostPathLabel(value: unknown): string | undefined {
  if (!isUrlString(value)) return undefined;
  try {
    const url = new URL(value.trim());
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return undefined;
  }
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
    .replace(/\burl\b/giu, "URL")
    .replace(/\bId\b/gu, "ID")
    .replace(/\bApi\b/gu, "API");
}

// === Config variable editor model (service detail 設定値 form) ==============

export type ConfigVariableType = "string" | "number" | "boolean" | "json";

export interface ConfigVariableRow {
  id: string;
  originalName?: string;
  name: string;
  label: string;
  helper?: string;
  placeholder?: string;
  value: string;
  type: ConfigVariableType;
  required: boolean;
  secret: boolean;
  advanced: boolean;
  storeField: boolean;
  /** True when the variable pre-existed in the config's variableMapping. */
  hasExistingValue: boolean;
  /** Default-presented value text (the store input's declared default). */
  defaultText: string;
  /** The seeded value text (existing mapping value; "" for masked secrets). */
  savedValue: string;
  /** True once the user actually edited the row (name or value). */
  dirty: boolean;
  /**
   * Store row marked to revert to the module default on save: the explicit
   * mapping value (when one existed) is removed, nothing is written. Undoable
   * before save.
   */
  resetToDefault: boolean;
  deleted?: boolean;
}

export const SYSTEM_CONFIG_VARIABLES = new Set([
  "takosumi_accounts_url",
  "takosumi_accounts_issuer_url",
  "takosumi_accounts_client_id",
  "takosumi_accounts_redirect_uri",
]);

export function configRowsFromInstallConfig(
  config: InstallConfig | undefined,
  language: "ja" | "en",
): readonly ConfigVariableRow[] {
  if (!config) return [];
  const variables = config.variableMapping ?? {};
  const rows: ConfigVariableRow[] = [];
  const seen = new Set<string>();
  for (const input of config.store?.inputs ?? []) {
    if (SYSTEM_CONFIG_VARIABLES.has(input.name)) continue;
    const type = input.type ?? "string";
    const hasExistingValue = Object.prototype.hasOwnProperty.call(
      variables,
      input.name,
    );
    const defaultText = input.secret
      ? ""
      : configValueToText(input.defaultValue ?? "", type);
    const savedValue = input.secret
      ? ""
      : hasExistingValue
        ? configValueToText(variables[input.name], type)
        : defaultText;
    rows.push({
      id: `store:${input.name}`,
      originalName: input.name,
      name: input.name,
      label: localizedText(input.label, language) ?? input.name,
      helper: localizedText(input.helper, language),
      placeholder: input.placeholder,
      value: savedValue,
      type,
      required: input.required === true,
      secret: input.secret === true || variableNameLooksSecret(input.name),
      advanced: input.advanced === true,
      storeField: true,
      hasExistingValue,
      defaultText,
      savedValue,
      dirty: false,
      resetToDefault: false,
    });
    seen.add(input.name);
  }
  for (const [name, value] of Object.entries(variables)) {
    if (SYSTEM_CONFIG_VARIABLES.has(name) || seen.has(name)) continue;
    const type = inferConfigVariableType(value);
    const secret = variableNameLooksSecret(name);
    const savedValue = secret ? "" : configValueToText(value, type);
    rows.push({
      id: `custom:${name}`,
      originalName: name,
      name,
      label: name,
      value: savedValue,
      type,
      required: false,
      secret,
      advanced: true,
      storeField: false,
      hasExistingValue: true,
      defaultText: "",
      savedValue,
      dirty: false,
      resetToDefault: false,
    });
  }
  return rows;
}

function localizedText(
  text: { readonly ja: string; readonly en: string } | undefined,
  language: "ja" | "en",
): string | undefined {
  if (!text) return undefined;
  return language === "ja" ? text.ja : text.en;
}

export function variableNameLooksSecret(name: string): boolean {
  return /(^|[_-])(password|passwd|token|secret|api[_-]?key|private[_-]?key)([_-]|$)/iu.test(
    name,
  );
}

function inferConfigVariableType(value: unknown): ConfigVariableType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (value !== null && typeof value === "object") return "json";
  return "string";
}

export function configValueToText(
  value: unknown,
  type: ConfigVariableType,
): string {
  if (value === null || value === undefined) return "";
  if (type === "json") {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  if (type === "boolean")
    return value === true || value === "true" ? "true" : "false";
  return typeof value === "string" ? value : String(value);
}

export function buildConfigVariablePatch(rows: readonly ConfigVariableRow[]):
  | {
      readonly variableMapping: Readonly<Record<string, JsonValue>>;
      readonly removeVariables: readonly string[];
    }
  | { readonly error: string } {
  const variableMapping: Record<string, JsonValue> = {};
  const removeVariables = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const originalName = row.originalName?.trim();
    if (row.deleted) {
      if (originalName) removeVariables.add(originalName);
      continue;
    }
    // A store row reset back to its default: remove the pinned mapping value
    // (when one existed) and write nothing — the module's own default wins.
    if (row.storeField && row.resetToDefault) {
      if (originalName && row.hasExistingValue) {
        removeVariables.add(originalName);
      }
      continue;
    }
    const name = row.name.trim();
    if (!name) {
      if (!row.value.trim()) continue;
      return { error: t("app.config.errorNameRequired") };
    }
    if (/\s/u.test(name)) {
      return { error: t("app.config.errorNameInvalid", { name }) };
    }
    if (seen.has(name)) {
      return { error: t("app.config.errorNameDuplicate", { name }) };
    }
    seen.add(name);
    if (originalName && originalName !== name)
      removeVariables.add(originalName);
    // DIRTY-ONLY writes: untouched rows are never written. Writing them would
    // pin listing defaults as explicit values, write untouched optional fields
    // as "", untouched booleans as false and empty JSON as null — overriding
    // the module's HCL defaults on the next deploy. Untouched values that
    // pre-exist in the mapping survive unchanged via the PATCH merge
    // semantics (removeVariables deletes, variableMapping merges on top).
    if (!row.dirty) continue;
    if (row.secret && row.value.trim() === "") continue;
    const parsed = parseConfigVariableValue(row);
    if ("error" in parsed) return parsed;
    variableMapping[name] = parsed.value;
  }
  return { variableMapping, removeVariables: [...removeVariables] };
}

function parseConfigVariableValue(
  row: ConfigVariableRow,
): { readonly value: JsonValue } | { readonly error: string } {
  const raw = row.value.trim();
  if (row.type === "boolean") return { value: raw === "true" };
  if (row.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return { error: t("app.config.errorNumber", { name: row.name }) };
    }
    return { value };
  }
  if (row.type === "json") {
    if (!raw) return { value: null };
    try {
      return { value: JSON.parse(raw) as JsonValue };
    } catch {
      return { error: t("app.config.errorJson", { name: row.name }) };
    }
  }
  return { value: row.value };
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
