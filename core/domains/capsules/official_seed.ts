/**
 * Seeds built-in shared InstallConfigs from the first-party module registry
 * (Core Specification §10 / §11). TemplateDefinitions stay the seed source of
 * truth; this derives a `trustLevel: "official"` InstallConfig per built-in
 * module so an Installation can reference a service-side config by id while the
 * generated root + repo-shipped sample child module remains the canonical
 * OpenTofu surface.
 *
 * Three seed shapes compose here:
 *   - The generic Capsule InstallConfig (`cfg-default-opentofu-capsule`) used by
 *     standard Git URL installs. It has no `templateBinding`.
 *   - The named official InstallConfig alias (`core`) for the Space base
 *     Capsule.
 *   - The per-template configs for every other built-in starter module
 *     (`cfg-official-<templateId>`, installType opentofu_module).
 *
 * The config id is stable so the upsert is idempotent across restarts.
 * `templateBinding` is an internal service-side seam; plan creation normalizes
 * the bundled module into generatedRoot.moduleFiles before runner dispatch.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import type {
  InstallConfig,
  InstallConfigCatalogInput,
  InstallConfigCatalogKind,
  InstallConfigCatalogMetadata,
  InstallConfigCatalogSurface,
  InstallConfigCatalogText,
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
export interface OfficialCatalogSource {
  readonly git: string;
  readonly ref: string;
}

export const TAKOSUMI_OFFICIAL_CATALOG_SOURCE: OfficialCatalogSource = {
  git: "https://github.com/tako0614/takosumi.git",
  ref: "fcc47907b0154d8bf53872a3336e5653fc88792e",
} as const;

export const RETIRED_OFFICIAL_INSTALL_CONFIG_IDS = [
  "cfg-official-talk",
  "cfg-official-files",
] as const;

export function isRetiredOfficialInstallConfigId(id: string): boolean {
  return RETIRED_OFFICIAL_INSTALL_CONFIG_IDS.some((retired) => retired === id);
}

/** The stable InstallConfig id derived from a config name (`cfg-official-<name>`). */
export function installConfigIdForName(name: string): string {
  return `cfg-official-${name}`;
}

/** The stable InstallConfig id derived from a template id. */
export function installConfigIdForTemplate(templateId: string): string {
  return installConfigIdForName(templateId);
}

/**
 * Named official InstallConfig aliases (spec §10 install types). `core` is the
 * only Takosumi built-in alias. Talk / Files stay Git-installed service
 * examples, not seeded InstallConfig aliases.
 */
interface NamedOfficialInstall {
  readonly name: string;
  readonly templateId: string;
  readonly installType: InstallType;
}

const NAMED_OFFICIAL_INSTALLS: readonly NamedOfficialInstall[] = [
  { name: "core", templateId: "core", installType: "core" },
];

function text(ja: string, en: string): InstallConfigCatalogText {
  return { ja, en };
}

interface OfficialCatalogSpec {
  readonly sourcePath: string;
  readonly order: number;
  readonly surface: InstallConfigCatalogSurface;
  readonly kind: InstallConfigCatalogKind;
  readonly provider: string;
  readonly suggestedName: string;
  readonly badge: InstallConfigCatalogText;
  readonly name: InstallConfigCatalogText;
  readonly description: InstallConfigCatalogText;
  readonly inputs: readonly InstallConfigCatalogInput[];
}

const OFFICIAL_CATALOG: Readonly<Record<string, OfficialCatalogSpec>> = {
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
  "cloudflare-r2-storage": {
    sourcePath: "providers/cloudflare/modules/cloudflare-r2-storage/module",
    order: 30,
    surface: "building_block",
    kind: "storage",
    provider: "cloudflare",
    suggestedName: "files",
    badge: text("ファイル保存", "File storage"),
    name: text("ファイル保存場所を作成", "Create file storage"),
    description: text(
      "ファイルやバックアップ用の保存場所を作ります。",
      "Creates storage for files or backups.",
    ),
    inputs: [
      {
        name: "bucketName",
        type: "string",
        required: true,
        defaultValue: "service-name-with-space",
        label: text("バケット名", "Bucket name"),
        helper: text(
          "同じ Cloudflare アカウント内で一意にしてください。",
          "Must be unique in the Cloudflare account.",
        ),
        placeholder: "my-files",
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
        name: "location",
        type: "string",
        label: text("保存場所（任意）", "Location hint (optional)"),
        helper: text(
          "指定しない場合は Cloudflare の標準設定を使います。",
          "Leave empty to use Cloudflare's default placement.",
        ),
        placeholder: "apac",
      },
    ],
  },
  "aws-s3-storage": {
    sourcePath: "providers/aws/modules/aws-s3-storage/module",
    order: 40,
    surface: "building_block",
    kind: "storage",
    provider: "aws",
    suggestedName: "files-aws",
    badge: text("ファイル保存", "File storage"),
    name: text("ファイル保存場所を作成", "Create file storage"),
    description: text(
      "アプリの保存先やバックアップに使えるファイル置き場を作ります。",
      "Creates storage for files, app data, or backups.",
    ),
    inputs: [
      {
        name: "bucketName",
        type: "string",
        required: true,
        defaultValue: "service-name-with-space",
        label: text("バケット名", "Bucket name"),
        helper: text(
          "S3 bucket 名はグローバルに一意である必要があります。",
          "S3 bucket names must be globally unique.",
        ),
        placeholder: "my-files",
      },
      {
        name: "region",
        type: "string",
        defaultValue: "us-east-1",
        label: text("リージョン", "Region"),
        placeholder: "us-east-1",
      },
    ],
  },
};

function catalogMetadataForTemplate(
  template: TemplateDefinition,
  source: OfficialCatalogSource = TAKOSUMI_OFFICIAL_CATALOG_SOURCE,
): InstallConfigCatalogMetadata | undefined {
  const spec = OFFICIAL_CATALOG[template.id];
  if (!spec) return undefined;
  return {
    templateId: template.id,
    templateVersion: template.version,
    source: {
      git: source.git,
      ref: source.ref,
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
    inputs: spec.inputs,
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
    url: { from: "url", type: "url" },
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
    readonly officialCatalogSource?: OfficialCatalogSource;
  } = {},
): InstallConfig {
  const catalog = catalogMetadataForTemplate(
    template,
    options.officialCatalogSource,
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
    ...(catalog ? { catalog } : {}),
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
 * default, the named official alias (`core`), plus a per-template config for
 * every OTHER first-party starter module. A template already bound by a named
 * alias does NOT also get a generic `cfg-official-<templateId>` config (avoids
 * two configs over the same module surface).
 */
export function officialInstallConfigs(
  options: {
    readonly registry?: TemplateRegistry;
    readonly now?: () => Date;
    readonly officialCatalogSource?: OfficialCatalogSource;
  } = {},
): readonly InstallConfig[] {
  const registry = options.registry ?? defaultTemplateRegistry;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const configs: InstallConfig[] = [defaultCapsuleInstallConfig(nowIso)];
  const boundTemplateIds = new Set<string>();
  for (const named of NAMED_OFFICIAL_INSTALLS) {
    const template = registry.list().find((t) => t.id === named.templateId);
    if (!template) continue;
    configs.push(
      installConfigFromTemplate(template, nowIso, {
        id: installConfigIdForName(named.name),
        name: named.name,
        installType: named.installType,
        officialCatalogSource: options.officialCatalogSource,
      }),
    );
    boundTemplateIds.add(template.id);
  }
  for (const template of registry.list()) {
    if (boundTemplateIds.has(template.id)) continue;
    configs.push(
      installConfigFromTemplate(template, nowIso, {
        officialCatalogSource: options.officialCatalogSource,
      }),
    );
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
    readonly officialCatalogSource?: OfficialCatalogSource;
  } = {},
): Promise<void> {
  for (const config of officialInstallConfigs(options)) {
    await store.putInstallConfig(config);
  }
}
