import { expect, test } from "bun:test";
import {
  composeTakosInstallConfig,
  TAKOS_HOSTED_INSTALL_CONFIG_ID,
  TAKOS_HOSTED_INSTALL_CONFIG_NAME,
} from "../../../deploy/platform/takos_install_config.ts";
import { composeTakoserverHostedWorkerEnv } from "../../../deploy/platform/takoserver_hosted_worker.ts";
import { TAKOSERVER_HOSTED_INSTALL_CONFIGS } from "../../../deploy/platform/takoserver_hosted_install_configs.ts";
import { OPERATOR_CONTROL_MCP_INSTALL_CONFIG } from "../../../deploy/operator-control-mcp.ts";
import { evaluateProviderConnectionCredentialPolicy } from "../../../core/domains/deploy-control/provider_policy.ts";

const descriptorUrl =
  "https://github.com/tako0614/takos/releases/download/v0.11.8/takosumi-artifact.json";
const descriptorSha256 =
  "sha256:f6e9ee74d352803bf9a4af07be57b7c03e9ed61d6127794c382e224ff1775b2c";
const accountsIssuer = "https://app.takosumi.com";

function configuredEnvironment(
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL: descriptorUrl,
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256: descriptorSha256,
    TAKOSUMI_ACCOUNTS_ISSUER: accountsIssuer,
    ...extra,
  };
}

test("Takos profile is absent until both release descriptor values are supplied", () => {
  expect(composeTakosInstallConfig({})).toBeUndefined();
  const composed = composeTakoserverHostedWorkerEnv({} as never);
  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toBe(
    TAKOSERVER_HOSTED_INSTALL_CONFIGS,
  );
});

test("valid Takos release descriptor composes the exact Cloudflare profile", () => {
  const config = composeTakosInstallConfig(configuredEnvironment({
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "must-not-enter-install-config",
  }));

  expect(config).toMatchObject({
    id: TAKOS_HOSTED_INSTALL_CONFIG_ID,
    name: TAKOS_HOSTED_INSTALL_CONFIG_NAME,
    sourceSelector: {
      url: "https://github.com/tako0614/takos.git",
      path: ".",
    },
    modulePath: "deploy/opentofu/cloudflare",
    runnerId: "opentofu-default",
    sourceBuild: {
      commands: [{ argv: ["bun", "install", "--frozen-lockfile"] }],
      outputs: ["node_modules/wrangler/bin/wrangler.js"],
    },
    variableMapping: {},
    installExperience: {
      projections: [{
        kind: "oidc_client",
        variables: {},
        callbackPath: "/auth/oidc/callback",
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "capsules:read",
          "capsules:write",
        ],
      }],
    },
    accountsOidcModuleVariableMaterialization: {
      contract: "takosumi.accounts-oidc-module-variables/v2",
      resourceNameVariable: "project_name",
      publicUrlVariable: "public_url",
      additionalInputVariables: [
        "cloudflare_account_id",
        "cloudflare_workers_subdomain",
      ],
      accountsUrlVariable: "takosumi_accounts_url",
      issuerUrlVariable: "takosumi_accounts_issuer_url",
      clientIdVariable: "takosumi_accounts_client_id",
      redirectUriVariable: "takosumi_accounts_redirect_uri",
      callbackPath: "/auth/oidc/callback",
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "capsules:read",
        "capsules:write",
      ],
    },
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v1",
      runtimeSecretFile: {
        contract: "takosumi.runtime-secret-file/v1",
        envName: "TAKOS_RUNTIME_SECRETS_FILE",
        fileName: "takos-runtime-secrets.json",
        mode: 0o600,
        values: [
          {
            kind: "rsa-key-pair",
            privateName: "PLATFORM_PRIVATE_KEY",
            publicName: "PLATFORM_PUBLIC_KEY",
            modulusLength: 2048,
            hash: "SHA-256",
          },
          {
            kind: "random",
            name: "ENCRYPTION_KEY",
            bytes: 32,
            encoding: "base64",
          },
          {
            kind: "random",
            name: "TAKOS_AGENT_START_TOKEN",
            bytes: 32,
            encoding: "hex",
          },
          {
            kind: "random",
            name: "TAKOS_INTERNAL_API_SECRET",
            bytes: 32,
            encoding: "hex",
          },
        ],
      },
    },
    installContextVariableMapping: {
      "env.TAKOSUMI_WORKSPACE_ID": "workspace_id",
    },
    outputAllowlist: {},
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  });
  expect(config?.lifecycleActions).toEqual([
    {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: "takos-product-activate-v1",
      phase: "post_apply",
      executor: "runner",
      command: ["bun", "run", "product:activate"],
      workingDirectory: ".",
      env: {
        TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL: descriptorUrl,
        TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256: descriptorSha256,
      },
      timeoutSeconds: 3600,
      runnerCapability: "capsule.lifecycle.command.v1",
      useProviderCredentials: true,
    },
    {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: "takos-product-pre-destroy-v1",
      phase: "pre_destroy",
      cleanupFor: "takos-product-activate-v1",
      executor: "runner",
      command: ["bun", "run", "product:pre-destroy"],
      workingDirectory: ".",
      timeoutSeconds: 1800,
      runnerCapability: "capsule.lifecycle.command.v1",
      useProviderCredentials: true,
    },
  ]);
  expect(config?.policy).toEqual({
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    providerCredentials: {
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      requiredCredentialCapabilities: [
        "cloudflare.account-workers-subdomain.v1",
      ],
    },
    repositoryInstallUx: {
      allowedInterfacePermissions: ["ui.open"],
      allowedInterfaceDeliveryTypes: ["none"],
      allowedInterfaceBindingProfiles: [
        { permissions: ["ui.open"], deliveryType: "none" },
      ],
      requiredManifestApiVersion: "takosumi.com/v2.2",
    },
    lifecycleActions: {
      allowedExecutors: ["runner"],
      allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
      allowProviderCredentials: true,
    },
  });
  expect(config?.store).toEqual({
    source: {
      url: "https://github.com/tako0614/takos.git",
      path: ".",
    },
    deploymentProfile: {
      key: "cloudflare-direct-v1",
      label: { ja: "Cloudflareへ直接配置", en: "Direct Cloudflare" },
      description: {
        ja: "自分で接続したCloudflareアカウントへTakosを配置します。",
        en: "Deploy Takos to a connected Cloudflare account.",
      },
      order: 10,
      recommended: true,
    },
    order: 5,
    surface: "apps",
    kind: "app",
    provider: "Takos ecosystem",
    suggestedName: "takos",
    badge: { ja: "AIワークスペース", en: "AI workspace" },
    name: { ja: "Takos", en: "Takos" },
    description: {
      ja: "自分のCloudflareアカウントにAIワークスペースを配置します。",
      en: "Deploy the Takos AI workspace to your own Cloudflare account.",
    },
  });
  expect(JSON.stringify(config)).not.toContain(
    "must-not-enter-install-config",
  );
});

test("Takos ProviderBinding admits the reverified Cloudflare connection and rejects generic-env", () => {
  const config = composeTakosInstallConfig(configuredEnvironment());
  expect(config).toBeDefined();
  expect(
    evaluateProviderConnectionCredentialPolicy(
      {
        id: "conn_8727_reverified_cloudflare",
        scope: "workspace",
        credentialRecipe: { id: "cloudflare", authMode: "api_token" },
        credentialVerification: {
          kind: "takosumi.credential-verification@v1",
          verifierId: "cloudflare/account-workers-subdomain@v1",
          capabilities: ["cloudflare.account-workers-subdomain.v1"],
        },
      },
      config!.policy,
    ),
  ).toEqual([]);
  expect(
    evaluateProviderConnectionCredentialPolicy(
      {
        id: "conn_a422_generic_env",
        scope: "workspace",
        credentialRecipe: { id: "generic-env", authMode: "env" },
        credentialVerification: {
          kind: "takosumi.credential-verification@v1",
          verifierId: "declared-env@v1",
          capabilities: [],
        },
      },
      config!.policy,
    ),
  ).toContain(
    "provider credential policy rejects connection conn_a422_generic_env credential capabilities missing cloudflare.account-workers-subdomain.v1",
  );
});

test("valid Takos profile preserves the existing hosted and operator MCP entries", () => {
  const composed = composeTakoserverHostedWorkerEnv({
    ...configuredEnvironment(),
    TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "1",
  } as never);
  expect(composed.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([
    ...TAKOSERVER_HOSTED_INSTALL_CONFIGS,
    expect.objectContaining({ id: TAKOS_HOSTED_INSTALL_CONFIG_ID }),
    {
      ...OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
      variableMapping: { takosumi_origin: accountsIssuer },
    },
  ]);
});

test("Takos hosted profile does not pin a global Accounts client", () => {
  const config = composeTakosInstallConfig(configuredEnvironment({
    TAKOSUMI_ACCOUNTS_ISSUER: "https://wrong.example.test",
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([
      { clientId: "global-client-must-not-be-selected" },
    ]),
  }));
  expect(config?.variableMapping).toEqual({});
  expect(JSON.stringify(config)).not.toContain("global-client-must-not-be-selected");
  expect(JSON.stringify(config)).not.toContain("wrong.example.test");
});

test("Takos release descriptor xor and malformed values fail closed", () => {
  const invalidEnvironments = [
    { TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL: descriptorUrl },
    { TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256: descriptorSha256 },
    {
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL:
        "https://github.com/tako0614/takos/releases/download/latest/takosumi-artifact.json",
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256: descriptorSha256,
    },
    {
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL:
        "https://github.com/other/takos/releases/download/v0.11.8/takosumi-artifact.json",
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256: descriptorSha256,
    },
    {
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL: `${descriptorUrl}?download=1`,
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256: descriptorSha256,
    },
    {
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL: descriptorUrl,
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256:
        "sha256:F6e9ee74d352803bf9a4af07be57b7c03e9ed61d6127794c382e224ff1775b2c",
    },
    {
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL: descriptorUrl,
      TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256: "sha256:short",
    },
  ];

  for (const env of invalidEnvironments) {
    expect(() => composeTakosInstallConfig(env)).toThrow(TypeError);
    expect(() => composeTakoserverHostedWorkerEnv(env as never)).toThrow(
      TypeError,
    );
  }
});
