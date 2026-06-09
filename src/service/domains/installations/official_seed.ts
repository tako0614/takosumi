/**
 * Seeds built-in shared InstallConfigs from the first-party module registry
 * (Core Specification §10 / §11). TemplateDefinitions stay the seed source of
 * truth; this derives a `trustLevel: "official"` InstallConfig per built-in
 * module so an Installation can reference a service-side config by id while the
 * generated root + repo-shipped sample child module remains the canonical
 * OpenTofu surface.
 *
 * Two seed shapes compose here:
 *   - The named official InstallConfig aliases (`core` / `talk` / `files`) —
 *     user-facing convenience config names over the first-party module catalog.
 *     `core` maps to the `core` module, while `talk` and `files` map to
 *     runnable generic modules (`cloudflare-worker-service` and
 *     `cloudflare-r2-storage`) with stable friendly ids
 *     (`cfg-official-core` / `cfg-official-talk` / `cfg-official-files`).
 *   - The GENERIC per-template configs for every other built-in module
 *     (`cfg-official-<templateId>`, installType opentofu_module).
 *
 * The config id is stable so the upsert is idempotent across restarts.
 * `templateBinding` is an internal service-side seam; plan creation normalizes
 * the bundled module into generatedRoot.moduleFiles before runner dispatch.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import type {
  InstallConfig,
  InstallType,
  OutputAllowlistEntry,
  PolicyConfig,
} from "takosumi-contract/installations";
import {
  defaultTemplateRegistry,
  type TemplateRegistry,
} from "../templates/mod.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

/** The stable InstallConfig id derived from a config name (`cfg-official-<name>`). */
export function installConfigIdForName(name: string): string {
  return `cfg-official-${name}`;
}

/** The stable InstallConfig id derived from a template id. */
export function installConfigIdForTemplate(templateId: string): string {
  return installConfigIdForName(templateId);
}

/**
 * Named official InstallConfig aliases (spec §10 install types). Each binds a
 * first-party module by id and pins the §10 install type the product uses
 * (core for the base installation, opentofu_module for the deploy-module
 * aliases). The friendly name is both the InstallConfig name and the id suffix.
 */
interface NamedOfficialInstall {
  readonly name: string;
  readonly templateId: string;
  readonly installType: InstallType;
}

const NAMED_OFFICIAL_INSTALLS: readonly NamedOfficialInstall[] = [
  { name: "core", templateId: "core", installType: "core" },
  {
    name: "talk",
    templateId: "cloudflare-worker-service",
    installType: "opentofu_module",
  },
  {
    name: "files",
    templateId: "cloudflare-r2-storage",
    installType: "opentofu_module",
  },
];

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

/**
 * Builds an official InstallConfig binding `template` under the given `name` /
 * `id` / §10 install type. `installType` defaults to `opentofu_module` (the
 * generic per-template shape: a Takosumi-generated root wraps the template's
 * child module); the named `core` install pins `core`.
 */
export function installConfigFromTemplate(
  template: TemplateDefinition,
  now: string,
  options: {
    readonly id?: string;
    readonly name?: string;
    readonly installType?: InstallType;
  } = {},
): InstallConfig {
  return {
    id: options.id ?? installConfigIdForTemplate(template.id),
    name: options.name ?? template.id,
    installType: options.installType ?? "opentofu_module",
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

/**
 * Derives the full built-in shared InstallConfig set: the named official
 * aliases (`core` / `talk` / `files`) plus a generic per-template config for
 * every OTHER first-party module. A template already bound by a named alias
 * does NOT also get a generic `cfg-official-<templateId>` config (avoids two
 * configs over the same module surface).
 */
export function officialInstallConfigs(
  options: {
    readonly registry?: TemplateRegistry;
    readonly now?: () => Date;
  } = {},
): readonly InstallConfig[] {
  const registry = options.registry ?? defaultTemplateRegistry;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const configs: InstallConfig[] = [];
  const boundTemplateIds = new Set<string>();
  for (const named of NAMED_OFFICIAL_INSTALLS) {
    const template = registry.list().find((t) => t.id === named.templateId);
    if (!template) continue;
    configs.push(installConfigFromTemplate(template, nowIso, {
      id: installConfigIdForName(named.name),
      name: named.name,
      installType: named.installType,
    }));
    boundTemplateIds.add(template.id);
  }
  for (const template of registry.list()) {
    if (boundTemplateIds.has(template.id)) continue;
    configs.push(installConfigFromTemplate(template, nowIso));
  }
  return configs;
}

/**
 * Seeds built-in shared InstallConfigs into the shared ledger. The config id is
 * derived from the template id so the upsert is idempotent across restarts.
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
