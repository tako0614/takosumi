/**
 * Shared Capsule-presentation helpers (list + detail).
 */
import { t } from "../i18n/index.ts";
import { type JsonValue } from "takosumi-contract";
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

/** True when the Capsule belongs in installed-service views and Interface joins. */
export function isVisibleServiceCapsule(inst: {
  readonly status: string;
}): boolean {
  return inst.status !== "destroyed";
}

/** True for a string value that looks like an http(s) address worth linking. */
export function isUrlString(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

export type ReleaseActivationStatus =
  "not_required" | "pending" | "succeeded" | "failed";

export type StateVersionReadiness =
  "settling" | "activation_pending" | "ready" | "activation_failed";

interface LaunchableStateVersion {
  readonly id: string;
  readonly capsuleId: string;
  readonly createdByRunId: string;
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

function releaseActivationEventMatchesStateVersion(
  event: ActivityEvent,
  stateVersion: LaunchableStateVersion,
  capsuleId?: string,
): boolean {
  if (!releaseActivationActionStatus(event.action)) return false;
  const metadata = event.metadata;
  const applyRunId = activityString(metadata.applyRunId);
  const stateVersionId = activityString(metadata.stateVersionId);
  const eventCapsuleId = activityString(metadata.capsuleId);
  const matchesStateVersionIdentity =
    event.runId === stateVersion.createdByRunId ||
    applyRunId === stateVersion.createdByRunId ||
    stateVersionId === stateVersion.id;
  if (event.runId || applyRunId || stateVersionId) {
    return matchesStateVersionIdentity;
  }
  return (
    (capsuleId !== undefined && eventCapsuleId === capsuleId) ||
    eventCapsuleId === stateVersion.capsuleId
  );
}

function latestReleaseActivationEvent(
  stateVersion: LaunchableStateVersion,
  events: readonly ActivityEvent[],
  capsuleId?: string,
): ActivityEvent | undefined {
  return events
    .filter((event) =>
      releaseActivationEventMatchesStateVersion(event, stateVersion, capsuleId),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export function releaseActivationStatusForStateVersion(
  stateVersion: LaunchableStateVersion | undefined,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): ReleaseActivationStatus {
  if (!stateVersion) return "not_required";
  const event = latestReleaseActivationEvent(stateVersion, events, capsuleId);
  const eventStatus = event
    ? releaseActivationActionStatus(event.action)
    : undefined;
  if (eventStatus) return eventStatus;
  // Lifecycle requirements are service-side configuration. OpenTofu Outputs
  // are ordinary data and must never be used to infer control-plane behavior.
  return "not_required";
}

/**
 * User-facing readiness after OpenTofu apply. A missing StateVersion is still
 * settling, while Capsules with release activation stay non-ready until the
 * matching activity reaches `release_activation.succeeded`.
 */
export function stateVersionReadinessAfterApply(
  stateVersion: LaunchableStateVersion | undefined,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): StateVersionReadiness {
  if (!stateVersion) return "settling";
  switch (
    releaseActivationStatusForStateVersion(stateVersion, events, capsuleId)
  ) {
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
 * Canonical post-apply readiness gate. A StateVersion with matching lifecycle
 * activity is ready only once activation reaches
 * release_activation.succeeded; it never supplies or selects a runtime URL.
 */
export function isStateVersionRuntimeReady(
  stateVersion: LaunchableStateVersion | undefined,
  events: readonly ActivityEvent[] = [],
  capsuleId?: string,
): boolean {
  if (!stateVersion) return false;
  const activation = releaseActivationStatusForStateVersion(
    stateVersion,
    events,
    capsuleId,
  );
  return activation === "not_required" || activation === "succeeded";
}

/**
 * A launcher surface validated from an authorized
 * `interface.ui.surface` Interface. Capsule state says the app is installed;
 * this object supplies the runtime surface; lifecycle readiness may still gate
 * opening it while activation settles.
 */
export interface AppSurface {
  /** Stable Interface id; one launcher tile corresponds to one Interface. */
  readonly interfaceId: string;
  /** Display name; the launcher falls back to the service name when absent. */
  readonly name?: string;
  /** Emoji / short glyph, or an icon image URL. */
  readonly icon?: string;
  /** Launch URL; tapping the tile opens it. */
  readonly url: string;
  readonly category?: string;
  readonly sortOrder?: number;
}

/**
 * User-facing display name from the install config's store metadata (the name
 * the store listing advertised, e.g. "Takos Storage"), as opposed to the
 * instance name the user typed (e.g. "storage4"). This is Store/admin
 * presentation for the service detail; launcher presentation comes from the
 * authorized UI-surface Interface.
 */
export function capsuleDisplayName(
  config: InstallConfig | undefined,
  language: "ja" | "en",
): string | undefined {
  const store = config?.store;
  if (!store) return undefined;
  return store.name[language] ?? store.suggestedName;
}

/** Friendly label for an ordinary OpenTofu Output key. */
export function outputLabel(name: string): string {
  return humanizeOutputKey(name);
}

/**
 * Distinguishing labels for the 公開リンク rows. Several recognized Output
 * keys can humanize to the same label, so colliding rows append their URL's
 * host+path. Output names remain ordinary data; no name selects runtime or
 * presentation behavior.
 */
export function publicLinkRowLabels(
  entries: readonly (readonly [string, unknown])[],
): readonly string[] {
  const resolved = entries.map(([name]) => outputLabel(name));
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

export function configRowsFromInstallConfig(
  config: InstallConfig | undefined,
  language: "ja" | "en",
): readonly ConfigVariableRow[] {
  if (!config) return [];
  const variables = config.variableMapping ?? {};
  const rows: ConfigVariableRow[] = [];
  const seen = new Set<string>();
  for (const input of config.variablePresentation ?? []) {
    const type = input.type ?? "string";
    const hasExistingValue = Object.prototype.hasOwnProperty.call(
      variables,
      input.name,
    );
    const defaultText = input.secret
      ? ""
      : input.defaultValue?.source === "literal"
        ? configValueToText(input.defaultValue.value, type)
        : "";
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
      secret: input.secret === true,
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
    if (seen.has(name)) continue;
    const type = inferConfigVariableType(value);
    const savedValue = configValueToText(value, type);
    rows.push({
      id: `custom:${name}`,
      originalName: name,
      name,
      label: name,
      value: savedValue,
      type,
      required: false,
      secret: false,
      advanced: false,
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
  const producer = event.metadata.producerCapsuleName;
  if (Array.isArray(changed) && typeof producer === "string") {
    const text = changed
      .filter((entry): entry is string => typeof entry === "string")
      .map((name) => `${producer}.${name} changed`)
      .join(", ");
    if (text) return text;
  }
  return undefined;
}
