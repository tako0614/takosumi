/**
 * Bootstraps shared InstallConfigs from the template module registry
 * (Core Specification §10 / §11). TemplateDefinitions stay the template source of
 * truth; this derives a `trustLevel: "official"` InstallConfig per first-party
 * module so an Installation can reference a service-side config by id while the
 * generated root + repo-shipped sample child module remains the canonical
 * OpenTofu surface.
 *
 * Three shared config shapes compose here:
 *   - The generic Capsule InstallConfig (`cfg-default-opentofu-capsule`) used by
 *     standard Git URL installs. It has no `templateBinding`.
 *   - The named built-in InstallConfig alias (`core`) for the Space base
 *     Capsule.
 *   - The per-template configs for every other built-in template module
 *     (`cfg-built-in-<templateId>`, installType opentofu_module).
 *
 * The config id is stable so the upsert is idempotent across restarts.
 * `templateBinding` is an internal service-side seam; plan creation normalizes
 * the embedded template module into generatedRoot.moduleFiles before runner dispatch.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import type {
  InstallConfig,
  InstallConfigStoreInput,
  InstallConfigInstallExperience,
  InstallConfigStoreKind,
  InstallConfigStoreMetadata,
  InstallConfigStoreSurface,
  InstallConfigStoreText,
  InstallType,
  OutputAllowlistEntry,
  PolicyConfig,
} from "takosumi-contract/install-configs";
import {
  defaultTemplateRegistry,
  type TemplateRegistry,
} from "../templates/mod.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

export const DEFAULT_CAPSULE_INSTALL_CONFIG_ID = "cfg-default-opentofu-capsule";
export interface BuiltInStoreSource {
  readonly git: string;
}

export const TAKOSUMI_BUILT_IN_STORE_SOURCE: BuiltInStoreSource = {
  git: "https://github.com/tako0614/takosumi.git",
} as const;

export const RETIRED_BUILT_IN_INSTALL_CONFIG_IDS = [
  "cfg-built-in-talk",
  "cfg-built-in-files",
  "cfg-catalog-yurucommu",
  "cfg-catalog-takos-office",
  "cfg-catalog-takos-storage",
  "cfg-catalog-takos-git",
  "cfg-catalog-takos",
] as const;

export function isRetiredBuiltInInstallConfigId(id: string): boolean {
  return RETIRED_BUILT_IN_INSTALL_CONFIG_IDS.some((retired) => retired === id);
}

/** The stable InstallConfig id derived from a config name (`cfg-built-in-<name>`). */
export function installConfigIdForName(name: string): string {
  return `cfg-built-in-${name}`;
}

/** The stable InstallConfig id derived from a template id. */
export function installConfigIdForTemplate(templateId: string): string {
  return installConfigIdForName(templateId);
}

/**
 * Named built-in InstallConfig aliases (spec §10 install types). `core` is the
 * only Takosumi built-in alias. Talk / Files stay Git-installed service
 * examples, not seeded InstallConfig aliases.
 */
interface NamedBuiltInInstall {
  readonly name: string;
  readonly templateId: string;
  readonly installType: InstallType;
}

const NAMED_BUILT_IN_INSTALLS: readonly NamedBuiltInInstall[] = [
  { name: "core", templateId: "core", installType: "core" },
];

function text(ja: string, en: string): InstallConfigStoreText {
  return { ja, en };
}

interface BuiltInStoreSpec {
  readonly sourcePath: string;
  readonly order: number;
  readonly surface: InstallConfigStoreSurface;
  readonly kind: InstallConfigStoreKind;
  readonly provider: string;
  readonly suggestedName: string;
  readonly badge: InstallConfigStoreText;
  readonly name: InstallConfigStoreText;
  readonly description: InstallConfigStoreText;
  readonly iconUrl?: string;
  readonly inputs: readonly InstallConfigStoreInput[];
  readonly installExperience?: InstallConfigInstallExperience;
}

const BUILT_IN_STORE: Readonly<Record<string, BuiltInStoreSpec>> = {
  "cloudflare-hello-worker": {
    sourcePath: "providers/cloudflare/modules/cloudflare-hello-worker/module",
    order: 10,
    surface: "service",
    kind: "worker",
    provider: "cloudflare",
    suggestedName: "web-app",
    badge: text("Webアプリ", "Web app"),
    name: text("Webアプリを公開", "Publish a web app"),
    description: text(
      "ブラウザで開けるWebアプリと公開URLを用意します。",
      "Creates a browser-openable web app with a public URL.",
    ),
    inputs: [
      {
        name: "appName",
        type: "string",
        required: true,
        defaultValue: "service-name-with-space",
        label: text("公開名", "Public name"),
        helper: text(
          "公開URLにも使われる名前です。",
          "Also used in the public URL.",
        ),
        placeholder: "hello-worker",
      },
      {
        name: "accountId",
        type: "string",
        required: true,
        label: text("Cloudflare アカウント", "Cloudflare account"),
        helper: text(
          "接続済みアカウントから分かる場合は自動入力されます。手入力する場合は Cloudflare のアカウント ID を使います。",
          "Filled automatically when a connected account provides it. If entering it manually, use the Cloudflare account ID.",
        ),
        placeholder: "0123abcd...",
      },
      {
        name: "workersSubdomain",
        type: "string",
        required: true,
        label: text("公開サブドメイン", "Public subdomain"),
        helper: text(
          "公開URLの先頭部分です。例: my-team",
          "The first part of the public URL, for example: my-team.",
        ),
        placeholder: "my-team",
      },
    ],
  },
};

/**
 * Historical repository Store entries are hidden from selectors. Existing
 * stored rows can still be read for old Capsules, but Takosumi no longer seeds
 * app-specific Git repo presentation as built-in InstallConfigs.
 */
export const NONSELECTABLE_REPOSITORY_STORE_INSTALL_CONFIG_IDS = [
  "cfg-catalog-yurucommu",
  "cfg-catalog-takos-office",
  "cfg-catalog-takos-storage",
  "cfg-catalog-takos-git",
  "cfg-catalog-takos",
  "cfg-store-yurucommu",
  "cfg-store-takos-office",
  "cfg-store-takos-storage",
  "cfg-store-takos-git",
  "cfg-store-takos",
] as const;

export function isNonselectableRepositoryStoreInstallConfigId(
  id: string,
): boolean {
  return NONSELECTABLE_REPOSITORY_STORE_INSTALL_CONFIG_IDS.some(
    (nonselectable) => nonselectable === id,
  );
}

function storeMetadataForTemplate(
  template: TemplateDefinition,
  source: BuiltInStoreSource = TAKOSUMI_BUILT_IN_STORE_SOURCE,
): InstallConfigStoreMetadata | undefined {
  const spec = BUILT_IN_STORE[template.id];
  if (!spec) return undefined;
  return {
    templateId: template.id,
    templateVersion: template.version,
    source: {
      git: source.git,
      path: spec.sourcePath,
    },
    order: spec.order,
    surface: spec.surface,
    kind: spec.kind,
    provider: spec.provider,
    suggestedName: spec.suggestedName,
    badge: spec.badge,
    name: spec.name,
    description: spec.description,
    ...(spec.iconUrl ? { iconUrl: spec.iconUrl } : {}),
    inputs: spec.inputs,
    ...(spec.installExperience
      ? { installExperience: spec.installExperience }
      : {}),
  };
}

function defaultCapsuleInstallConfig(now: string): InstallConfig {
  return {
    id: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    name: "opentofu-capsule",
    sourceKind: "generic_capsule",
    installType: "opentofu_module",
    trustLevel: "trusted",
    variableMapping: {},
    outputAllowlist: defaultCapsuleOutputAllowlist(),
    policy: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function defaultCapsuleOutputAllowlist(): Readonly<
  Record<string, OutputAllowlistEntry>
> {
  return {
    // Plain Git URL installs are generic OpenTofu/Terraform Capsules. If a
    // module emits the common app-launch outputs, surface them without requiring
    // every arbitrary module to define them.
    launch_url: { from: "launch_url", type: "url" },
    url: { from: "url", type: "url" },
    public_url: { from: "public_url", type: "url" },
    api_url: { from: "api_url", type: "url" },
    app_deployment: { from: "app_deployment", type: "json" },
    service_exports: { from: "service_exports", type: "json" },
    worker_name: { from: "worker_name", type: "string" },
  };
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

/**
 * Builds a built-in InstallConfig binding `template` under the given `name` /
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
    readonly builtInStoreSource?: BuiltInStoreSource;
  } = {},
): InstallConfig {
  const storeMetadata = storeMetadataForTemplate(
    template,
    options.builtInStoreSource,
  );
  return {
    id: options.id ?? installConfigIdForTemplate(template.id),
    name: options.name ?? template.id,
    sourceKind: "first_party_capsule",
    installType: options.installType ?? "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: outputAllowlistFromTemplate(template),
    policy: policyFromTemplate(template),
    ...(storeMetadata ? { store: storeMetadata } : {}),
    templateBinding: {
      templateId: template.id,
      templateVersion: template.version,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Derives the full built-in shared InstallConfig set: the generic Capsule
 * default, the named built-in alias (`core`), plus a per-template config for
 * every OTHER built-in template module. A template already bound by a named
 * alias does NOT also get a generic `cfg-built-in-<templateId>` config (avoids
 * two configs over the same module surface).
 */
export function builtInInstallConfigs(
  options: {
    readonly registry?: TemplateRegistry;
    readonly now?: () => Date;
    readonly builtInStoreSource?: BuiltInStoreSource;
  } = {},
): readonly InstallConfig[] {
  const registry = options.registry ?? defaultTemplateRegistry;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const configs: InstallConfig[] = [defaultCapsuleInstallConfig(nowIso)];
  const boundTemplateIds = new Set<string>();
  for (const named of NAMED_BUILT_IN_INSTALLS) {
    const template = registry.list().find((t) => t.id === named.templateId);
    if (!template) continue;
    configs.push(
      installConfigFromTemplate(template, nowIso, {
        id: installConfigIdForName(named.name),
        name: named.name,
        installType: named.installType,
        builtInStoreSource: options.builtInStoreSource,
      }),
    );
    boundTemplateIds.add(template.id);
  }
  for (const template of registry.list()) {
    if (boundTemplateIds.has(template.id)) continue;
    configs.push(
      installConfigFromTemplate(template, nowIso, {
        builtInStoreSource: options.builtInStoreSource,
      }),
    );
  }
  return configs;
}

/**
 * Bootstraps shared InstallConfigs into the shared ledger. The config id is
 * derived from the template id so the upsert is idempotent across restarts.
 */
export async function bootstrapInstallConfigs(
  store: OpenTofuDeploymentStore,
  options: {
    readonly registry?: TemplateRegistry;
    readonly now?: () => Date;
    readonly builtInStoreSource?: BuiltInStoreSource;
  } = {},
): Promise<void> {
  for (const config of builtInInstallConfigs(options)) {
    await store.putInstallConfig(config);
  }
}
