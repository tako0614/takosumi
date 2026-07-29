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

export interface ResourceSafeUrlProjection {
  readonly outputName: string;
  readonly url: string;
}

/**
 * Resource Output values are hidden unless this dashboard contract names the
 * exact shape/output pair as a public navigation surface.
 *
 * `EdgeWorker.url` is declared by the canonical EdgeWorker implementation as a
 * typed `url` module output. Keeping this allowlist narrower than arbitrary
 * `status.outputs` prevents a provider, custom shape, or secret-looking output
 * name from turning an untrusted value into a dashboard link.
 */
const SAFE_RESOURCE_URL_OUTPUT_NAMES: Readonly<
  Record<string, readonly string[]>
> = {
  EdgeWorker: ["url"],
};

/** Return only explicitly allowlisted, credential-free HTTPS Resource URLs. */
export function resourceSafeUrlProjections(
  resource: ResourceShape,
): readonly ResourceSafeUrlProjection[] {
  const outputNames = SAFE_RESOURCE_URL_OUTPUT_NAMES[resource.kind] ?? [];
  const outputs = resource.status?.outputs ?? {};
  const projected: ResourceSafeUrlProjection[] = [];

  for (const outputName of outputNames) {
    const value = outputs[outputName];
    if (typeof value !== "string") continue;
    const url = safeCanonicalHttpsUrl(value);
    if (url) projected.push({ outputName, url });
  }

  return projected;
}

function safeCanonicalHttpsUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
