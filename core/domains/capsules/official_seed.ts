/**
 * Seeds built-in shared InstallConfigs from the template module registry
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
 *   - The per-template configs for every other built-in template module
 *     (`cfg-official-<templateId>`, installType opentofu_module).
 *
 * The config id is stable so the upsert is idempotent across restarts.
 * `templateBinding` is an internal service-side seam; plan creation normalizes
 * the embedded template module into generatedRoot.moduleFiles before runner dispatch.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import type {
  InstallConfig,
  InstallConfigCatalogInput,
  InstallConfigInstallExperience,
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
  readonly iconUrl?: string;
  readonly inputs: readonly InstallConfigCatalogInput[];
  readonly installExperience?: InstallConfigInstallExperience;
}

interface CuratedGitCatalogSpec {
  readonly id: string;
  readonly name: string;
  readonly source: {
    readonly git: string;
    readonly ref: string;
    readonly path: string;
  };
  readonly order: number;
  readonly surface: InstallConfigCatalogSurface;
  readonly kind: InstallConfigCatalogKind;
  readonly provider: string;
  readonly suggestedName: string;
  readonly badge: InstallConfigCatalogText;
  readonly displayName: InstallConfigCatalogText;
  readonly description: InstallConfigCatalogText;
  readonly iconUrl?: string;
  readonly inputs: readonly InstallConfigCatalogInput[];
  readonly installExperience?: InstallConfigInstallExperience;
  readonly outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>;
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
};

const CURATED_GIT_CATALOG: readonly CuratedGitCatalogSpec[] = [
  {
    id: "cfg-catalog-yurucommu",
    name: "yurucommu",
    source: {
      git: "https://github.com/tako0614/yurucommu.git",
      ref: "de0c72f3741c3f2bed633c7dd995fa412d5074c2",
      path: ".",
    },
    order: 100,
    surface: "service",
    kind: "worker",
    provider: "cloudflare",
    suggestedName: "yurucommu",
    badge: text("追加候補", "Installable"),
    displayName: text("yurucommu", "yurucommu"),
    description: text(
      "自分用のコミュニティ / ActivityPub アプリをホストします。",
      "Host a personal community / ActivityPub app.",
    ),
    iconUrl:
      "https://raw.githubusercontent.com/tako0614/yurucommu/de0c72f3741c3f2bed633c7dd995fa412d5074c2/public/icons/yurucommu.svg",
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text("サービス名", "Service name"),
      },
      {
        name: "worker_name",
        type: "string",
        label: text("公開サブドメイン", "Public subdomain"),
        helper: text(
          "空欄ならサービス名から自動で決めます。入力すると <subdomain>.app.takos.jp として使われます。",
          "Leave empty to derive it from the service name. When set, it is used as <subdomain>.app.takos.jp.",
        ),
        placeholder: "my-community",
      },
      {
        name: "app_url",
        type: "string",
        advanced: true,
        label: text("独自URL", "Custom URL"),
        helper: text(
          "独自ドメインを使う場合だけ https:// から入力します。空欄なら公開サブドメインから app.takos.jp のURLを使います。",
          "Enter an https:// URL only for a custom domain. Leave empty to use the app.takos.jp URL from the public subdomain.",
        ),
        placeholder: "https://my-app.app.takos.jp",
      },
      {
        name: "auth_password_hash",
        type: "string",
        advanced: true,
        secret: true,
        label: text("初期パスワード", "Initial password"),
        helper: text(
          "通常はTakosumi Accountsで自動ログインします。OIDCを使わない時だけ、一時パスワード/tokenまたはPBKDF2 hashを入力します。",
          "Takosumi Accounts signs in automatically by default. Enter a temporary password/token or PBKDF2 hash only when you do not use OIDC.",
        ),
        placeholder: "optional",
      },
      {
        name: "enable_cloudflare_resources",
        type: "boolean",
        defaultValue: "true",
        label: text("Cloudflare リソースを作成", "Create Cloudflare resources"),
      },
      {
        name: "enable_cloudflare_worker_script",
        type: "boolean",
        defaultValue: "true",
        label: text("Worker を公開", "Publish Worker"),
      },
      {
        name: "worker_bundle_url",
        type: "string",
        defaultValue:
          "https://github.com/tako0614/yurucommu/releases/download/v2.0.1/takos-worker.js",
        label: text("Worker artifact URL", "Worker artifact URL"),
      },
      {
        name: "worker_bundle_sha256",
        type: "string",
        defaultValue:
          "866184ea1861b848770cbe64bed4e22d73778365c33ef693d81040e3baf04d50",
        label: text("Worker artifact SHA-256", "Worker artifact SHA-256"),
      },
    ],
    installExperience: {
      serviceName: { variable: "project_name" },
      publicEndpoint: {
        subdomainVariable: "worker_name",
        urlVariable: "app_url",
        routePatternVariable: "cloudflare_route_pattern",
        baseDomain: "app.takos.jp",
      },
      initialSecret: {
        variable: "auth_password_hash",
        kind: "password_or_hash",
        optional: true,
      },
    },
    outputAllowlist: {
      url: { from: "url", type: "url" },
      app_deployment: { from: "app_deployment", type: "json" },
    },
  },
  {
    id: "cfg-catalog-takos",
    name: "takos",
    source: {
      git: "https://github.com/tako0614/takos.git",
      ref: "8c8d4f4eabbf52e434d5cee3b20e39cbe3df3333",
      path: "deploy/opentofu",
    },
    order: 110,
    surface: "service",
    kind: "worker",
    provider: "cloudflare",
    suggestedName: "takos",
    badge: text("追加候補", "Installable"),
    displayName: text("Takos", "Takos"),
    description: text(
      "AI ワークスペースを自分の環境にホストします。",
      "Host the Takos AI workspace in your own environment.",
    ),
    iconUrl:
      "https://raw.githubusercontent.com/tako0614/takos/8c8d4f4eabbf52e434d5cee3b20e39cbe3df3333/web/public/logo.png",
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text("サービス名", "Service name"),
        helper: text(
          "リソース名のベースに使われます。公開URLは次の公開サブドメインで指定できます。",
          "Used as the resource name base. The public URL can be set with the public subdomain below.",
        ),
      },
      {
        name: "worker_name",
        type: "string",
        label: text("公開サブドメイン", "Public subdomain"),
        helper: text(
          "空欄ならサービス名から自動で決めます。入力すると <subdomain>.app.takos.jp として使われます。",
          "Leave empty to derive it from the service name. When set, it is used as <subdomain>.app.takos.jp.",
        ),
        placeholder: "my-workspace",
      },
      {
        name: "app_url",
        type: "string",
        advanced: true,
        label: text("独自URL", "Custom URL"),
        helper: text(
          "独自ドメインを使う場合だけ https:// から入力します。空欄ならサービス名から app.takos.jp のURLを使います。",
          "Enter an https:// URL only for a custom domain. Leave empty to use an app.takos.jp URL from the service name.",
        ),
        placeholder: "https://my-workspace.app.takos.jp",
      },
      {
        name: "release_container_images",
        type: "json",
        defaultValue:
          '{"runtime":"registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-worker-runtime:0.10.0-3cfcc10f7ad1","executor":"registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-agent-executor:0.10.0-3cfcc10f7ad1"}',
        label: text("Release container images", "Release container images"),
      },
    ],
    installExperience: {
      serviceName: { variable: "project_name" },
      publicEndpoint: {
        subdomainVariable: "worker_name",
        urlVariable: "app_url",
        baseDomain: "app.takos.jp",
      },
    },
    outputAllowlist: {
      url: { from: "url", type: "url" },
      app_deployment: { from: "app_deployment", type: "json" },
      takosumi_release: { from: "takosumi_release", type: "json" },
    },
  },
];

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
    ...(spec.iconUrl ? { iconUrl: spec.iconUrl } : {}),
    inputs: spec.inputs,
    ...(spec.installExperience
      ? { installExperience: spec.installExperience }
      : {}),
  };
}

function installConfigFromCuratedGitCatalog(
  spec: CuratedGitCatalogSpec,
  now: string,
): InstallConfig {
  const modulePath = modulePathFromCatalogSourcePath(spec.source.path);
  return {
    id: spec.id,
    name: spec.name,
    sourceKind: "generic_capsule",
    installType: "opentofu_module",
    trustLevel: "trusted",
    ...(modulePath ? { modulePath } : {}),
    variableMapping: {},
    outputAllowlist: spec.outputAllowlist,
    policy: {},
    catalog: {
      source: spec.source,
      order: spec.order,
      surface: spec.surface,
      kind: spec.kind,
      provider: spec.provider,
      suggestedName: spec.suggestedName,
      badge: spec.badge,
      name: spec.displayName,
      description: spec.description,
      ...(spec.iconUrl ? { iconUrl: spec.iconUrl } : {}),
      inputs: spec.inputs,
      ...(spec.installExperience
        ? { installExperience: spec.installExperience }
        : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function modulePathFromCatalogSourcePath(path: string): string | undefined {
  const normalized = path.trim();
  return normalized && normalized !== "." ? normalized : undefined;
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
 * every OTHER built-in template module. A template already bound by a named
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
  for (const spec of CURATED_GIT_CATALOG) {
    configs.push(installConfigFromCuratedGitCatalog(spec, nowIso));
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
