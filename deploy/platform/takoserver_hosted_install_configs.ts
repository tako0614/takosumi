import {
  UI_SURFACE_OPEN_PERMISSION,
  type InstallConfig,
} from "takosumi-contract";
import { TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_3 } from "takosumi-contract/repository-manifest";

export const TAKOSERVER_TAKOFORM_CONNECTION_ID =
  "conn_takoserverTakoform01" as const;
export const TAKOSERVER_TAKOFORM_PROVIDER_SOURCE =
  "registry.terraform.io/tako0614/takoform" as const;

const SOURCE = Object.freeze({
  url: "https://github.com/tako0614/yurucommu.git",
  path: ".",
});
const TIMESTAMP = "2026-08-20T00:00:00.000Z";

function base(
  id: string,
  name: string,
  deploymentProfile: NonNullable<InstallConfig["store"]>["deploymentProfile"],
  connectionPolicy: Pick<
    NonNullable<InstallConfig["policy"]["providerCredentials"]>,
    "allowedConnectionIds" | "forbiddenConnectionIds"
  >,
): InstallConfig {
  return {
    id,
    name,
    sourceSelector: SOURCE,
    modulePath: "deploy/takoform-current",
    variableMapping: {},
    outputAllowlist: {},
    managedPublicHostname: { mode: "scoped" },
    policy: {
      allowedProviders: [TAKOSERVER_TAKOFORM_PROVIDER_SOURCE],
      providerCredentials: {
        requiredProviders: [TAKOSERVER_TAKOFORM_PROVIDER_SOURCE],
        ...connectionPolicy,
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

const managed = base(
  "cfg-hosted-yurucommu-takoserver-v1",
  "yurucommu-takoserver-v1",
  {
    key: "takoserver-v1",
    label: { ja: "Takoserver", en: "Takoserver" },
    description: {
      ja: "Takosumi内で完結する、おすすめのマネージドクラウド。",
      en: "Recommended managed cloud, completed inside Takosumi.",
    },
    order: 10,
    recommended: true,
    management: {
      kind: "external_console",
      href: "https://console.takoserver.com",
      label: { ja: "Takoserverコンソール", en: "Takoserver console" },
    },
  },
  { allowedConnectionIds: [TAKOSERVER_TAKOFORM_CONNECTION_ID] },
);

export const TAKOSERVER_HOSTED_INSTALL_CONFIGS: readonly InstallConfig[] =
  Object.freeze([
    Object.freeze({
      ...managed,
      policy: {
        ...managed.policy,
        providerCredentials: {
          ...managed.policy.providerCredentials,
          requireTemporary: true,
          requireTtlEnforced: true,
        },
      },
    }),
    Object.freeze(
      base(
        "cfg-hosted-yurucommu-takoform-v1",
        "yurucommu-takoform-v1",
        {
          key: "takoform-v1",
          label: { ja: "Takoform", en: "Takoform" },
          description: {
            ja: "自分で接続したTakoform Hostへ配置します。",
            en: "Deploy to a Takoform Host you connected.",
          },
          order: 20,
          recommended: false,
        },
        { forbiddenConnectionIds: [TAKOSERVER_TAKOFORM_CONNECTION_ID] },
      ),
    ),
  ]);
