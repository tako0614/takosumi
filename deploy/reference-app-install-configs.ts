/**
 * Replaceable reference InstallConfig composition for Takos-adjacent apps.
 *
 * These are ordinary Workspace-neutral service-side records. When present,
 * Store metadata associates a canonical Git URL/module path for presentation
 * only; it deliberately omits `ref`. Source synchronization and the reviewed
 * Run pin the commit used for execution. A config without
 * Store metadata remains addressable explicitly without appearing in shared
 * discovery. No artifact value, provider credential, application secret, or
 * runtime declaration is read from a repo manifest, `.well-known/tcs.json`,
 * featured-app profile, or OpenTofu Output.
 */
import type {
  CapsuleInterfaceBindingProposal,
  CapsuleInterfaceBlueprint,
} from "takosumi-contract/interfaces";
import {
  FILE_HANDLER_INTERFACE_TYPE,
  FILE_HANDLER_INTERFACE_VERSION,
  FILE_HANDLER_OPEN_PERMISSION,
  MCP_SERVER_INTERFACE_TYPE,
  MCP_SERVER_INTERFACE_VERSION,
  MCP_SERVER_INVOKE_PERMISSION,
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
  UI_SURFACE_OPEN_PERMISSION,
} from "takosumi-contract";
import type {
  InstallConfig,
  InstallConfigVariablePresentation,
  OutputAllowlistEntry,
} from "takosumi-contract/install-configs";
import { CAPSULE_LIFECYCLE_COMMAND_CAPABILITY } from "takosumi-contract/install-configs";

const REFERENCE_CONFIG_TIMESTAMP = "2026-07-14T00:00:00.000Z";
const MANAGED_APP_BASE_DOMAIN = "app.takos.jp";
type AppSource = {
  readonly url: string;
  readonly path: ".";
};

function source(repo: string): AppSource {
  return {
    url: `https://github.com/tako0614/${repo}.git`,
    path: ".",
  };
}

function output(type: OutputAllowlistEntry["type"] = "url") {
  return (name: string): OutputAllowlistEntry => ({
    from: name,
    type,
    required: true,
  });
}

const urlOutput = output("url");

function installingPrincipalBinding(
  key: string,
  permissions: readonly string[],
  delivery: "none" | "oauth2",
): CapsuleInterfaceBindingProposal {
  return {
    key,
    subject: { source: "installing_principal" },
    permissions,
    delivery: { type: delivery },
  };
}

function uiBlueprint(input: {
  readonly app: string;
  readonly key?: string;
  readonly name?: string;
  readonly title: string;
  readonly outputName: string;
  /** `document.display.icon`: root-relative runtime path or short glyph. */
  readonly icon?: string;
}): CapsuleInterfaceBlueprint {
  const key = input.key ?? "launcher";
  return {
    key,
    name: input.name ?? `${input.app}.launcher`,
    labels: { app: input.app },
    spec: {
      type: UI_SURFACE_INTERFACE_TYPE,
      version: UI_SURFACE_INTERFACE_VERSION,
      document: {
        launcher: true,
        display: {
          title: input.title,
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
        },
      },
      inputs: {
        url: { source: "capsule_output", outputName: input.outputName },
      },
      access: { visibility: "workspace" },
    },
    bindings: [
      installingPrincipalBinding(
        `${key}.installer`,
        [UI_SURFACE_OPEN_PERMISSION],
        "none",
      ),
    ],
  };
}

function mcpBlueprint(input: {
  readonly app: string;
  readonly title: string;
  readonly outputName?: string;
}): CapsuleInterfaceBlueprint {
  return {
    key: "mcp",
    name: `${input.app}.mcp`,
    labels: { app: input.app },
    spec: {
      type: MCP_SERVER_INTERFACE_TYPE,
      version: MCP_SERVER_INTERFACE_VERSION,
      document: {
        transport: "streamable-http",
        display: { title: input.title },
      },
      inputs: {
        endpoint: {
          source: "capsule_output",
          outputName: input.outputName ?? "mcp_url",
        },
      },
      access: {
        visibility: "workspace",
        resourceUriInput: "endpoint",
      },
    },
    bindings: [
      installingPrincipalBinding(
        "mcp.installer",
        [MCP_SERVER_INVOKE_PERMISSION],
        "oauth2",
      ),
    ],
  };
}

function capabilityBlueprint(input: {
  readonly app: string;
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly type: string;
  readonly version: string;
  readonly outputName: string;
  readonly permissions: readonly string[];
}): CapsuleInterfaceBlueprint {
  return {
    key: input.key,
    name: input.name,
    labels: { app: input.app },
    spec: {
      type: input.type,
      version: input.version,
      document: {
        display: { title: input.title },
        permissions: [...input.permissions],
      },
      inputs: {
        endpoint: {
          source: "capsule_output",
          outputName: input.outputName,
        },
      },
      access: {
        visibility: "workspace",
        resourceUriInput: "endpoint",
      },
    },
    bindings: [
      installingPrincipalBinding(
        `${input.key}.installer`,
        input.permissions,
        "oauth2",
      ),
    ],
  };
}

function fileHandlerBlueprint(input: {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly outputName: string;
  readonly mimeType: string;
  readonly extension: string;
}): CapsuleInterfaceBlueprint {
  return {
    key: input.key,
    name: input.name,
    labels: { app: "takos-office" },
    spec: {
      type: FILE_HANDLER_INTERFACE_TYPE,
      version: FILE_HANDLER_INTERFACE_VERSION,
      document: {
        display: { title: input.title },
        mimeTypes: [input.mimeType],
        extensions: [input.extension],
      },
      inputs: {
        openUrl: {
          source: "capsule_output",
          outputName: input.outputName,
        },
      },
      access: { visibility: "workspace" },
    },
    bindings: [
      installingPrincipalBinding(
        `${input.key}.installer`,
        [FILE_HANDLER_OPEN_PERMISSION],
        "none",
      ),
    ],
  };
}

function commonCloudflareVariables(input: {
  readonly publicUrlVariable: "app_url" | "public_url";
  readonly publicNameVariable?: "project_name" | "public_subdomain";
}): readonly InstallConfigVariablePresentation[] {
  const publicNameVariable = input.publicNameVariable ?? "project_name";
  return [
    {
      name: "project_name",
      type: "string",
      format: "subdomain",
      required: true,
      defaultValue: { source: "capsule_name" },
      label: { ja: "リソース名", en: "Resource name" },
      helper: {
        ja: "この Capsule が作成するリソースの名前です。",
        en: "Name prefix for resources created by this Capsule.",
      },
    },
    ...(publicNameVariable === "public_subdomain"
      ? [
          {
            name: "public_subdomain",
            type: "string" as const,
            format: "subdomain",
            required: true,
            defaultValue: { source: "capsule_name" as const },
            label: { ja: "公開名", en: "Public name" },
          },
        ]
      : []),
    {
      name: "cloudflare_account_id",
      type: "string",
      format: "text",
      required: true,
      advanced: true,
      label: { ja: "Cloudflare account ID", en: "Cloudflare account ID" },
    },
    {
      name: input.publicUrlVariable,
      type: "string",
      format: "url",
      advanced: true,
      label: { ja: "公開 URL", en: "Public URL" },
    },
    {
      name: "cloudflare_route_zone_id",
      type: "string",
      format: "text",
      advanced: true,
      label: { ja: "Route zone ID", en: "Route zone ID" },
    },
    {
      name: "cloudflare_route_pattern",
      type: "string",
      format: "hostname",
      advanced: true,
      label: { ja: "Worker route", en: "Worker route" },
    },
  ];
}

function publicInstallExperience(input: {
  readonly subdomainVariable: "project_name" | "public_subdomain";
  readonly urlVariable: "app_url" | "public_url";
  readonly oidc?: {
    readonly issuerVariable: string;
    readonly clientIdVariable: string;
    readonly redirectUriVariable?: string;
    readonly callbackPath: string;
  };
}) {
  return {
    projections: [
      { kind: "service_name" as const, variable: "project_name" },
      {
        kind: "public_endpoint" as const,
        variables: {
          subdomain: input.subdomainVariable,
          url: input.urlVariable,
          routePattern: "cloudflare_route_pattern",
        },
        baseDomain: MANAGED_APP_BASE_DOMAIN,
      },
      ...(input.oidc
        ? [
            {
              kind: "oidc_client" as const,
              variables: {
                issuerUrl: input.oidc.issuerVariable,
                clientId: input.oidc.clientIdVariable,
                ...(input.oidc.redirectUriVariable
                  ? { redirectUri: input.oidc.redirectUriVariable }
                  : {}),
              },
              callbackPath: input.oidc.callbackPath,
              scopes: ["openid", "profile", "email"],
            },
          ]
        : []),
    ],
  };
}

function store(input: {
  readonly source: AppSource;
  readonly order: number;
  readonly kind: "app" | "service";
  readonly suggestedName: string;
  readonly badgeJa: string;
  readonly badgeEn: string;
  readonly nameJa: string;
  readonly nameEn: string;
  readonly descriptionJa: string;
  readonly descriptionEn: string;
}) {
  return {
    source: input.source,
    order: input.order,
    surface: "apps",
    kind: input.kind,
    provider: "Takos ecosystem",
    suggestedName: input.suggestedName,
    badge: { ja: input.badgeJa, en: input.badgeEn },
    name: { ja: input.nameJa, en: input.nameEn },
    description: {
      ja: input.descriptionJa,
      en: input.descriptionEn,
    },
  } as const;
}

const officeConfig = {
  id: "cfg-reference-takos-office-main",
  name: "takos-office-main",
  modulePath: ".",
  variableMapping: {
    enable_cloudflare_resources: true,
    enable_cloudflare_worker_script: true,
    enable_workers_dev_subdomain: false,
  },
  installContextVariableMapping: {
    object_storage_workspace_id: "workspace_id",
    app_capsule_id: "capsule_id",
  },
  variablePresentation: [
    ...commonCloudflareVariables({ publicUrlVariable: "app_url" }),
    {
      name: "object_storage_api_url",
      type: "string",
      format: "url",
      advanced: true,
      label: { ja: "Storage API URL", en: "Storage API URL" },
    },
    {
      name: "object_storage_access_token",
      type: "string",
      format: "password",
      advanced: true,
      secret: true,
      label: { ja: "Storage access token", en: "Storage access token" },
    },
    {
      name: "object_storage_key_prefix",
      type: "string",
      format: "text",
      advanced: true,
      label: { ja: "Storage key prefix", en: "Storage key prefix" },
    },
    {
      name: "object_storage_workspace_id",
      type: "string",
      format: "text",
      advanced: true,
      label: { ja: "Storage Workspace ID", en: "Storage Workspace ID" },
    },
  ],
  installExperience: publicInstallExperience({
    subdomainVariable: "project_name",
    urlVariable: "app_url",
    oidc: {
      issuerVariable: "takosumi_accounts_issuer_url",
      clientIdVariable: "takosumi_accounts_client_id",
      callbackPath: "/api/auth/callback",
    },
  }),
  outputAllowlist: {
    launch_url: urlOutput("launch_url"),
    mcp_url: urlOutput("mcp_url"),
    docs_url: urlOutput("docs_url"),
    slide_url: urlOutput("slide_url"),
    sheet_url: urlOutput("sheet_url"),
    docs_file_open_url: urlOutput("docs_file_open_url"),
    slide_file_open_url: urlOutput("slide_file_open_url"),
    sheet_file_open_url: urlOutput("sheet_file_open_url"),
  },
  policy: {},
  store: store({
    source: source("takos-office"),
    order: 10,
    kind: "app",
    suggestedName: "takos-office",
    badgeJa: "Office",
    badgeEn: "Office",
    nameJa: "Takos Office",
    nameEn: "Takos Office",
    descriptionJa: "文書・スライド・表計算を一つの Capsule で使えます。",
    descriptionEn: "Docs, slides, and sheets in one Capsule.",
  }),
  interfaceBlueprints: [
    mcpBlueprint({ app: "takos-office", title: "Takos Office" }),
    uiBlueprint({
      app: "takos-office",
      key: "docs",
      name: "takos-office.docs",
      title: "Takos Docs",
      outputName: "docs_url",
      icon: "/docs/icons/docs.svg",
    }),
    uiBlueprint({
      app: "takos-office",
      key: "slide",
      name: "takos-office.slide",
      title: "Takos Slide",
      outputName: "slide_url",
      icon: "/slide/icons/slide.svg",
    }),
    uiBlueprint({
      app: "takos-office",
      key: "sheet",
      name: "takos-office.sheet",
      title: "Takos Sheet",
      outputName: "sheet_url",
      icon: "/sheet/icons/excel.svg",
    }),
    fileHandlerBlueprint({
      key: "docs-file",
      name: "takos-office.docs-file",
      title: "Takos Docs",
      outputName: "docs_file_open_url",
      mimeType: "application/vnd.takos.docs+json",
      extension: ".takosdoc",
    }),
    fileHandlerBlueprint({
      key: "slide-file",
      name: "takos-office.slide-file",
      title: "Takos Slide",
      outputName: "slide_file_open_url",
      mimeType: "application/vnd.takos.slide+json",
      extension: ".takosslide",
    }),
    fileHandlerBlueprint({
      key: "sheet-file",
      name: "takos-office.sheet-file",
      title: "Takos Sheet",
      outputName: "sheet_file_open_url",
      mimeType: "application/vnd.takos.excel+json",
      extension: ".takossheet",
    }),
  ],
  createdAt: REFERENCE_CONFIG_TIMESTAMP,
  updatedAt: REFERENCE_CONFIG_TIMESTAMP,
} satisfies InstallConfig;

function yuruConfig(input: {
  readonly app: "yurucommu" | "yurumeet";
  readonly order: number;
  readonly title: string;
  readonly descriptionJa: string;
  readonly descriptionEn: string;
}): InstallConfig {
  return {
    id: `cfg-reference-${input.app}-main`,
    name: `${input.app}-main`,
    modulePath: ".",
    variableMapping: {
      enable_cloudflare_resources: true,
      enable_cloudflare_worker_script: true,
      enable_workers_dev_subdomain: false,
    },
    variablePresentation: [
      ...commonCloudflareVariables({ publicUrlVariable: "app_url" }),
      {
        name: "notification_push_gateway_url",
        type: "string",
        format: "url",
        advanced: true,
        label: { ja: "Push gateway URL", en: "Push gateway URL" },
      },
      {
        name: "notification_push_gateway_token",
        type: "string",
        format: "password",
        advanced: true,
        secret: true,
        label: { ja: "Push gateway token", en: "Push gateway token" },
      },
      {
        name: "notification_push_web_push_public_key",
        type: "string",
        format: "text",
        advanced: true,
        label: { ja: "Web Push public key", en: "Web Push public key" },
      },
    ],
    installExperience: publicInstallExperience({
      subdomainVariable: "project_name",
      urlVariable: "app_url",
      oidc: {
        issuerVariable: "takosumi_accounts_issuer_url",
        clientIdVariable: "takosumi_accounts_client_id",
        callbackPath: "/api/auth/callback/takos",
      },
    }),
    outputAllowlist: {
      launch_url: urlOutput("launch_url"),
      api_url: urlOutput("api_url"),
    },
    policy: {},
    store: store({
      source: source(input.app),
      order: input.order,
      kind: "app",
      suggestedName: input.app,
      badgeJa: input.app === "yurucommu" ? "SNS" : "トーク",
      badgeEn: input.app === "yurucommu" ? "Social" : "Talk",
      nameJa: input.title,
      nameEn: input.title,
      descriptionJa: input.descriptionJa,
      descriptionEn: input.descriptionEn,
    }),
    interfaceBlueprints: [
      uiBlueprint({
        app: input.app,
        title: input.title,
        outputName: "launch_url",
        icon:
          input.app === "yurucommu"
            ? "/icons/yurucommu.svg"
            : "/yurumeet-logo.png",
      }),
    ],
    createdAt: REFERENCE_CONFIG_TIMESTAMP,
    updatedAt: REFERENCE_CONFIG_TIMESTAMP,
  };
}

const storageConfig = {
  id: "cfg-reference-takos-storage-main",
  name: "takos-storage-main",
  modulePath: ".",
  variableMapping: {
    enable_cloudflare_resources: true,
    enable_cloudflare_worker_script: true,
    enable_workers_dev_subdomain: false,
  },
  installContextVariableMapping: {
    "env.APP_WORKSPACE_ID": "workspace_id",
    "env.APP_CAPSULE_ID": "capsule_id",
  },
  variablePresentation: commonCloudflareVariables({
    publicUrlVariable: "public_url",
    publicNameVariable: "public_subdomain",
  }),
  installExperience: publicInstallExperience({
    subdomainVariable: "public_subdomain",
    urlVariable: "public_url",
    oidc: {
      issuerVariable: "takosumi_accounts_issuer_url",
      clientIdVariable: "takosumi_accounts_client_id",
      callbackPath: "/api/auth/callback/takos",
    },
  }),
  outputAllowlist: {
    launch_url: urlOutput("launch_url"),
    api_url: urlOutput("api_url"),
    mcp_url: urlOutput("mcp_url"),
    // pre_destroy receives only public-safe allowlisted outputs.
    object_bucket_name: output("string")("object_bucket_name"),
    cloudflare_account_id: output("string")("cloudflare_account_id"),
  },
  lifecycleActions: [
    {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: "empty-r2-before-destroy-v1",
      phase: "pre_destroy",
      executor: "runner",
      command: ["bun", "run", "storage:pre-destroy"],
      workingDirectory: ".",
      timeoutSeconds: 3600,
      runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
      useProviderCredentials: true,
    },
  ],
  policy: {
    lifecycleActions: {
      allowedExecutors: ["runner"],
      allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
      allowProviderCredentials: true,
    },
  },
  store: store({
    source: source("takos-storage"),
    order: 60,
    kind: "service",
    suggestedName: "takos-storage",
    badgeJa: "Storage",
    badgeEn: "Storage",
    nameJa: "Takos Storage",
    nameEn: "Takos Storage",
    descriptionJa: "アプリとユーザー向けの object storage を追加します。",
    descriptionEn: "Adds object storage for apps and users.",
  }),
  interfaceBlueprints: [
    uiBlueprint({
      app: "takos-storage",
      title: "Takos Storage",
      outputName: "launch_url",
      icon: "/icons/takos-storage.svg",
    }),
    capabilityBlueprint({
      app: "takos-storage",
      key: "object-storage",
      name: "takos-storage.object",
      title: "Takos Storage Object API",
      type: "storage.object",
      version: "1",
      outputName: "api_url",
      permissions: [
        "storage.object.read",
        "storage.object.write",
        "storage.object.delete",
        "storage.object.list",
      ],
    }),
    mcpBlueprint({ app: "takos-storage", title: "Takos Storage" }),
  ],
  createdAt: REFERENCE_CONFIG_TIMESTAMP,
  updatedAt: REFERENCE_CONFIG_TIMESTAMP,
} satisfies InstallConfig;

const gitConfig = {
  id: "cfg-reference-takos-git-main",
  name: "takos-git-main",
  modulePath: ".",
  variableMapping: {
    enable_cloudflare_resources: true,
    enable_cloudflare_worker_script: true,
    enable_workers_dev_subdomain: false,
    enable_metadata: true,
    enable_actions: false,
  },
  installContextVariableMapping: {
    "env.APP_WORKSPACE_ID": "workspace_id",
    "env.APP_CAPSULE_ID": "capsule_id",
  },
  variablePresentation: [
    ...commonCloudflareVariables({
      publicUrlVariable: "public_url",
      publicNameVariable: "public_subdomain",
    }),
    {
      name: "app_session_secret",
      type: "string",
      format: "password",
      required: true,
      secret: true,
      label: { ja: "Browser session secret", en: "Browser session secret" },
      helper: {
        ja: "ブラウザ OIDC セッション用の 32 文字以上の secret です。",
        en: "A secret of at least 32 characters for browser OIDC sessions.",
      },
    },
  ],
  installExperience: publicInstallExperience({
    subdomainVariable: "public_subdomain",
    urlVariable: "public_url",
    oidc: {
      issuerVariable: "takosumi_accounts_issuer_url",
      clientIdVariable: "takosumi_accounts_client_id",
      callbackPath: "/api/auth/callback",
    },
  }),
  outputAllowlist: {
    launch_url: urlOutput("launch_url"),
    api_url: urlOutput("api_url"),
    hosting_api_url: urlOutput("hosting_api_url"),
    mcp_url: urlOutput("mcp_url"),
    // pre_destroy receives only public-safe allowlisted outputs.
    object_bucket_name: output("string")("object_bucket_name"),
    cloudflare_account_id: output("string")("cloudflare_account_id"),
    actions_logs_bucket_name: output("string")("actions_logs_bucket_name"),
  },
  lifecycleActions: [
    {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: "empty-r2-before-destroy-v1",
      phase: "pre_destroy",
      executor: "runner",
      command: ["bun", "run", "git:pre-destroy"],
      workingDirectory: ".",
      timeoutSeconds: 3600,
      runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
      useProviderCredentials: true,
    },
  ],
  policy: {
    lifecycleActions: {
      allowedExecutors: ["runner"],
      allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
      allowProviderCredentials: true,
    },
  },
  store: store({
    source: source("takos-git"),
    order: 70,
    kind: "service",
    suggestedName: "takos-git",
    badgeJa: "Git",
    badgeEn: "Git",
    nameJa: "Takos Git",
    nameEn: "Takos Git",
    descriptionJa: "共同作業向け Git hosting と repository tool を追加します。",
    descriptionEn: "Adds collaborative Git hosting and repository tools.",
  }),
  interfaceBlueprints: [
    uiBlueprint({
      app: "takos-git",
      title: "Takos Git",
      outputName: "launch_url",
      icon: "/icons/takos-git.svg",
    }),
    capabilityBlueprint({
      app: "takos-git",
      key: "smart-http",
      name: "takos-git.smart-http",
      title: "Takos Git Smart HTTP",
      type: "source.git.smart_http",
      version: "1",
      outputName: "api_url",
      permissions: [
        "source.git.smart_http.read",
        "source.git.smart_http.write",
      ],
    }),
    capabilityBlueprint({
      app: "takos-git",
      key: "hosting",
      name: "takos-git.hosting",
      title: "Takos Git Hosting API",
      type: "source.git.hosting",
      version: "1",
      outputName: "hosting_api_url",
      permissions: ["source.git.hosting.read"],
    }),
    mcpBlueprint({ app: "takos-git", title: "Takos Git" }),
  ],
  createdAt: REFERENCE_CONFIG_TIMESTAMP,
  updatedAt: REFERENCE_CONFIG_TIMESTAMP,
} satisfies InstallConfig;

export const REFERENCE_APP_INSTALL_CONFIGS: readonly InstallConfig[] =
  Object.freeze([
    officeConfig,
    yuruConfig({
      app: "yurucommu",
      order: 30,
      title: "Yurucommu",
      descriptionJa: "ゆるくつながる feed / story 型コミュニケーション。",
      descriptionEn: "A relaxed feed and story communication app.",
    }),
    storageConfig,
    gitConfig,
  ]);
