import type {
  ResourceShape,
  ResourceShapeJsonObject,
  ResourceShapeWriteInput,
} from "./control-api.ts";
import type { Tone } from "../components/ui/Badge.tsx";

export type JsonObjectParseResult =
  | { readonly ok: true; readonly value: ResourceShapeJsonObject }
  | { readonly ok: false; readonly message: string };

/** Parse an operator-authored JSON object without accepting arrays/scalars. */
export function parseJsonObjectText(text: string): JsonObjectParseResult {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, message: "JSON object required" };
    }
    return { ok: true, value: value as ResourceShapeJsonObject };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

export type StringMapParseResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string };

export function parseStringMapText(text: string): StringMapParseResult {
  const parsed = parseJsonObjectText(text);
  if (!parsed.ok) return parsed;
  const entries = Object.entries(parsed.value);
  if (entries.some(([, value]) => typeof value !== "string")) {
    return { ok: false, message: "String values required" };
  }
  return {
    ok: true,
    value: Object.fromEntries(entries) as Readonly<Record<string, string>>,
  };
}

/** Stable enough for invalidating a preview when any editor field changes. */
export function resourceShapeInputFingerprint(
  input: ResourceShapeWriteInput,
): string {
  return JSON.stringify(input);
}

/** Dashboard session routes derive Resource Space from the verified Workspace. */
export function resourceShapeHref(resource: ResourceShape): string {
  const kind = encodeURIComponent(resource.kind);
  const name = encodeURIComponent(resource.metadata.name);
  return `/resources/${kind}/${name}`;
}

export function resourcePhaseTone(phase: string | undefined): Tone {
  switch (phase) {
    case "Ready":
      return "ok";
    case "Pending":
    case "Resolving":
    case "Planning":
    case "Applying":
    case "Deleting":
      return "info";
    case "Degraded":
      return "warn";
    case "Failed":
      return "danger";
    case "Deleted":
      return "muted";
    default:
      return "neutral";
  }
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Output values stay folded; inventory surfaces only need public key names. */
export function resourceOutputKeys(resource: ResourceShape): readonly string[] {
  return Object.keys(resource.status?.outputs ?? {}).sort();
}
