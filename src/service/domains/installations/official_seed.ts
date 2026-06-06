/**
 * Seeds the official InstallConfig catalog from the built-in template registry
 * (Core Specification §11). Templates stay the seed source of truth; this
 * derives a `trustLevel: "official"` InstallConfig per template so an
 * Installation can reference a service-side config by id while the template
 * catalog remains the canonical OpenTofu surface.
 *
 * The config id is derived from the template id (`cfg-official-<templateId>`)
 * so the upsert is idempotent across restarts. The `templateBinding` is the
 * internal seam pointing back at the rootgen module baked into the runner image.
 */

import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";
import type {
  InstallConfig,
  OutputAllowlistEntry,
  PolicyConfig,
} from "takosumi-contract/installations";
import {
  defaultTemplateRegistry,
  type TemplateRegistry,
} from "../templates/mod.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

/** The stable InstallConfig id derived from a template id. */
export function installConfigIdForTemplate(templateId: string): string {
  return `cfg-official-${templateId}`;
}

/** Projects a template's public outputs into the InstallConfig outputAllowlist. */
function outputAllowlistFromTemplate(
  template: TemplateDefinition,
): Readonly<Record<string, OutputAllowlistEntry>> {
  const out: Record<string, OutputAllowlistEntry> = {};
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    // Template public outputs carry a free-form OpenTofu type hint; the
    // InstallConfig output projection vocabulary is narrower, so the seed pins
    // every entry to "string" until the install types land (conformance M5).
    out[name] = { from: spec.from, type: "string" };
  }
  return out;
}

/** Projects a template's policy spec into the InstallConfig policy. */
function policyFromTemplate(template: TemplateDefinition): PolicyConfig {
  return {
    allowedProviders: [...template.policy.allowedProviders],
    allowedResourceTypes: [...template.policy.allowedResourceTypes],
    destructiveChanges: {
      requireExplicitConfirmation:
        template.policy.destructiveChanges.requireExplicitConfirmation,
    },
  };
}

/** Builds the official InstallConfig for one template. */
export function installConfigFromTemplate(
  template: TemplateDefinition,
  now: string,
): InstallConfig {
  return {
    id: installConfigIdForTemplate(template.id),
    name: template.id,
    // Official templates produce a Takosumi-generated root module wrapping the
    // template's child module — the opentofu_module install type.
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: outputAllowlistFromTemplate(template),
    policy: policyFromTemplate(template),
    templateBinding: {
      templateId: template.id,
      templateVersion: template.version,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Derives the full official InstallConfig set from the template registry. */
export function officialInstallConfigs(
  options: {
    readonly registry?: TemplateRegistry;
    readonly now?: () => Date;
  } = {},
): readonly InstallConfig[] {
  const registry = options.registry ?? defaultTemplateRegistry;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  return registry.list().map((template) =>
    installConfigFromTemplate(template, nowIso)
  );
}

/**
 * Seeds the official InstallConfig catalog into the shared ledger. The config id
 * is derived from the template id so the upsert is idempotent across restarts.
 */
export async function seedOfficialInstallConfigs(
  store: OpenTofuDeploymentStore,
  options: {
    readonly registry?: TemplateRegistry;
    readonly now?: () => Date;
  } = {},
): Promise<void> {
  for (const config of officialInstallConfigs(options)) {
    await store.putInstallConfig(config);
  }
}
