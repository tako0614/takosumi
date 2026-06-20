/**
 * Single source of truth for provider -> credential env-name rules.
 *
 * Two consumers share this table:
 *   - the OpenTofu runner (`runner/entrypoint.ts`), which uses it
 *     to decide which env names a credential ref maps to and which required
 *     groups must be present before `tofu init`;
 *   - the Connection / Vault credential core (Phase 1A), which validates the env
 *     names a Connection supplies and computes the cloud partition under which
 *     the secret blob is sealed.
 *
 * A provider is identified either by its short name (e.g. `"cloudflare"`) or by
 * its full OpenTofu registry path (e.g. `"registry.opentofu.org/cloudflare/cloudflare"`
 * or `"cloudflare/cloudflare"`). The `match` RegExp matches the registry-path
 * form (anchored on the `<namespace>/<type>` tail); `shortName` matches the
 * short form. Both forms resolve to the same rule.
 *
 * IMPORTANT (runner container isolation): this module is imported by
 * `runner/entrypoint.ts`, which is copied into the OpenTofu runner container image.
 * Keep it dependency-free (no imports from elsewhere in the repo) so the
 * relative import resolves in the slim container build.
 */

/** Logical cloud family used to partition sealed credential blobs. */
export type ProviderCloudFamily =
  | "cloudflare"
  | "aws"
  | "gcp"
  | "k8s"
  | "local-adapters";

export interface ProviderCredentialEnvRule {
  /**
   * Stable short provider key (e.g. `"cloudflare"`). Used as the public
   * `Connection.provider` short form and as a lookup key.
   */
  readonly shortName: string;
  /**
   * Matches the registry-path form of the provider
   * (`<namespace>/<type>` tail), e.g. `cloudflare/cloudflare`.
   */
  readonly match: RegExp;
  /**
   * Cloud family that owns the sealed secret blob partition for this provider.
   */
  readonly cloudFamily: ProviderCloudFamily;
  /** Every env name this provider may supply. */
  readonly envNames: readonly string[];
  /**
   * One of these groups must be fully present for credentials to be considered
   * satisfied. An empty list means "any single configured env name suffices".
   */
  readonly requiredGroups: readonly (readonly string[])[];
}

/**
 * The canonical provider credential env-name table. Lifted from the runner so
 * the runner and the Connection/Vault core agree byte-for-byte.
 */
export const PROVIDER_CREDENTIAL_ENV_RULES: readonly ProviderCredentialEnvRule[] =
  [
    {
      shortName: "cloudflare",
      match: /(^|\/)cloudflare\/cloudflare$/,
      cloudFamily: "cloudflare",
      envNames: [
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_ZONE_ID",
        "CF_API_TOKEN",
      ],
      requiredGroups: [
        ["CLOUDFLARE_API_TOKEN"],
        ["CF_API_TOKEN"],
        ["CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"],
      ],
    },
    {
      shortName: "aws",
      match: /(^|\/)hashicorp\/aws$/,
      cloudFamily: "aws",
      envNames: [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
      ],
      requiredGroups: [
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        ["AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"],
      ],
    },
    {
      shortName: "google",
      match: /(^|\/)hashicorp\/google$/,
      cloudFamily: "gcp",
      envNames: [
        "GOOGLE_CREDENTIALS",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_PROJECT",
        "GOOGLE_REGION",
      ],
      requiredGroups: [
        ["GOOGLE_CREDENTIALS"],
        ["GOOGLE_APPLICATION_CREDENTIALS"],
      ],
    },
    {
      shortName: "azurerm",
      match: /(^|\/)hashicorp\/azurerm$/,
      cloudFamily: "local-adapters",
      envNames: [
        "ARM_CLIENT_ID",
        "ARM_CLIENT_SECRET",
        "ARM_TENANT_ID",
        "ARM_SUBSCRIPTION_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_TENANT_ID",
        "AZURE_SUBSCRIPTION_ID",
      ],
      requiredGroups: [
        [
          "ARM_CLIENT_ID",
          "ARM_CLIENT_SECRET",
          "ARM_TENANT_ID",
          "ARM_SUBSCRIPTION_ID",
        ],
        [
          "AZURE_CLIENT_ID",
          "AZURE_CLIENT_SECRET",
          "AZURE_TENANT_ID",
          "AZURE_SUBSCRIPTION_ID",
        ],
      ],
    },
    {
      shortName: "github",
      match: /(^|\/)(integrations\/github|github\/github)$/,
      cloudFamily: "local-adapters",
      envNames: ["GITHUB_TOKEN"],
      requiredGroups: [["GITHUB_TOKEN"]],
    },
    {
      shortName: "digitalocean",
      match: /(^|\/)digitalocean\/digitalocean$/,
      cloudFamily: "local-adapters",
      envNames: [
        "DIGITALOCEAN_TOKEN",
        "SPACES_ACCESS_KEY_ID",
        "SPACES_SECRET_ACCESS_KEY",
      ],
      requiredGroups: [["DIGITALOCEAN_TOKEN"]],
    },
    {
      shortName: "vercel",
      match: /(^|\/)vercel\/vercel$/,
      cloudFamily: "local-adapters",
      envNames: ["VERCEL_API_TOKEN"],
      requiredGroups: [["VERCEL_API_TOKEN"]],
    },
    {
      shortName: "kubernetes",
      match: /(^|\/)hashicorp\/kubernetes$/,
      cloudFamily: "k8s",
      envNames: [
        "KUBE_CONFIG_PATH",
        "KUBE_HOST",
        "KUBE_TOKEN",
        "KUBE_CLUSTER_CA_CERT_DATA",
      ],
      requiredGroups: [["KUBE_CONFIG_PATH"], ["KUBE_HOST", "KUBE_TOKEN"]],
    },
    {
      shortName: "helm",
      match: /(^|\/)hashicorp\/helm$/,
      cloudFamily: "k8s",
      envNames: [
        "KUBE_CONFIG_PATH",
        "KUBE_HOST",
        "KUBE_TOKEN",
        "KUBE_CLUSTER_CA_CERT_DATA",
      ],
      requiredGroups: [["KUBE_CONFIG_PATH"], ["KUBE_HOST", "KUBE_TOKEN"]],
    },
  ] as const;

/**
 * Resolves the rule for a provider given either its short name or its full /
 * partial registry path. Returns `undefined` for an unknown provider.
 */
export function providerEnvRule(
  provider: string,
): ProviderCredentialEnvRule | undefined {
  const trimmed = provider.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed === "gcp" ? "google" : trimmed;
  return PROVIDER_CREDENTIAL_ENV_RULES.find(
    (rule) => rule.shortName === normalized || rule.match.test(normalized),
  );
}

/**
 * Hierarchical, one-directional provider match: a fully-qualified provider
 * address (`registry/namespace/type`) matches a short allowlist rule (its
 * trailing type), e.g. `registry.opentofu.org/cloudflare/cloudflare` matches
 * rule `cloudflare`. The reverse must NOT hold — a specific fully-qualified
 * RULE must not admit an ambiguous bare provider name (e.g. rule
 * `registry.opentofu.org/hashicorp/aws` must not match provider `aws`), which
 * would silently widen the allowlist (and inconsistently narrow the denylist).
 *
 * Used by the layered plan-policy provider allow/deny evaluators.
 */
export function providerMatches(provider: string, rule: string): boolean {
  return provider === rule || provider.endsWith(`/${rule}`);
}

/**
 * Bidirectional "same OpenTofu provider family" test: true when two provider
 * identifiers name the same provider, matching a short name (`cloudflare`)
 * against a canonical registry address
 * (`registry.opentofu.org/cloudflare/cloudflare`) through this env-rule table.
 * Unlike {@link providerMatches} this is symmetric — used by the Vault credential
 * mint and ProviderConnection resolution, which must key the same way regardless
 * of argument order. Returns `false` when either side is an
 * unknown provider that is not an exact string match.
 */
export function sameProviderFamily(left: string, right: string): boolean {
  if (left === right) return true;
  const lrule = providerEnvRule(left);
  const rrule = providerEnvRule(right);
  return lrule !== undefined && lrule === rrule;
}

/**
 * Returns the sorted set of env names a provider may supply. An unknown
 * provider yields an empty list.
 */
export function allowedEnvNamesForProvider(
  provider: string,
): readonly string[] {
  const rule = providerEnvRule(provider);
  if (!rule) return [];
  return [...rule.envNames].sort();
}

/**
 * Cloud family that owns the sealed secret blob partition for a provider.
 * Unknown providers fall back to the `local-adapters` family.
 */
export function cloudFamilyForProvider(provider: string): ProviderCloudFamily {
  return providerEnvRule(provider)?.cloudFamily ?? "local-adapters";
}

/**
 * True when the supplied env names satisfy at least one required group for the
 * provider. When the provider has no required groups, any single supplied env
 * name suffices. Unknown providers are never satisfied.
 */
export function requiredEnvGroupsSatisfied(
  provider: string,
  suppliedEnvNames: Iterable<string>,
): boolean {
  const rule = providerEnvRule(provider);
  if (!rule) return false;
  const supplied = new Set(suppliedEnvNames);
  if (rule.requiredGroups.length === 0) {
    return rule.envNames.some((name) => supplied.has(name));
  }
  return rule.requiredGroups.some((group) =>
    group.every((name) => supplied.has(name)),
  );
}

/**
 * Returns the list of env-name groups, at least one of which must be present.
 * Used to build a "missing env groups" error without leaking values.
 */
export function requiredEnvGroupsForProvider(
  provider: string,
): readonly (readonly string[])[] {
  return providerEnvRule(provider)?.requiredGroups ?? [];
}

// ---------------------------------------------------------------------------
// Per-alias credential split for Takosumi generated root modules.
// ---------------------------------------------------------------------------

/**
 * One credential arg a provider alias block reads from a generated
 * `TF_VAR_<provider>_<alias>_<arg>` variable.
 *   - `envName`: the credential env name the Vault opens from the resolved
 *     Connection (e.g. `CLOUDFLARE_API_TOKEN`);
 *   - `arg`: the OpenTofu provider argument the credential maps to (e.g.
 *     `api_token`), used both as the rootgen variable suffix and as the alias
 *     argument the generated block assigns from that variable.
 */
export interface ProviderCredentialArg {
  readonly envName: string;
  readonly arg: string;
}

/**
 * Per-provider credential env-name -> OpenTofu provider-argument mapping for the
 * per-alias credential split. A provider listed here gets, for each resolved
 * provider alias, a `TF_VAR_<localProvider>_<alias>_<arg>` variable wired into
 * its alias block (rootgen) whose value the Vault mints from the resolved
 * Connection (vault). A provider ABSENT from this table keeps the credential-free
 * shared-env alias (rootgen) and is never split (vault), preserving the M5
 * credential-free behavior for providers without an explicit root-only arg
 * mapping.
 *
 * Lives next to {@link PROVIDER_CREDENTIAL_ENV_RULES} so the runner, the vault,
 * and rootgen agree byte-for-byte on env name <-> provider arg.
 */
export const PROVIDER_CREDENTIAL_ARG_MAP: Readonly<
  Record<string, readonly ProviderCredentialArg[]>
> = {
  cloudflare: [{ envName: "CLOUDFLARE_API_TOKEN", arg: "api_token" }],
  aws: [
    { envName: "AWS_ACCESS_KEY_ID", arg: "access_key" },
    { envName: "AWS_SECRET_ACCESS_KEY", arg: "secret_key" },
    { envName: "AWS_SESSION_TOKEN", arg: "token" },
  ],
};

/**
 * Returns the credential arg mapping for a provider (short name or registry
 * path). An empty list means the provider has no per-alias split: its alias
 * stays credential-free and cannot receive provider credentials through the
 * root-only path.
 */
export function providerCredentialArgs(
  provider: string,
): readonly ProviderCredentialArg[] {
  const rule = providerEnvRule(provider);
  if (!rule) return [];
  return PROVIDER_CREDENTIAL_ARG_MAP[rule.shortName] ?? [];
}
