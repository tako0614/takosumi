import type {
  JsonObject,
  ManifestEnvelopeIssue,
  ManifestResource,
  Template,
  TemplateValidationIssue,
} from "takosumi-contract";
import {
  formatTemplateRef,
  getTemplateByRef,
  listTemplates,
  parseTemplateRef,
  validateManifestEnvelope,
} from "takosumi-contract";

export interface ManifestV1ResolveOptions {
  /**
   * Optional closed template set. CLI local mode passes the bundled templates
   * here so expansion does not depend on global registry state. Kernel remote
   * mode omits it and resolves through the registered template registry.
   */
  readonly templates?: readonly Template[];
  /**
   * CLI compatibility: allow `template.name` and bare ids in
   * `template.template`. Remote kernel manifests should use pinned
   * `id@version` refs.
   */
  readonly allowTemplateName?: boolean;
  /**
   * Backward compatibility for early public-route clients that used
   * `template.ref`. Canonical v1 manifests use `template.template`.
   */
  readonly allowLegacyTemplateRef?: boolean;
}

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
  options: ManifestV1ResolveOptions = {},
): ManifestV1Resolution {
  if (!isJsonObject(manifest)) {
    return { ok: false, error: "manifest must be a JSON object" };
  }

  const envelopeIssues: ManifestEnvelopeIssue[] = [];
  validateManifestEnvelope(manifest, envelopeIssues, {
    allowLegacyTemplateRef: options.allowLegacyTemplateRef,
    allowTemplateName: options.allowTemplateName,
  });
  if (envelopeIssues.length > 0) {
    return {
      ok: false,
      error: envelopeIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; "),
    };
  }

  const resources: ManifestResource[] = [];
  const hasTemplate = manifest.template !== undefined;
  const hasResources = manifest.resources !== undefined;

  if (!hasTemplate && !hasResources) {
    return {
      ok: false,
      error:
        "manifest.resources[] or manifest.template is required. Available " +
        `templates: ${
          availableTemplateRefs(options.templates).join(", ") || "(none)"
        }`,
    };
  }

  if (hasTemplate) {
    const expanded = expandTemplateInvocation(manifest.template, options);
    if (!expanded.ok) return expanded;
    resources.push(...expanded.value);
  }

  if (hasResources) {
    const explicit = readResourcesArray(manifest.resources);
    if (!explicit.ok) return explicit;
    resources.push(...explicit.value);
  }

  if (resources.length === 0) {
    return {
      ok: false,
      error:
        "manifest expands to zero resources; specify at least one resource " +
        "or a template that expands to resources",
    };
  }

  return { ok: true, value: resources };
}

export function expandManifestResourcesV1(
  manifest: unknown,
  options: ManifestV1ResolveOptions = {},
): readonly ManifestResource[] {
  const result = resolveManifestResourcesV1(manifest, options);
  if (!result.ok) throw new ManifestV1ResolutionError(result.error);
  return result.value;
}

/**
 * Stable deployment name extraction shared by CLI-facing kernel routes.
 *
 * Preference order:
 *   1. `metadata.name`
 *   2. legacy top-level `name`
 *   3. deterministic hash of the resolved resource identities
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
  const name = manifest.name;
  if (typeof name === "string" && name.length > 0) return name;
  return `unnamed-${fallbackResourceHash(resources)}`;
}

function expandTemplateInvocation(
  candidate: unknown,
  options: ManifestV1ResolveOptions,
): ManifestV1Resolution {
  if (!isJsonObject(candidate)) {
    return { ok: false, error: "manifest.template must be a JSON object" };
  }

  const requested = readTemplateRequest(candidate, options);
  if (!requested.ok) return requested;

  const inputsRaw = candidate.inputs ?? {};
  if (!isJsonObject(inputsRaw)) {
    return {
      ok: false,
      error: "manifest.template.inputs must be a JSON object",
    };
  }

  const found = resolveTemplate(requested.value, options);
  if (!found.ok) return found;

  const issues: TemplateValidationIssue[] = [];
  found.value.validateInputs(inputsRaw, issues);
  if (issues.length > 0) {
    const formatted = issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      error: `manifest.template.inputs invalid for ${requested.value.raw}: ` +
        formatted,
    };
  }

  try {
    return { ok: true, value: found.value.expand(inputsRaw) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error:
        `manifest.template ${requested.value.raw} expansion failed: ${message}`,
    };
  }
}

type TemplateRequest =
  | {
    readonly mode: "ref";
    readonly raw: string;
  }
  | {
    readonly mode: "id";
    readonly raw: string;
  };

function readTemplateRequest(
  invocation: JsonObject,
  options: ManifestV1ResolveOptions,
):
  | { readonly ok: true; readonly value: TemplateRequest }
  | { readonly ok: false; readonly error: string } {
  const canonical = readNonEmptyString(invocation.template);
  const legacy = readNonEmptyString(invocation.ref);
  const allowLegacy = options.allowLegacyTemplateRef !== false;

  if (canonical && legacy && canonical !== legacy) {
    return {
      ok: false,
      error: "manifest.template.template and manifest.template.ref conflict; " +
        "use canonical manifest.template.template",
    };
  }

  const ref = canonical ?? (allowLegacy ? legacy : undefined);
  if (ref) {
    if (parseTemplateRef(ref)) {
      return { ok: true, value: { mode: "ref", raw: ref } };
    }
    if (options.allowTemplateName === true) {
      return { ok: true, value: { mode: "id", raw: ref } };
    }
    return {
      ok: false,
      error: "manifest.template.template must be a non-empty id@version string",
    };
  }

  if (legacy && !allowLegacy) {
    return {
      ok: false,
      error: "manifest.template.ref is legacy; use manifest.template.template",
    };
  }

  const name = readNonEmptyString(invocation.name);
  if (name && options.allowTemplateName === true) {
    return { ok: true, value: { mode: "id", raw: name } };
  }

  return {
    ok: false,
    error: options.allowTemplateName === true
      ? "manifest.template.template, manifest.template.ref, or manifest.template.name must be a non-empty string"
      : "manifest.template.template must be a non-empty id@version string",
  };
}

function resolveTemplate(
  request: TemplateRequest,
  options: ManifestV1ResolveOptions,
):
  | { readonly ok: true; readonly value: Template }
  | { readonly ok: false; readonly error: string } {
  const templates = options.templates;
  const found = request.mode === "ref"
    ? findTemplateByRef(request.raw, templates)
    : findTemplateById(request.raw, templates);
  if (found) return { ok: true, value: found };

  return {
    ok: false,
    error: `manifest.template ${request.raw} is not registered. Available ` +
      `templates: ${availableTemplateRefs(templates).join(", ") || "(none)"}`,
  };
}

function findTemplateByRef(
  ref: string,
  templates: readonly Template[] | undefined,
): Template | undefined {
  const parsed = parseTemplateRef(ref);
  if (!parsed) return undefined;
  if (!templates) return getTemplateByRef(ref);
  return templates.find((template) =>
    template.id === parsed.id && template.version === parsed.version
  );
}

function findTemplateById(
  id: string,
  templates: readonly Template[] | undefined,
): Template | undefined {
  const available = templates ?? listTemplates();
  return available.find((template) => template.id === id);
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
    if (typeof entry.provider !== "string" || entry.provider.length === 0) {
      return {
        ok: false,
        error:
          `manifest.resources[${index}].provider must be a non-empty string`,
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

function availableTemplateRefs(
  templates: readonly Template[] | undefined,
): readonly string[] {
  const available = templates ?? listTemplates();
  return available.map((template) =>
    formatTemplateRef(template.id, template.version)
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
      `${resource.shape}|${resource.name}|${resource.provider}`
    )
    .join(";");
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash) ^ seed.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
