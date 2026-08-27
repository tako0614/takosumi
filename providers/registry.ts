/**
 * Guided provider setup registry.
 *
 * These records power Credential Recipe discovery and guided connection setup.
 * They never determine whether an OpenTofu provider may execute.
 */
import { canonicalProviderSource } from "takosumi-contract/provider-env-rules";
import type { CredentialRecipe } from "takosumi-contract/credential-recipes";
import { REFERENCE_CREDENTIAL_RECIPES } from "./credential-recipes.generated.ts";
import type { GuidedProviderSetup } from "./types.ts";
import {
  GuidedConnectionSetupError,
  credentialRecipeDriverKey,
  type ConnectionOAuthDescriptor,
  type CredentialRecipeDriverRegistry,
  type CredentialRecipeRuntimeDriver,
  type GuidedConnectionInput,
  type GuidedConnectionRequestBuilder,
} from "./types.ts";
export {
  GuidedConnectionSetupError,
  credentialRecipeDriverKey,
  type ConnectionOAuthDescriptor,
  type CredentialRecipeDriverRegistry,
  type CredentialRecipeRuntimeDriver,
  type GuidedConnectionInput,
} from "./types.ts";
import { cloudflareCredentialDriver } from "./cloudflare/connection.ts";
import {
  mintAwsAssumeRoleCredentials,
  verifyAwsAssumeRole,
} from "./aws/credentials.ts";
import { mintDeclaredEnvCredentialVariables } from "./declared-env/credentials.ts";
import {
  buildCloudflareApiTokenConnection,
  cloudflareOAuthDescriptorFromEnv,
} from "./cloudflare/setup.ts";
import {
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
} from "./cloudflare/credentials.ts";
import { cloudflareProviderSettings } from "./cloudflare/settings.ts";
import { buildAwsAssumeRoleConnection } from "./aws/setup.ts";
import {
  buildGitHttpsTokenConnection,
  buildGitSshKeyConnection,
} from "./git/setup.ts";
import { REFERENCE_SOURCE_CREDENTIAL_DRIVERS } from "./git/source-credential-driver.ts";
import { buildGenericEnvConnection } from "./generic-env-provider/setup.ts";
import {
  buildGoogleServiceAccountJsonConnection,
  googleOAuthDescriptorFromEnv,
} from "./gcp/setup.ts";

const OPENTOFU = "registry.opentofu.org";

/**
 * Per-provider records WITHOUT the credential fields. The credential
 * (`credentialEnvNames`) data is projected from installed Credential Recipes.
 * This is guided setup metadata only; runtime admission uses the explicit
 * per-Run recipe manifest.
 */
type GuidedProviderSetupBase = Omit<GuidedProviderSetup, "credentialEnvNames">;

const GUIDED_PROVIDER_SETUP_BASES: readonly GuidedProviderSetupBase[] = [
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    providerAddresses: [`${OPENTOFU}/cloudflare/cloudflare`],
  },
  {
    id: "aws",
    displayName: "AWS",
    providerAddresses: [`${OPENTOFU}/hashicorp/aws`],
  },
  {
    id: "gcp",
    displayName: "Google Cloud",
    providerAddresses: [
      `${OPENTOFU}/hashicorp/google`,
      `${OPENTOFU}/hashicorp/google-beta`,
    ],
  },
  {
    id: "azure",
    displayName: "Azure",
    providerAddresses: [`${OPENTOFU}/hashicorp/azurerm`],
  },
  {
    id: "kubernetes",
    displayName: "Kubernetes",
    providerAddresses: [
      `${OPENTOFU}/hashicorp/kubernetes`,
      `${OPENTOFU}/hashicorp/helm`,
    ],
  },
  {
    id: "github",
    displayName: "GitHub",
    providerAddresses: [`${OPENTOFU}/integrations/github`],
  },
  {
    id: "digitalocean",
    displayName: "DigitalOcean",
    providerAddresses: [`${OPENTOFU}/digitalocean/digitalocean`],
  },
  {
    id: "hcloud",
    displayName: "Hetzner Cloud",
    providerAddresses: [`${OPENTOFU}/hetznercloud/hcloud`],
  },
  {
    id: "vultr",
    displayName: "Vultr",
    providerAddresses: [`${OPENTOFU}/vultr/vultr`],
  },
  {
    id: "scaleway",
    displayName: "Scaleway",
    providerAddresses: [`${OPENTOFU}/scaleway/scaleway`],
  },
  {
    id: "openstack",
    displayName: "OpenStack",
    providerAddresses: [`${OPENTOFU}/terraform-provider-openstack/openstack`],
  },
  {
    id: "docker",
    displayName: "Docker",
    providerAddresses: [`${OPENTOFU}/kreuzwerker/docker`],
  },
];

/**
 * Resolve guided env-name hints from explicit recipe source declarations.
 * A provider with no installed matching recipe gets an empty hint list.
 */
function resolveProviderCredentials(base: GuidedProviderSetupBase): {
  credentialEnvNames: readonly string[];
} {
  const address = base.providerAddresses[0] ?? base.id;
  const names = REFERENCE_CREDENTIAL_RECIPES.flatMap((recipe) => {
    if (recipe.terraformSource === "*") return [];
    return recipe.terraformSource.some(
      (source) =>
        canonicalProviderAddress(source) === canonicalProviderAddress(address),
    )
      ? [...(recipe.envNames ?? [])]
      : [];
  });
  return {
    credentialEnvNames: [...new Set(names)],
  };
}

export const GUIDED_PROVIDER_SETUPS: readonly GuidedProviderSetup[] =
  GUIDED_PROVIDER_SETUP_BASES.map((base) => ({
    ...base,
    ...resolveProviderCredentials(base),
  }));

const BY_ADDRESS = new Map<string, GuidedProviderSetup>();
for (const provider of GUIDED_PROVIDER_SETUPS) {
  for (const address of provider.providerAddresses) {
    BY_ADDRESS.set(address, provider);
    // A short `<namespace>/<name>` remains an exact identity. Bare local names
    // are intentionally not indexed: `cloudflare` alone cannot distinguish an
    // official source from an attacker-controlled registry namespace.
    const short = address.replace(`${OPENTOFU}/`, "");
    BY_ADDRESS.set(short, provider);
  }
}

/** Resolve guided setup by provider address; absence never blocks execution. */
export function guidedProviderSetupForAddress(
  address: string,
): GuidedProviderSetup | undefined {
  return BY_ADDRESS.get(address);
}

/**
 * Canonicalize an OpenTofu provider source to the fully-qualified
 * `registry.opentofu.org/<namespace>/<name>` form. A source that is already
 * fully qualified is returned unchanged; a short `<namespace>/<name>` source is
 * prefixed with the default registry host; anything else (a bare local name or a
 * non-registry address) is returned unchanged. The default registry host is the
 * registry's single source of truth, so `core` does not re-declare it.
 */
export function canonicalProviderAddress(source: string): string {
  return canonicalProviderSource(source);
}

const GUIDED_CONNECTION_BUILDERS: Readonly<
  Record<string, GuidedConnectionRequestBuilder>
> = Object.freeze({
  "cloudflare-api-token": buildCloudflareApiTokenConnection,
  "aws-assume-role": buildAwsAssumeRoleConnection,
  "google-service-account-json": buildGoogleServiceAccountJsonConnection,
  "git-https-token": buildGitHttpsTokenConnection,
  "git-ssh-key": buildGitSshKeyConnection,
  "generic-env": buildGenericEnvConnection,
});

/** Build a request only through the explicitly selected provider setup id. */
export function buildGuidedConnectionRequest(
  setupId: string,
  input: GuidedConnectionInput,
): ReturnType<GuidedConnectionRequestBuilder> {
  const builder = GUIDED_CONNECTION_BUILDERS[setupId];
  if (!builder) {
    throw new GuidedConnectionSetupError(
      `guided connection setup ${setupId} is not installed`,
    );
  }
  return builder(input);
}

/** Provider-owned OAuth descriptors discovered at composition time. */
export function connectionOAuthDescriptorsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly ConnectionOAuthDescriptor[] {
  return [
    cloudflareOAuthDescriptorFromEnv(env),
    googleOAuthDescriptorFromEnv(env),
  ].filter((value): value is ConnectionOAuthDescriptor => value !== undefined);
}

const cloudflareDriver: CredentialRecipeRuntimeDriver = {
  evidenceIssuer: "cloudflare_api_token_vending",
  verifierId: CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
  verificationCapabilities: [
    CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  ],
  verifiedScopeHintKeys: {
    providerSettings: ["accountId", "workersSubdomain"],
    moduleInputDefaults: [
      "cloudflare_account_id",
      "cloudflare_workers_subdomain",
    ],
  },
  async verify({ connection, values, fetch }) {
    const token = values.CLOUDFLARE_API_TOKEN ?? values.CF_API_TOKEN;
    if (!token)
      return {
        ok: false,
        detail: "credential recipe did not materialize an API token",
      };
    const accountId =
      values.CLOUDFLARE_ACCOUNT_ID?.trim() ||
      values.CF_ACCOUNT_ID?.trim() ||
      cloudflareProviderSettings(connection.scopeHints).accountId;
    return await cloudflareCredentialDriver.verify({
      token,
      ...(accountId ? { accountId } : {}),
      fetch,
    });
  },
  async mint(input) {
    if (cloudflareCredentialDriver.isTokenVending(input.connection)) {
      const minted = await cloudflareCredentialDriver.mint({
        connection: input.connection,
        values: input.values,
        fetch: input.fetch,
        now: input.now,
      });
      return { env: minted.values, evidence: minted.evidence };
    }
    return {
      env: input.values,
      evidence: { ...input.staticEvidence(), issuer: cloudflareDriver.evidenceIssuer },
    };
  },
};

const awsAssumeRoleDriver: CredentialRecipeRuntimeDriver = {
  evidenceIssuer: "aws_sts_assume_role",
  async verify({ connection, values, fetch, now }) {
    return await verifyAwsAssumeRole(connection, values, { fetch, now });
  },
  async mint(input) {
    const minted = await mintAwsAssumeRoleCredentials(
      input.connection,
      input.values,
      input.staticEvidence,
      { fetch: input.fetch, now: input.now },
    );
    return minted
      ? { env: minted.values, evidence: minted.evidence }
      : {
          env: input.values,
          evidence: {
            ...input.staticEvidence(),
            issuer: awsAssumeRoleDriver.evidenceIssuer,
          },
        };
  },
};

/**
 * Reusable runtime driver for any installed recipe with `declaredEnv: true`.
 * Hosts map it to their own opaque `recipeId/authMode` key explicitly; the
 * driver itself assigns no meaning to the reference `generic-env` id.
 */
export const DECLARED_ENV_CREDENTIAL_RECIPE_DRIVER: CredentialRecipeRuntimeDriver =
  {
    evidenceIssuer: "declared_env",
    async verify({ connection, values, files }) {
      const available = new Set([
        ...Object.keys(values),
        ...files.flatMap((file) => (file.envName ? [file.envName] : [])),
      ]);
      const missing = connection.envNames.filter(
        (name) => !available.has(name),
      );
      return missing.length === 0 && connection.envNames.length > 0
        ? { ok: true }
        : {
            ok: false,
            detail: `declared-env recipe is missing declared material: ${missing.join(", ")}`,
          };
    },
    async mint({ connection, values, files }) {
      const minted = mintDeclaredEnvCredentialVariables(
        connection,
        values,
        files,
      );
      if (!minted)
        throw new Error(
          "declared-env driver received a recipe without that capability",
        );
      return {
        env: minted.env,
        files: minted.files,
        evidence: { ...minted.evidence, issuer: "declared_env" },
      };
    },
  };

const googleServiceAccountDriver: CredentialRecipeRuntimeDriver = {
  evidenceIssuer: "google_service_account",
  async verify({ values }) {
    const raw = values.GOOGLE_CREDENTIALS;
    if (!raw) return { ok: false, detail: "service account JSON is missing" };
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const ok =
        parsed.type === "service_account" &&
        typeof parsed.client_email === "string" &&
        typeof parsed.private_key === "string";
      return ok
        ? { ok: true }
        : { ok: false, detail: "service account JSON is structurally invalid" };
    } catch {
      return { ok: false, detail: "service account JSON is invalid JSON" };
    }
  },
  async mint(input) {
    return {
      env: input.values,
      evidence: {
        ...input.staticEvidence(),
        issuer: googleServiceAccountDriver.evidenceIssuer,
      },
    };
  },
};

/**
 * Reference provider-driver registry.
 *
 * This is an optional composition choice for the shipped reference hosts. Core
 * never imports or falls back to it; another host may install a completely
 * different recipe catalog and driver registry.
 */
export const REFERENCE_CREDENTIAL_RECIPE_DRIVERS: CredentialRecipeDriverRegistry =
  {
    [credentialRecipeDriverKey({ id: "cloudflare", authMode: "api_token" })]:
      cloudflareDriver,
    [credentialRecipeDriverKey({ id: "cloudflare", authMode: "oauth" })]:
      cloudflareDriver,
    [credentialRecipeDriverKey({ id: "aws", authMode: "assume_role" })]:
      awsAssumeRoleDriver,
    [credentialRecipeDriverKey({ id: "generic-env", authMode: "env" })]:
      DECLARED_ENV_CREDENTIAL_RECIPE_DRIVER,
    [credentialRecipeDriverKey({
      id: "google",
      authMode: "service_account_json",
    })]: googleServiceAccountDriver,
  };

/**
 * Projects a candidate recipe catalog into the modes this host can honestly
 * install. Static env/file modes need no provider driver: Core verifies their
 * pinned material structurally and mints it unchanged. A pre-run mode creates
 * generated material, so it is installed only when this composition supplies
 * an explicit mint driver for the exact opaque recipe/mode key.
 */
export function installableCredentialRecipes(
  recipes: readonly CredentialRecipe[],
  drivers: CredentialRecipeDriverRegistry,
): readonly CredentialRecipe[] {
  return recipes.flatMap((recipe) => {
    const authModes = Object.fromEntries(
      Object.entries(recipe.authModes).filter(([authMode, mode]) => {
        if (!mode.preRun) return true;
        return (
          drivers[credentialRecipeDriverKey({ id: recipe.id, authMode })]
            ?.mint !== undefined
        );
      }),
    );
    return Object.keys(authModes).length > 0 ? [{ ...recipe, authModes }] : [];
  });
}

/** Candidate reference definitions filtered by the installed runtime drivers. */
export const REFERENCE_INSTALLED_CREDENTIAL_RECIPES =
  installableCredentialRecipes(
    REFERENCE_CREDENTIAL_RECIPES,
    REFERENCE_CREDENTIAL_RECIPE_DRIVERS,
  );

/**
 * Complete reference provider contribution selected by the shipped platform
 * compositions. It includes Provider Credential Recipe drivers, Source
 * credential drivers, and guided setup. Spreading this object into
 * `createTakosumiService` is an explicit host decision, not a Core default or
 * provider allowlist.
 */
export const REFERENCE_CREDENTIAL_RECIPE_COMPOSITION = Object.freeze({
  credentialRecipes: REFERENCE_INSTALLED_CREDENTIAL_RECIPES,
  credentialRecipeDrivers: REFERENCE_CREDENTIAL_RECIPE_DRIVERS,
  // The reference host has an explicit direct-Cloudflare execution lane.
  // Recipe presence alone is not an execution requirement; this exact source
  // is the provider policy authority consumed by the generic default config.
  credentialRequiredProviderSources: Object.freeze([
    `${OPENTOFU}/cloudflare/cloudflare`,
  ]),
  sourceCredentialDrivers: REFERENCE_SOURCE_CREDENTIAL_DRIVERS,
  buildConnectionSetupRequest: buildGuidedConnectionRequest,
});
