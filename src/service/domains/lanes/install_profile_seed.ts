/**
 * Seeds the official InstallProfile catalog from the built-in template registry
 * (Core Specification §6.6). Templates remain the seed source of truth; this
 * derives a `trustLevel: "official"` InstallProfile per template so the App /
 * Environment lane can reference an InstallProfile by id while the template
 * catalog stays the canonical OpenTofu surface.
 */

import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";
import type {
  InstallProfile,
  InstallProfileOutputProjection,
} from "takosumi-contract/lanes";
import {
  defaultTemplateRegistry,
  type TemplateRegistry,
} from "../templates/mod.ts";

/** The stable InstallProfile id derived from a template id+version. */
export function installProfileIdForTemplate(
  templateId: string,
  templateVersion: string,
): string {
  return `profile_tpl_${templateId}_${templateVersion}`.replace(
    /[^a-zA-Z0-9_]/g,
    "_",
  );
}

/** The policy id an official template profile references (stable, template-scoped). */
function templatePolicyId(templateId: string, templateVersion: string): string {
  return `policy_tpl_${templateId}_${templateVersion}`.replace(
    /[^a-zA-Z0-9_]/g,
    "_",
  );
}

function outputAllowlistFromTemplate(
  template: TemplateDefinition,
): Readonly<Record<string, InstallProfileOutputProjection>> {
  const out: Record<string, InstallProfileOutputProjection> = {};
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    out[name] = {
      from: spec.from,
      // Template public outputs declare an OpenTofu type hint ("string", "url",
      // ...). Narrow to the InstallProfile projection vocabulary, defaulting to
      // "string" for an unrecognized hint.
      type: normalizeProjectionType(spec.type),
    };
  }
  return out;
}

function normalizeProjectionType(
  hint: string,
): InstallProfileOutputProjection["type"] {
  switch (hint) {
    case "url":
    case "hostname":
    case "number":
    case "boolean":
    case "json":
    case "string":
      return hint;
    default:
      return "string";
  }
}

/** Builds the official InstallProfile for one template. */
export function installProfileFromTemplate(
  template: TemplateDefinition,
  now: string,
): InstallProfile {
  return {
    id: installProfileIdForTemplate(template.id, template.version),
    name: template.name,
    // Official templates produce a Takosumi-generated root module wrapping the
    // template's child module — the opentofu_module install type.
    installType: "opentofu_module",
    trustLevel: "official",
    ...(template.build
      ? {
        build: {
          enabled: true,
          commands: [...template.build.commands],
          artifactPath: template.build.artifactPath,
        },
      }
      : {}),
    variableMapping: {},
    outputAllowlist: outputAllowlistFromTemplate(template),
    policyId: templatePolicyId(template.id, template.version),
    templateBinding: {
      templateId: template.id,
      templateVersion: template.version,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Derives the full official InstallProfile set from the template registry. */
export function officialInstallProfiles(
  options: {
    readonly registry?: TemplateRegistry;
    readonly now?: () => Date;
  } = {},
): readonly InstallProfile[] {
  const registry = options.registry ?? defaultTemplateRegistry;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  return registry.list().map((template) =>
    installProfileFromTemplate(template, nowIso)
  );
}
