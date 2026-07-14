import type { ResourceShapeJsonObject } from "./control-api.ts";

export const GUIDED_RESOURCE_SERVICE_KINDS = [
  "EdgeWorker",
  "ObjectBucket",
] as const;

export type GuidedResourceServiceKind =
  (typeof GUIDED_RESOURCE_SERVICE_KINDS)[number];
export type EdgeWorkerArtifactSource = "url" | "ref";

export type GuidedSpecErrorCode =
  | "artifact_url_required"
  | "artifact_url_https"
  | "artifact_ref_required"
  | "artifact_sha256_required";

export type GuidedSpecResult =
  | { readonly ok: true; readonly value: ResourceShapeJsonObject }
  | { readonly ok: false; readonly code: GuidedSpecErrorCode };

export interface EdgeWorkerServiceForm {
  readonly name: string;
  readonly artifactSource: EdgeWorkerArtifactSource;
  readonly artifactUrl: string;
  readonly artifactRef: string;
  readonly artifactSha256: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: string;
  readonly profiles: string;
}

export interface ObjectBucketServiceForm {
  readonly name: string;
  readonly interfaces: string;
}

/**
 * Capability/profile fields are human-entered comma/newline lists. Tokens are
 * endpoint-defined, so the dashboard only normalizes whitespace and duplicates;
 * the Deploy API remains the schema/capability authority.
 */
export function parseResourceServiceTokens(text: string): readonly string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/u)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
}

export function buildEdgeWorkerServiceSpec(
  form: EdgeWorkerServiceForm,
): GuidedSpecResult {
  const artifactSha256 = form.artifactSha256.trim();
  if (!artifactSha256) {
    return { ok: false, code: "artifact_sha256_required" };
  }

  let source: ResourceShapeJsonObject;
  if (form.artifactSource === "url") {
    const artifactUrl = form.artifactUrl.trim();
    if (!artifactUrl) return { ok: false, code: "artifact_url_required" };
    if (!artifactUrl.startsWith("https://")) {
      return { ok: false, code: "artifact_url_https" };
    }
    source = { artifactUrl, artifactSha256 };
  } else {
    const artifactRef = form.artifactRef.trim();
    if (!artifactRef) return { ok: false, code: "artifact_ref_required" };
    source = { artifactRef, artifactSha256 };
  }

  return { ok: true, value: edgeWorkerSpec(form, source) };
}

/** Preserve a partially completed guided form when the user opts into raw JSON. */
export function draftEdgeWorkerServiceSpec(
  form: EdgeWorkerServiceForm,
): ResourceShapeJsonObject {
  const artifactSha256 = form.artifactSha256.trim();
  const artifactValue =
    form.artifactSource === "url"
      ? form.artifactUrl.trim()
      : form.artifactRef.trim();
  const sourceKey =
    form.artifactSource === "url" ? "artifactUrl" : "artifactRef";
  return edgeWorkerSpec(form, {
    ...(artifactValue ? { [sourceKey]: artifactValue } : {}),
    ...(artifactSha256 ? { artifactSha256 } : {}),
  });
}

export function buildObjectBucketServiceSpec(
  form: ObjectBucketServiceForm,
): ResourceShapeJsonObject {
  const interfaces = parseResourceServiceTokens(form.interfaces);
  return {
    name: form.name.trim(),
    ...(interfaces.length > 0 ? { interfaces: [...interfaces] } : {}),
  };
}

export function readEdgeWorkerServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): EdgeWorkerServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, [
      "name",
      "source",
      "compatibilityDate",
      "compatibilityFlags",
      "profiles",
    ]) ||
    spec.name !== resourceName ||
    !isJsonObject(spec.source) ||
    !hasOnlyKeys(spec.source, ["artifactUrl", "artifactRef", "artifactSha256"])
  ) {
    return undefined;
  }

  const artifactUrl = stringValue(spec.source.artifactUrl);
  const artifactRef = stringValue(spec.source.artifactRef);
  const artifactSha256 = stringValue(spec.source.artifactSha256);
  if (
    Boolean(artifactUrl) === Boolean(artifactRef) ||
    !artifactSha256 ||
    (artifactUrl !== undefined && !artifactUrl.startsWith("https://"))
  ) {
    return undefined;
  }

  const compatibilityDate = optionalString(spec.compatibilityDate);
  const compatibilityFlags = optionalStringArray(spec.compatibilityFlags);
  const profiles = optionalStringArray(spec.profiles);
  if (
    compatibilityDate === null ||
    compatibilityFlags === null ||
    profiles === null
  ) {
    return undefined;
  }

  return {
    name: resourceName,
    artifactSource: artifactUrl ? "url" : "ref",
    artifactUrl: artifactUrl ?? "",
    artifactRef: artifactRef ?? "",
    artifactSha256,
    compatibilityDate: compatibilityDate ?? "",
    compatibilityFlags: (compatibilityFlags ?? []).join("\n"),
    profiles: (profiles ?? []).join("\n"),
  };
}

export function readObjectBucketServiceForm(
  spec: ResourceShapeJsonObject,
  resourceName: string,
): ObjectBucketServiceForm | undefined {
  if (
    !hasOnlyKeys(spec, ["name", "interfaces"]) ||
    spec.name !== resourceName
  ) {
    return undefined;
  }
  const interfaces = optionalStringArray(spec.interfaces);
  if (interfaces === null) return undefined;
  return {
    name: resourceName,
    // Omission already means the server-side s3_api default. Keep omission
    // round-trippable instead of silently materializing that default on edit.
    interfaces: (interfaces ?? []).join("\n"),
  };
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isJsonObject(value: unknown): value is ResourceShapeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function optionalStringArray(
  value: unknown,
): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as readonly string[];
}

function edgeWorkerSpec(
  form: EdgeWorkerServiceForm,
  source: ResourceShapeJsonObject,
): ResourceShapeJsonObject {
  const compatibilityDate = form.compatibilityDate.trim();
  const compatibilityFlags = parseResourceServiceTokens(
    form.compatibilityFlags,
  );
  const profiles = parseResourceServiceTokens(form.profiles);
  return {
    name: form.name.trim(),
    source,
    ...(compatibilityDate ? { compatibilityDate } : {}),
    ...(compatibilityFlags.length > 0
      ? { compatibilityFlags: [...compatibilityFlags] }
      : {}),
    ...(profiles.length > 0 ? { profiles: [...profiles] } : {}),
  };
}
