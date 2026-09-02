import { isOpenTofuIdentifier } from "./provider-env-rules.ts";

export type CredentialRecipeMaterialSource =
  "secret" | "value" | "generated" | "literal" | "user_defined";

export interface CredentialRecipeMaterial {
  readonly from: CredentialRecipeMaterialSource;
  readonly name?: string;
  readonly value?: string;
}

export interface CredentialRecipeFileMaterial extends CredentialRecipeMaterial {
  readonly envName?: string;
  readonly mode?: number;
}

export interface CredentialRecipePreRunAction {
  /**
   * Open action-driver token. Core validates it against the installed recipe
   * driver registry at dispatch time; adding a provider flow must not require a
   * shared-contract enum change.
   */
  readonly type: string;
  readonly inputs?: Readonly<Record<string, CredentialRecipeMaterial>>;
}

/**
 * Localized, non-secret presentation copy carried by a CredentialRecipe.
 * Locale keys are open BCP-47 language tags. Consumers fall back to `en`, then
 * to the first available value; adding a locale never changes execution.
 */
export type CredentialRecipePresentationText =
  string | Readonly<Record<string, string>>;

export interface CredentialRecipeInputHint {
  readonly label?: CredentialRecipePresentationText;
  readonly placeholder?: CredentialRecipePresentationText;
  readonly required?: boolean;
  /** A secret material is always rendered as secret even when this is false. */
  readonly secret?: boolean;
  /** Hides an env alias from the guided form without changing materialization. */
  readonly hidden?: boolean;
}

export interface CredentialRecipeSetupGuide {
  /** External provider/operator documentation or credential setup page. */
  readonly url: string;
  readonly steps?: readonly CredentialRecipePresentationText[];
}

/**
 * Optional dashboard/CLI guidance for one auth mode. This is presentation-only
 * metadata: it cannot admit a provider, create values, select a driver, or
 * alter the env/files/preRun recipe.
 */
export interface CredentialRecipeAuthModePresentation {
  /** Explicit opt-in to the generic Provider Connection form. */
  readonly showInConnectionSetup?: boolean;
  readonly displayName?: CredentialRecipePresentationText;
  readonly description?: CredentialRecipePresentationText;
  readonly setupGuide?: CredentialRecipeSetupGuide;
}

export interface CredentialRecipeAuthMode {
  readonly env?: Readonly<Record<string, CredentialRecipeMaterial>>;
  readonly files?: Readonly<Record<string, CredentialRecipeFileMaterial>>;
  readonly preRun?: CredentialRecipePreRunAction;
  /**
   * Declares that this mode stores no credential material and lets its exact
   * pre-run driver issue a credential only for a canonical, running Capsule
   * Run. This descriptor is closed deliberately: new authority modes require
   * a contract revision instead of provider-name or URL inference.
   */
  readonly runIssuance?: CredentialRecipeRunIssuance;
  /**
   * Run-scoped sensitive provider inputs this auth mode's provider understands.
   * It declares only the PROTOCOL SHAPE — the two provider-block argument names
   * the provider reads. It never carries, names, or selects a value: the value
   * set is the Capsule's manifest-gated runtime binding profile, minted per Run
   * by the host and delivered to OpenTofu as an Apply-only ephemeral variable.
   */
  readonly runtimeInputs?: CredentialRecipeRuntimeInputs;
  /**
   * Optional service-side form hints. They are presentation only: Core derives
   * execution exclusively from env/files/preRun and never treats a hint as
   * credential material or admission authority.
   */
  readonly inputHints?: Readonly<Record<string, CredentialRecipeInputHint>>;
  readonly presentation?: CredentialRecipeAuthModePresentation;
}

export interface CredentialRecipeRunIssuance {
  readonly context: "capsule-run.v1";
  readonly operatorConnection: "workspace-bindable";
  readonly storedMaterial: "none";
  /** Exact host-owned audience. A recipe driver cannot redirect issuance. */
  readonly audience: string;
  /** Exact minimal scope set minted for every phase of this recipe mode. */
  readonly scopes: readonly string[];
}

export const PROVIDER_RUNTIME_INPUTS_CONTRACT =
  "takosumi.provider-runtime-inputs/v1" as const;

/**
 * Protocol shape for run-scoped sensitive provider inputs.
 *
 * A provider that understands this protocol reads two provider-block arguments:
 * a plan-stable nonce and an Apply-only sensitive `map(string)`. This descriptor
 * names ONLY those two arguments. It is deliberately value-free: it can never
 * carry material, select a value source, or widen the name set. The exact names
 * that may be delivered come from the Capsule's manifest-gated runtime binding
 * profile, and the values are minted per Run by the host.
 */
export interface CredentialRecipeRuntimeInputs {
  readonly contract: typeof PROVIDER_RUNTIME_INPUTS_CONTRACT;
  /** Provider-block argument receiving the plan-stable nonce. */
  readonly nonceArgument: string;
  /** Provider-block argument receiving the Apply-only sensitive map. */
  readonly mapArgument: string;
  /**
   * Lowest exact provider version that accepts the two arguments.
   *
   * Below it the arguments do not exist in the provider schema and a plan fails
   * with `Unsupported argument`, so the wiring must stay inert instead. It is a
   * property of the provider's own contract, which is why the recipe — the one
   * place that already knows which provider understands the protocol — is what
   * declares it.
   */
  readonly minimumProviderVersion: string;
}

/**
 * Closed check for the only run-scoped sensitive input descriptor v1 supports.
 * Both argument names must be distinct OpenTofu identifiers, neither may shadow
 * the `alias` meta-argument of a provider block, and the version floor must be
 * an exact release.
 */
export function isProviderRuntimeInputs(
  value: unknown,
): value is CredentialRecipeRuntimeInputs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record.contract === PROVIDER_RUNTIME_INPUTS_CONTRACT &&
    isRuntimeInputArgumentName(record.nonceArgument) &&
    isRuntimeInputArgumentName(record.mapArgument) &&
    record.nonceArgument !== record.mapArgument &&
    isExactProviderVersion(record.minimumProviderVersion)
  );
}

/** Set-exact comparison for the descriptor pinned on a recipe/Connection. */
export function sameProviderRuntimeInputs(
  left: unknown,
  right: unknown,
): boolean {
  return (
    isProviderRuntimeInputs(left) &&
    isProviderRuntimeInputs(right) &&
    left.nonceArgument === right.nonceArgument &&
    left.mapArgument === right.mapArgument &&
    left.minimumProviderVersion === right.minimumProviderVersion
  );
}

/**
 * Whether a Capsule's pinned provider version PROVES the arguments exist.
 *
 * Only an exact version proves anything: a range, or no declared version at
 * all, could resolve to a provider release that never had them. An unproven
 * version leaves the wiring inert rather than baking arguments into a reviewed
 * root that the provider will reject.
 */
export function providerVersionMeetsRuntimeInputFloor(
  version: string | undefined,
  minimumProviderVersion: string,
): boolean {
  if (
    !isExactProviderVersion(version) ||
    !isExactProviderVersion(minimumProviderVersion)
  ) {
    return false;
  }
  return compareExactProviderVersions(version, minimumProviderVersion) >= 0;
}

const EXACT_PROVIDER_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function isExactProviderVersion(value: unknown): value is string {
  return typeof value === "string" && EXACT_PROVIDER_VERSION.test(value);
}

/** Semantic-version precedence: build metadata is ignored, prereleases rank low. */
function compareExactProviderVersions(left: string, right: string): number {
  const [leftCore, leftPre] = splitProviderVersion(left);
  const [rightCore, rightPre] = splitProviderVersion(right);
  for (let index = 0; index < 3; index++) {
    const difference = leftCore[index]! - rightCore[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (leftPre === undefined && rightPre === undefined) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  return comparePrereleaseIdentifiers(leftPre, rightPre);
}

function splitProviderVersion(
  value: string,
): [readonly number[], readonly string[] | undefined] {
  const withoutBuild = value.split("+", 1)[0]!;
  const dash = withoutBuild.indexOf("-");
  const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash))
    .split(".")
    .map((part) => Number(part));
  const prerelease =
    dash < 0 ? undefined : withoutBuild.slice(dash + 1).split(".");
  return [core, prerelease];
}

function comparePrereleaseIdentifiers(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function isRuntimeInputArgumentName(value: unknown): value is string {
  return isOpenTofuIdentifier(value) && value !== "alias";
}

/**
 * Machine-readable Provider Connection recipe contract.
 *
 * Service-installed recipes are guided setup and validation helpers. They do
 * not form a provider allowlist: arbitrary OpenTofu/Terraform providers can
 * still run with an installed `declaredEnv` recipe whose declared env/file
 * names become the run-local recipe. Recipe ids are opaque and Core assigns no
 * special behavior to a reference-catalog id.
 */
export interface CredentialRecipe {
  readonly id: string;
  readonly displayName: string;
  /** Optional opaque default copied to each ProviderConnection at creation. */
  readonly secretPartition?: string;
  readonly terraformSource: readonly string[] | "*";
  readonly envNames?: readonly string[];
  readonly requiredEnvGroups?: readonly (readonly string[])[];
  readonly declaredEnv?: boolean;
  readonly authModes: Readonly<Record<string, CredentialRecipeAuthMode>>;
}

export interface CredentialRecipeResponse {
  readonly recipe: CredentialRecipe;
}

/**
 * Non-secret, immutable credential delivery contract sent with one runner
 * dispatch and covered by the Run environment digest. The runner admits only
 * names/files present here; provider names never select an env catalog.
 */
export interface RunCredentialRecipeBinding {
  readonly providerSource: string;
  readonly alias?: string;
  readonly connectionId: string;
  readonly recipeId: string;
  readonly authMode: string;
  readonly envNames: readonly string[];
  readonly fileEnvNames: readonly string[];
  readonly requiredEnvGroups: readonly (readonly string[])[];
}

export interface RunCredentialRecipeManifest {
  readonly bindings: readonly RunCredentialRecipeBinding[];
  readonly files?: readonly {
    readonly path: string;
    readonly mode: number;
    readonly envName?: string;
  }[];
}

export interface ListCredentialRecipesResponse {
  readonly recipes: readonly CredentialRecipe[];
}
import { INTERNAL_V1_PREFIX } from "./api-surface.ts";

export const CREDENTIAL_RECIPES_PATH =
  `${INTERNAL_V1_PREFIX}/credential-recipes` as const;
export const CREDENTIAL_RECIPE_PATH = (id: string): string =>
  `${CREDENTIAL_RECIPES_PATH}/${encodeURIComponent(id)}`;
