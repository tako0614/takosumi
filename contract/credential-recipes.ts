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
   * Optional service-side form hints. They are presentation only: Core derives
   * execution exclusively from env/files/preRun and never treats a hint as
   * credential material or admission authority.
   */
  readonly inputHints?: Readonly<Record<string, CredentialRecipeInputHint>>;
  readonly presentation?: CredentialRecipeAuthModePresentation;
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
