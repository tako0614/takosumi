export type CredentialRecipeMaterialSource =
  | "secret"
  | "value"
  | "generated"
  | "literal"
  | "user_defined";

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
  readonly type:
    | "aws_sts_assume_role"
    | "gcp_service_account_impersonation"
    | "provider_specific";
  readonly inputs?: Readonly<Record<string, CredentialRecipeMaterial>>;
}

export interface CredentialRecipeAuthMode {
  readonly env?: Readonly<Record<string, CredentialRecipeMaterial>>;
  readonly files?: Readonly<Record<string, CredentialRecipeFileMaterial>>;
  readonly preRun?: CredentialRecipePreRunAction;
}

/**
 * Machine-readable Provider Connection recipe contract.
 *
 * Built-in recipes are guided setup and validation helpers. They do not form a
 * provider allowlist: arbitrary OpenTofu/Terraform providers can still run with
 * a generic-env ProviderConnection whose declared env/file names become the
 * run-local recipe.
 */
export interface CredentialRecipe {
  readonly id: string;
  readonly displayName: string;
  readonly providerRule?: string;
  readonly terraformSource: readonly string[] | "*";
  readonly envNames?: readonly string[];
  readonly requiredEnvGroups?: readonly (readonly string[])[];
  readonly declaredEnv?: boolean;
  readonly authModes: Readonly<Record<string, CredentialRecipeAuthMode>>;
}
