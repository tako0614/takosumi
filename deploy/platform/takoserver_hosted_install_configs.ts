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

// The provider runtime-binding RPC can derive values, but its current wire
// contract cannot return public-origin evidence to the owning Takosumi Run.
// Keep the Takoform profile nonselectable until a cross-repository contract can
// bind and redeem that evidence after successful Apply. Direct Cloudflare uses
// the existing Run-owned DB OIDC path and remains the only selectable profile.
export const TAKOSERVER_HOSTED_INSTALL_CONFIGS: readonly InstallConfig[] =
  Object.freeze([Object.freeze(cloudflare)]);
