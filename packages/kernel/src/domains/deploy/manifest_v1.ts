import type {
  JsonObject,
  ManifestEnvelopeIssue,
  ManifestResource,
} from "takosumi-contract";
import { validateManifestEnvelope } from "takosumi-contract";

export type ManifestV1Resolution =
  | { readonly ok: true; readonly value: readonly ManifestResource[] }
  | { readonly ok: false; readonly error: string };

export class ManifestV1ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestV1ResolutionError";
  }
}

export function resolveManifestResourcesV1(
  manifest: unknown,
): ManifestV1Resolution {
  if (!isJsonObject(manifest)) {
    return { ok: false, error: "manifest must be a JSON object" };
  }

  const envelopeIssues: ManifestEnvelopeIssue[] = [];
  validateManifestEnvelope(manifest, envelopeIssues);
  if (envelopeIssues.length > 0) {
    return {
      ok: false,
      error: envelopeIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; "),
    };
  }

  const hasResources = manifest.resources !== undefined;

  if (!hasResources) {
    return {
      ok: false,
      error: "manifest.resources[] is required",
    };
  }

  const explicit = readResourcesArray(manifest.resources);
  if (!explicit.ok) return explicit;
  const resources = explicit.value;

  if (resources.length === 0) {
    return {
      ok: false,
      error:
        "manifest expands to zero resources; specify at least one resource",
    };
  }

  return { ok: true, value: resources };
}

export function expandManifestResourcesV1(
  manifest: unknown,
): readonly ManifestResource[] {
  const result = resolveManifestResourcesV1(manifest);
  if (!result.ok) throw new ManifestV1ResolutionError(result.error);
  return result.value;
}

/**
 * Stable deployment name extraction shared by CLI-facing kernel routes.
 *
 * Preference order:
 *   1. `metadata.name`
 *   2. deterministic hash of the resolved resource identities
 */
export function readDeploymentNameV1(
  manifest: JsonObject,
  resources: readonly ManifestResource[],
): string {
  const metadata = manifest.metadata;
  if (isJsonObject(metadata)) {
    const name = metadata.name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return `unnamed-${fallbackResourceHash(resources)}`;
}

function readResourcesArray(candidate: unknown): ManifestV1Resolution {
  if (!Array.isArray(candidate)) {
    return { ok: false, error: "manifest.resources must be an array" };
  }
  for (const [index, entry] of candidate.entries()) {
    if (!isJsonObject(entry)) {
      return {
        ok: false,
        error: `manifest.resources[${index}] must be an object`,
      };
    }
    if (typeof entry.shape !== "string" || entry.shape.length === 0) {
      return {
        ok: false,
        error: `manifest.resources[${index}].shape must be a non-empty string`,
      };
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      return {
        ok: false,
        error: `manifest.resources[${index}].name must be a non-empty string`,
      };
    }
    if (
      entry.provider !== undefined &&
      (typeof entry.provider !== "string" || entry.provider.length === 0)
    ) {
      return {
        ok: false,
        error:
          `manifest.resources[${index}].provider must be a non-empty string when present`,
      };
    }
    if (entry.spec === undefined) {
      return {
        ok: false,
        error: `manifest.resources[${index}].spec is required`,
      };
    }
  }
  return { ok: true, value: candidate as readonly ManifestResource[] };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackResourceHash(
  resources: readonly ManifestResource[],
): string {
  let hash = 5381;
  const seed = resources
    .map((resource) =>
      `${resource.shape}|${resource.name}|${resource.provider ?? "(auto)"}`
    )
    .join(";");
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash) ^ seed.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
