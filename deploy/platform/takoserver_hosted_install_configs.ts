import { UI_SURFACE_OPEN_PERMISSION } from "takosumi-contract";
import type { InstallConfig } from "../../contract/install-configs.ts";
import { TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3 } from "takosumi-contract/repository-manifest";
import { CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY } from "../../providers/cloudflare/credentials.ts";

export const TAKOSERVER_TAKOFORM_CONNECTION_ID =
  "conn_takoserverTakoform01" as const;
export const TAKOSERVER_TAKOFORM_PROVIDER_SOURCE =
  "registry.terraform.io/tako0614/takoform" as const;
const CLOUDFLARE_PROVIDER_SOURCE =
  "registry.opentofu.org/cloudflare/cloudflare" as const;
const HTTP_PROVIDER_SOURCE = "registry.opentofu.org/hashicorp/http" as const;
const RANDOM_PROVIDER_SOURCE =
  "registry.opentofu.org/hashicorp/random" as const;

const SOURCE = Object.freeze({
  url: "https://github.com/tako0614/yurucommu.git",
  path: ".",
});
const TIMESTAMP = "2026-08-20T00:00:00.000Z";

function base(
  id: string,
  name: string,
  deploymentProfile: NonNullable<InstallConfig["store"]>["deploymentProfile"],
): InstallConfig {
  return {
    id,
    name,
    sourceSelector: SOURCE,
    modulePath: "deploy/takoform",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      allowedProviders: [TAKOSERVER_TAKOFORM_PROVIDER_SOURCE],
      providerCredentials: {
        requiredProviders: [TAKOSERVER_TAKOFORM_PROVIDER_SOURCE],
      },
      repositoryInstallUx: {
        allowedInterfacePermissions: [UI_SURFACE_OPEN_PERMISSION],
        requiredManifestApiVersion:
          TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3,
      },
    },
    store: {
      source: SOURCE,
      deploymentProfile,
      order: 30,
      surface: "apps",
      kind: "app",
      provider: "Takos ecosystem",
      suggestedName: "yurucommu",
      badge: { ja: "SNS", en: "Social" },
      name: { ja: "Yurucommu", en: "Yurucommu" },
      description: {
        ja: "ゆるくつながる feed / story 型コミュニケーション。",
        en: "A relaxed feed and story communication app.",
      },
    },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const takoform = base(
  "cfg-hosted-yurucommu-takoform-v2",
  "yurucommu-takoform-v2",
  {
    key: "takoform-v2",
    label: { ja: "Takoform", en: "Takoform" },
    description: {
      ja: "自分で接続したTakoform Hostへ配置します。",
      en: "Deploy to a Takoform Host you connected.",
    },
    order: 10,
    recommended: true,
  },
);

const takoformRuntime = Object.freeze({
  installExperience: {
    projections: [
      {
        kind: "oidc_client" as const,
        variables: {},
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile", "email"],
      },
    ],
  },
  runtimeBindingMaterialization: {
    contract: "takosumi.runtime-binding-profile/v1" as const,
    generatedSecrets: [
      {
        binding: "ENCRYPTION_KEY",
        bytes: 32 as const,
        encoding: "hex" as const,
      },
    ],
    oidcClient: {
      issuerBinding: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      clientIdBinding: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      ownerSubjectBinding: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      redirectUriBinding: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
      callbackPath: "/api/auth/callback/takos",
      scopes: ["openid", "profile", "email"],
    },
  },
});

const cloudflare: InstallConfig = {
  id: "cfg-hosted-yurucommu-cloudflare-direct-v1",
  name: "yurucommu-cloudflare-direct-v1",
  sourceSelector: SOURCE,
  modulePath: ".",
  variableMapping: {
    enable_cloudflare_resources: true,
    enable_cloudflare_worker_script: true,
    enable_workers_dev_subdomain: true,
    app_url: "",
    cloudflare_account_id: null,
    cloudflare_workers_subdomain: null,
  },
  installExperience: {
    projections: [
      {
        kind: "oidc_client",
        variables: {},
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile", "email"],
      },
    ],
  },
  outputAllowlist: {},
  policy: {
    allowedProviders: [
      CLOUDFLARE_PROVIDER_SOURCE,
      HTTP_PROVIDER_SOURCE,
      RANDOM_PROVIDER_SOURCE,
    ],
    providerCredentials: {
      requiredProviders: [CLOUDFLARE_PROVIDER_SOURCE],
      requiredCredentialCapabilities: [
        CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
      ],
    },
    repositoryInstallUx: {
      allowedInterfacePermissions: [UI_SURFACE_OPEN_PERMISSION],
      requiredManifestApiVersion:
        TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3,
    },
  },
  store: {
    source: SOURCE,
    deploymentProfile: {
      key: "cloudflare-v1",
      label: { ja: "Cloudflare", en: "Cloudflare" },
      description: {
        ja: "Cloudflareで配置します。接続済みのCloudflareアカウントを使用します。",
        en: "Deploy with Cloudflare using a connected Cloudflare account.",
      },
      order: 20,
      recommended: false,
      management: {
        kind: "external_console",
        href: "https://dash.cloudflare.com",
        label: {
          ja: "Cloudflareダッシュボード",
          en: "Cloudflare dashboard",
        },
      },
    },
    order: 30,
    surface: "apps",
    kind: "app",
    provider: "Takos ecosystem",
    suggestedName: "yurucommu",
    badge: { ja: "SNS", en: "Social" },
    name: { ja: "Yurucommu", en: "Yurucommu" },
    description: {
      ja: "ゆるくつながる feed / story 型コミュニケーション。",
      en: "A relaxed feed and story communication app.",
    },
  },
  accountsOidcModuleVariableMaterialization: {
    contract: "takosumi.accounts-oidc-module-variables/v1",
    workerNameVariable: "worker_name",
    projectNameVariable: "project_name",
    additionalInputVariables: [
      "cloudflare_account_id",
      "cloudflare_workers_subdomain",
    ],
    forbiddenNonEmptyInputVariables: [
      "auth_password_hash",
      "notification_push_gateway_token",
    ],
    issuerUrlVariable: "takosumi_accounts_issuer_url",
    clientIdVariable: "takosumi_accounts_client_id",
    ownerSubjectVariable: "oidc_owner_sub",
    allowUnpinnedOwnerClaimVariable: "allow_unpinned_owner_claim",
  },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

export const TAKOSERVER_HOSTED_INSTALL_CONFIGS: readonly InstallConfig[] =
  Object.freeze([
    Object.freeze({
      ...takoform,
      ...takoformRuntime,
    }),
    Object.freeze(cloudflare),
  ]);
