import { UI_SURFACE_OPEN_PERMISSION } from "takosumi-contract";
import {
  CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  type InstallConfig,
} from "takosumi-contract/install-configs";
import { TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2 } from "takosumi-contract/repository-manifest";

export const TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL_ENV =
  "TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL" as const;
export const TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256_ENV =
  "TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256" as const;

export const TAKOS_HOSTED_INSTALL_CONFIG_ID =
  "cfg-hosted-takos-cloudflare-direct-v1" as const;
export const TAKOS_HOSTED_INSTALL_CONFIG_NAME =
  "takos-cloudflare-direct-v1" as const;

const TAKOS_SOURCE = Object.freeze({
  url: "https://github.com/tako0614/takos.git",
  path: ".",
});
const TAKOS_PROVIDER_SOURCE = "registry.opentofu.org/cloudflare/cloudflare";
const TAKOS_COMPOSITION_TIMESTAMP = "2026-08-25T00:00:00.000Z";

// SemVer 2.0.0 identifiers. Keeping this closed prevents mutable GitHub
// release aliases (for example `latest`) from becoming lifecycle authority.
const SEMVER_IDENTIFIER =
  "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PATTERN = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)` +
    `(?:-(?:${SEMVER_IDENTIFIER})(?:\\.${SEMVER_IDENTIFIER})*)?` +
    `(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);
const RELEASE_DESCRIPTOR_URL_PATTERN =
  /^https:\/\/github\.com\/tako0614\/takos\/releases\/download\/v([^/]+)\/takosumi-artifact\.json$/u;
const RELEASE_DESCRIPTOR_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface TakosInstallConfigEnvironment {
  readonly [name: string]: unknown;
  readonly [TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL_ENV]?: unknown;
  readonly [TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256_ENV]?: unknown;
}

/**
 * Compose the operator-selected Takos release profile.
 *
 * The profile is deliberately absent until both non-secret descriptor values
 * are supplied. A partial or malformed pair is an operator configuration
 * error, so callers must fail closed instead of exposing a profile that cannot
 * activate or clean up the selected release.
 */
export function composeTakosInstallConfig(
  env: TakosInstallConfigEnvironment,
): InstallConfig | undefined {
  const descriptorUrl = env[TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL_ENV];
  const descriptorSha256 = env[TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256_ENV];
  const hasDescriptorUrl = descriptorUrl !== undefined;
  const hasDescriptorSha256 = descriptorSha256 !== undefined;

  if (hasDescriptorUrl !== hasDescriptorSha256) {
    throw invalidDescriptorEnvironment(
      "both descriptor variables must be supplied together",
    );
  }
  if (!hasDescriptorUrl) return undefined;
  if (
    typeof descriptorUrl !== "string" ||
    !isCreateOnlyReleaseDescriptorUrl(descriptorUrl) ||
    typeof descriptorSha256 !== "string" ||
    !RELEASE_DESCRIPTOR_SHA256_PATTERN.test(descriptorSha256)
  ) {
    throw invalidDescriptorEnvironment("descriptor values are malformed");
  }

  return createTakosInstallConfig(descriptorUrl, descriptorSha256);
}

export function isCreateOnlyReleaseDescriptorUrl(value: string): boolean {
  const match = RELEASE_DESCRIPTOR_URL_PATTERN.exec(value);
  return Boolean(match && SEMVER_PATTERN.test(match[1] ?? ""));
}

function invalidDescriptorEnvironment(reason: string): TypeError {
  return new TypeError(
    `Takos release descriptor environment is invalid: ${reason}`,
  );
}

function createTakosInstallConfig(
  descriptorUrl: string,
  descriptorSha256: string,
): InstallConfig {
  const config: InstallConfig = {
    id: TAKOS_HOSTED_INSTALL_CONFIG_ID,
    name: TAKOS_HOSTED_INSTALL_CONFIG_NAME,
    sourceSelector: TAKOS_SOURCE,
    modulePath: "deploy/opentofu/cloudflare",
    runnerId: "opentofu-default",
    sourceBuild: {
      commands: [{ argv: ["bun", "install", "--frozen-lockfile"] }],
      outputs: ["node_modules/wrangler/bin/wrangler.js"],
    },
    variableMapping: {},
    installContextVariableMapping: {
      "env.TAKOSUMI_WORKSPACE_ID": "workspace_id",
    },
    outputAllowlist: {},
    lifecycleActions: [
      {
        apiVersion: "takosumi.dev/v1alpha1",
        kind: "command",
        id: "takos-product-activate-v1",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "product:activate"],
        workingDirectory: ".",
        env: {
          [TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL_ENV]: descriptorUrl,
          [TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256_ENV]: descriptorSha256,
        },
        timeoutSeconds: 3600,
        runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
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
        runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
        useProviderCredentials: true,
      },
    ],
    policy: {
      allowedProviders: [TAKOS_PROVIDER_SOURCE],
      providerCredentials: {
        requiredProviders: [TAKOS_PROVIDER_SOURCE],
      },
      repositoryInstallUx: {
        allowedInterfacePermissions: [UI_SURFACE_OPEN_PERMISSION],
        allowedInterfaceDeliveryTypes: ["none"],
        allowedInterfaceBindingProfiles: [
          { permissions: [UI_SURFACE_OPEN_PERMISSION], deliveryType: "none" },
        ],
        requiredManifestApiVersion:
          TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION_V2_2,
      },
      lifecycleActions: {
        allowedExecutors: ["runner"],
        allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
        allowProviderCredentials: true,
      },
    },
    store: {
      source: TAKOS_SOURCE,
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
    },
    createdAt: TAKOS_COMPOSITION_TIMESTAMP,
    updatedAt: TAKOS_COMPOSITION_TIMESTAMP,
  };
  return Object.freeze(config);
}
