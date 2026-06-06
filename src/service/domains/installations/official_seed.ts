/**
 * Seeds the official InstallConfig catalog from the built-in template registry
 * (Core Specification §10 / §11). Templates stay the seed source of truth; this
 * derives a `trustLevel: "official"` InstallConfig per template so an
 * Installation can reference a service-side config by id while the template
 * catalog remains the canonical OpenTofu surface.
 *
 * Two seed shapes compose here:
 *   - The three NAMED first-party installs (`core` / `talk` / `files`) — the
 *     user-facing convenience names with the §10 install type the product wires
 *     (core install type for `core`, opentofu_module for the deploy-module ones)
 *     and stable friendly ids (`cfg-official-core` / `cfg-official-talk` /
 *     `cfg-official-files`).
 *   - The GENERIC per-template configs for every other catalog template
 *     (`cfg-official-<templateId>`, installType opentofu_module).
 *
 * The config id is stable so the upsert is idempotent across restarts. The
 * `templateBinding` is the internal seam pointing back at the rootgen module
 * baked into the runner image.
 */

import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";
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
 * The three named first-party installs (spec §10 install types). Each binds a
 * catalog template by id and pins the §10 install type the product uses (core
 * for the base installation, opentofu_module for the deploy-module ones). The
 * friendly name is both the InstallConfig name and the id suffix.
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
 * Derives the full official InstallConfig set: the three named first-party
 * installs (`core` / `talk` / `files`) plus a generic per-template config for
 * every OTHER catalog template. A template already bound by a named install does
 * NOT also get a generic `cfg-official-<templateId>` config (avoids two configs
 * over the same template surface).
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
