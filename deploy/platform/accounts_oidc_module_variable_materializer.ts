import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "../../accounts/service/src/store.ts";
import { oidcClientActivationDigest } from "../../accounts/service/src/oidc-activation.ts";
import type { Capsule } from "../../contract/capsules.ts";
import type { InstallConfig } from "../../contract/install-configs.ts";
import { installExperienceOidcClient } from "../../contract/install-experience.ts";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import type {
  CapsuleModuleVariableMaterialization,
  CapsuleModuleVariableMaterializer,
} from "../../core/domains/deploy-control/module_variable_materializer.ts";
import {
  accountsOidcModuleVariableProfile,
  type RepositoryAccountsOidcModuleVariableProfile,
} from "../../core/domains/deploy-control/accounts_oidc_module_variable_profile.ts";
import {
  deriveCapsulePublicOidcClientIdentity,
  derivePublicOidcClientId,
  registerCapsulePublicOidcClient,
  validateCapsulePublicOidcClientRegistration,
} from "./accounts_oidc_client_registration.ts";

const SUBJECT = /^tsub_[A-Za-z0-9_-]{1,128}$/u;
const OIDC_SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;

type ExactAccountsOidcModuleVariableProfile =
  RepositoryAccountsOidcModuleVariableProfile;

export interface AccountsOidcModuleVariableControlLedger {
  getCapsule(id: string): Promise<
    | Pick<
        Capsule,
        | "id"
        | "workspaceId"
        | "name"
        | "installConfigId"
        | "installingPrincipalId"
        | "status"
      >
    | undefined
  >;
  getInstallConfig(id: string): Promise<InstallConfig | undefined>;
}

export type AccountsOidcModuleVariableAccountsLedger = Pick<
  AccountsStore,
  | "findOidcClient"
  | "findOidcClientForCapsule"
  | "saveOidcClient"
  | "revokeOidcClient"
>;

export function createTakosumiAccountsOidcModuleVariableMaterializer(input: {
  readonly control: AccountsOidcModuleVariableControlLedger;
  readonly accounts: AccountsOidcModuleVariableAccountsLedger;
  readonly issuer: string;
  readonly pairwiseSubjectSecret: string;
  readonly clock?: () => Date;
}): CapsuleModuleVariableMaterializer {
  const issuer = exactHttpsOrigin(input.issuer);
  const pairwiseSubjectSecret = boundedSecret(
    input.pairwiseSubjectSecret,
    "pairwiseSubjectSecret",
  );
  const clock = input.clock ?? (() => new Date());

  const materialize: CapsuleModuleVariableMaterializer["materialize"] = async (
    call,
  ) => {
    if (call.phase !== "plan" && call.expectedDigest === undefined) {
      invalid("Accounts OIDC module-variable phase guard is invalid");
    }
    const currentCapsule = await input.control.getCapsule(call.capsule.id);
    if (!sameCapsuleAuthority(currentCapsule, call.capsule)) {
      invalid("Accounts OIDC module-variable Capsule is not current");
    }
    const currentConfig = await input.control.getInstallConfig(
      currentCapsule.installConfigId,
    );
    if (
      !currentConfig ||
      currentConfig.id !== currentCapsule.installConfigId ||
      currentConfig.workspaceId !== currentCapsule.workspaceId ||
      (await stableJsonDigest(currentConfig)) !==
        (await stableJsonDigest(call.installConfig))
    ) {
      invalid("Accounts OIDC module-variable InstallConfig is not current");
    }
    const capsuleExecutionAuthorityEpoch = exactExecutionAuthorityEpoch(
      call.capsuleExecutionAuthorityEpoch,
    );
    const resolvedProfile = accountsOidcModuleVariableProfile(currentConfig);
    if (!resolvedProfile) {
      if (call.expectedDigest !== undefined) {
        invalid("Accounts OIDC module-variable materialization was removed");
      }
      return undefined;
    }
    const exact = exactRepositoryProfile(resolvedProfile, currentConfig);
    assertExactMaterializerInputVariables(call.variables, exact);
    const publicOrigin = exactPublicOrigin(call.variables, exact);
    const installingPrincipalId = currentCapsule.installingPrincipalId;
    if (
      typeof installingPrincipalId !== "string" ||
      !SUBJECT.test(installingPrincipalId)
    ) {
      invalid("Accounts OIDC module-variable installing Principal is missing");
    }
    const callbackPath = exactCallbackPath(exact.callbackPath);
    const scopes = exactScopes(exact.scopes);
    const grant = installExperienceOidcClient(currentConfig.installExperience);
    if (
      !grant ||
      grant.callbackPath !== callbackPath ||
      !sameStrings(grant.scopes ?? [], scopes) ||
      grant.issuerUrlVariable !== exact.issuerUrlVariable ||
      grant.accountsUrlVariable !== exact.accountsUrlVariable ||
      grant.clientIdVariable !== exact.clientIdVariable ||
      grant.redirectUriVariable !== exact.redirectUriVariable
    ) {
      invalid("Accounts OIDC module-variable grant is not exact");
    }
    const activationDigest = await oidcClientActivationDigest({
      workspaceId: currentCapsule.workspaceId,
      capsuleId: currentCapsule.id,
      executionAuthorityEpoch: capsuleExecutionAuthorityEpoch,
      installConfig: currentConfig,
    });
    const clientId = await derivePublicOidcClientId(
      pairwiseSubjectSecret,
      [
        "takosumi-accounts-repository-oidc-client-v1",
        currentCapsule.workspaceId,
        currentCapsule.id,
      ],
    );
    const derived = await deriveCapsulePublicOidcClientIdentity({
      capsule: currentCapsule,
      installingPrincipalId: installingPrincipalId as TakosumiSubject,
      publicOrigin,
      callbackPath,
      clientId,
      pairwiseSubjectSecret,
    });
    const digest = await stableJsonDigest({
      contract: exact.source,
      workspaceId: currentCapsule.workspaceId,
      capsuleId: currentCapsule.id,
      capsuleName: currentCapsule.name,
      capsuleExecutionAuthorityEpoch,
      installConfigId: currentConfig.id,
      installConfigUpdatedAt: currentConfig.updatedAt,
      installingPrincipalId,
      profile: exact,
      publicOrigin,
      issuer,
      clientId,
      redirectUri: derived.redirectUri,
      callbackPath,
      scopes,
    });
    if (call.expectedDigest !== undefined && call.expectedDigest !== digest) {
      invalid(
        "Accounts OIDC module-variable materialization changed since Plan",
      );
    }
    const variables = {
      [exact.accountsUrlVariable]: issuer,
      [exact.issuerUrlVariable]: issuer,
      [exact.clientIdVariable]: derived.clientId,
      [exact.redirectUriVariable]: derived.redirectUri,
    };
    if (call.phase !== "plan") {
      assertExactPlannedVariables(call.plannedVariables, variables);
    }
    const registrationInput = {
      accounts: input.accounts,
      capsule: currentCapsule,
      installingPrincipalId: installingPrincipalId as TakosumiSubject,
      issuer,
      publicOrigin,
      callbackPath,
      scopes,
      clientId,
      activationDigest,
      pairwiseSubjectSecret,
    };
    const registered = call.phase === "apply"
      ? await registerCapsulePublicOidcClient({
          ...registrationInput,
          clock,
        })
      : (await validateCapsulePublicOidcClientRegistration(registrationInput))
        .identity;
    if (
      registered.clientId !== derived.clientId ||
      registered.ownerSubject !== derived.ownerSubject ||
      registered.redirectUri !== derived.redirectUri
    ) {
      invalid("Accounts OIDC registration differs from the reviewed Plan");
    }
    return {
      digest,
      variables,
    } satisfies CapsuleModuleVariableMaterialization;
  };

  return {
    materialize,
    async retire(call) {
      if (call.capsule.status !== "destroyed") {
        invalid(
          "Accounts OIDC client retirement requires a terminal Capsule",
        );
      }
      // Re-run the full read-only authority path against the terminal Capsule:
      // current Capsule + InstallConfig, pinned digest/variables, and exact
      // Accounts client shape.
      // This path can validate or delete; it can never call saveOidcClient.
      const current = await materialize({ ...call, phase: "apply_check" });
      const resolvedProfile = accountsOidcModuleVariableProfile(
        call.installConfig,
      );
      if (!current || !resolvedProfile) {
        invalid("Accounts OIDC client retirement authority is missing");
      }
      const clientId = current.variables[resolvedProfile.clientIdVariable];
      if (typeof clientId !== "string" || clientId.length === 0) {
        invalid("Accounts OIDC client retirement identity is invalid");
      }
      // AccountsStore owns physical retirement. Every implementation treats
      // an absent registration as success, making crash/retry cleanup
      // idempotent without creating a second lifecycle ledger.
      await input.accounts.revokeOidcClient(clientId);
    },
  };
}

function assertExactPlannedVariables(
  planned: Readonly<Record<string, unknown>> | undefined,
  current: Readonly<Record<string, unknown>>,
): void {
  if (!planned) {
    invalid("Accounts OIDC planned module variables are missing");
  }
  const plannedNames = Object.keys(planned).sort();
  const currentNames = Object.keys(current).sort();
  if (
    plannedNames.length !== currentNames.length ||
    plannedNames.some((name, index) => name !== currentNames[index]) ||
    currentNames.some((name) => planned[name] !== current[name])
  ) {
    invalid("Accounts OIDC planned module variable values changed");
  }
}

function sameCapsuleAuthority(
  current:
    | Awaited<
        ReturnType<AccountsOidcModuleVariableControlLedger["getCapsule"]>
      >
    | undefined,
  expected: Capsule,
): current is NonNullable<typeof current> {
  return Boolean(
    current &&
      current.id === expected.id &&
      current.workspaceId === expected.workspaceId &&
      current.name === expected.name &&
      current.installConfigId === expected.installConfigId &&
      current.installingPrincipalId === expected.installingPrincipalId &&
      current.status === expected.status,
  );
}

function exactRepositoryProfile(
  profile: RepositoryAccountsOidcModuleVariableProfile,
  installConfig: InstallConfig,
): RepositoryAccountsOidcModuleVariableProfile {
  const callbackPath = exactCallbackPath(profile.callbackPath);
  const scopes = exactScopes(profile.scopes);
  const allowedScopes =
    installConfig.policy.repositoryInstallUx?.allowedOidcScopes;
  if (
    !Array.isArray(allowedScopes) ||
    allowedScopes.length === 0 ||
    new Set(allowedScopes).size !== allowedScopes.length ||
    allowedScopes.some((scope) => !OIDC_SCOPE.test(scope)) ||
    scopes.some((scope) => !allowedScopes.includes(scope))
  ) {
    invalid("Accounts OIDC repository scopes exceed current operator policy");
  }
  return { ...profile, callbackPath, scopes };
}

function exactPublicOrigin(
  variables: Readonly<Record<string, unknown>>,
  profile: ExactAccountsOidcModuleVariableProfile,
): string {
  const reviewed = variables[profile.publicUrlVariable];
  if (typeof reviewed !== "string" || reviewed.length === 0) {
    invalid("Accounts OIDC reviewed public URL is missing or invalid");
  }
  return exactHttpsOrigin(reviewed);
}

function assertExactMaterializerInputVariables(
  variables: Readonly<Record<string, unknown>>,
  profile: ExactAccountsOidcModuleVariableProfile,
): void {
  const names = Object.keys(variables);
  if (names.length !== 1 || names[0] !== profile.publicUrlVariable) {
    invalid(
      "Accounts OIDC materializer requires only the reviewed public URL input",
    );
  }
}

function exactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("Accounts OIDC HTTPS origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    invalid("Accounts OIDC HTTPS origin is invalid");
  }
  return url.origin;
}

function exactCallbackPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid("Accounts OIDC callback path is invalid");
  }
  return value;
}

function exactScopes(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some((scope) => !OIDC_SCOPE.test(scope)) ||
    new Set(value).size !== value.length ||
    !value.includes("openid")
  ) {
    invalid("Accounts OIDC scopes are invalid");
  }
  return value;
}

function exactExecutionAuthorityEpoch(value: number | undefined): number {
  const epoch = value ?? 1;
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    invalid("Accounts OIDC Capsule execution authority is invalid");
  }
  return epoch;
}

function boundedSecret(value: string, label: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 32 || bytes > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function invalid(message: string): never {
  throw new TypeError(message);
}
