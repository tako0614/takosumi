import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "../../accounts/service/src/store.ts";
import { oidcClientActivationDigest } from "../../accounts/service/src/oidc-activation.ts";
import type { Capsule } from "../../contract/capsules.ts";
import { isWorkspaceBindableOperatorConnection } from "../../contract/connections.ts";
import type {
  InstallConfig,
  InstallConfigAccountsOidcModuleVariableMaterialization,
} from "../../contract/install-configs.ts";
import { installExperienceOidcClient } from "../../contract/install-experience.ts";
import { isSecretKey } from "../../contract/redaction.ts";
import { sameProviderSource } from "../../contract/provider-env-rules.ts";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import type { ResolvedCapsuleProviderBinding } from "../../core/domains/connections/mod.ts";
import type {
  CapsuleModuleVariableMaterialization,
  CapsuleModuleVariableMaterializer,
} from "../../core/domains/deploy-control/module_variable_materializer.ts";
import { CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY } from "../../providers/cloudflare/credentials.ts";
import {
  deriveCapsulePublicOidcClientIdentity,
  derivePublicOidcClientId,
  registerCapsulePublicOidcClient,
  validateCapsulePublicOidcClientRegistration,
} from "./accounts_oidc_client_registration.ts";

const PAIRWISE_PROFILE_CONTRACT =
  "takosumi.accounts-oidc-module-variables/v1" as const;
const BROWSER_PROFILE_CONTRACT =
  "takosumi.accounts-oidc-module-variables/v2" as const;
const CLOUDFLARE_PROVIDER =
  "registry.opentofu.org/cloudflare/cloudflare" as const;
const PAIRWISE_CALLBACK_PATH = "/api/auth/callback/takos" as const;
const PAIRWISE_SCOPES = ["openid", "profile", "email"] as const;
const FLAT_CLOUDFLARE_TARGET_VARIABLES = [
  "cloudflare_account_id",
  "cloudflare_workers_subdomain",
] as const;
const OPENTOFU_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const WORKER_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CLOUDFLARE_ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const SUBJECT = /^tsub_[A-Za-z0-9_-]{1,128}$/u;
const OIDC_SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;

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
    const profile = currentConfig.accountsOidcModuleVariableMaterialization;
    if (!profile) {
      if (call.expectedDigest !== undefined) {
        invalid("Accounts OIDC module-variable materialization was removed");
      }
      return undefined;
    }
    const exact = exactProfile(profile);
    assertExactMaterializerInputVariables(call.variables, exact);
    const binding = exactCloudflareBinding(
      call.resolvedProviderBindings,
      currentCapsule.workspaceId,
    );
    const metadata = verifiedCloudflareMetadata(binding);
    if (exact.contract === PAIRWISE_PROFILE_CONTRACT) {
      assertModuleCloudflareTargetsMatchVerifiedMetadata(
        call.variables,
        metadata,
      );
    } else {
      assertInstallConfigCloudflareTargetsMatchVerifiedMetadata(
        currentConfig,
        metadata,
      );
    }
    const resourceName = exactResourceName(call.variables, exact);
    const publicOrigin = exactPublicOrigin(
      call.variables,
      exact,
      resourceName,
      metadata.workersSubdomain,
    );
    const installingPrincipalId = currentCapsule.installingPrincipalId;
    if (
      typeof installingPrincipalId !== "string" ||
      !SUBJECT.test(installingPrincipalId)
    ) {
      invalid("Accounts OIDC module-variable installing Principal is missing");
    }
    const callbackPath = profileCallbackPath(exact);
    const scopes = profileScopes(exact);
    const grant = installExperienceOidcClient(currentConfig.installExperience);
    if (
      !grant ||
      grant.callbackPath !== callbackPath ||
      !sameStrings(grant.scopes ?? [], scopes) ||
      grant.issuerUrlVariable !== undefined ||
      grant.accountsUrlVariable !== undefined ||
      grant.clientIdVariable !== undefined ||
      grant.redirectUriVariable !== undefined
    ) {
      invalid("Accounts OIDC module-variable grant is not exact");
    }
    const activationDigest = await oidcClientActivationDigest({
      workspaceId: currentCapsule.workspaceId,
      capsuleId: currentCapsule.id,
      executionAuthorityEpoch: capsuleExecutionAuthorityEpoch,
      installConfig: currentConfig,
    });
    const clientProfileDigest = await stableJsonDigest({
      profile: exact,
      callbackPath,
      scopes,
    });
    const clientId = await derivePublicOidcClientId(
      pairwiseSubjectSecret,
      exact.contract === PAIRWISE_PROFILE_CONTRACT
        ? [
            "takosumi-accounts-module-oidc-client-v1",
            currentCapsule.workspaceId,
            currentCapsule.id,
            currentConfig.id,
          ]
        : [
            "takosumi-accounts-module-oidc-client-v2",
            currentCapsule.workspaceId,
            currentCapsule.id,
            clientProfileDigest,
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
      contract: exact.contract,
      workspaceId: currentCapsule.workspaceId,
      capsuleId: currentCapsule.id,
      capsuleName: currentCapsule.name,
      capsuleExecutionAuthorityEpoch,
      installConfigId: currentConfig.id,
      installConfigUpdatedAt: currentConfig.updatedAt,
      installingPrincipalId,
      profile: exact,
      binding: {
        provider: binding.provider,
        connectionId: binding.connection.id,
        workspaceId: binding.connection.workspaceId,
        scope: binding.connection.scope,
        status: binding.connection.status,
        credentialRecipe: binding.connection.credentialRecipe,
        credentialVerification: binding.connection.credentialVerification,
        verifiedAt: binding.connection.verifiedAt,
        accountId: metadata.accountId,
        workersSubdomain: metadata.workersSubdomain,
      },
      resourceName,
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
    const variables = exact.contract === PAIRWISE_PROFILE_CONTRACT
      ? {
          [exact.issuerUrlVariable]: issuer,
          [exact.clientIdVariable]: derived.clientId,
          [exact.ownerSubjectVariable]: derived.ownerSubject,
          [exact.allowUnpinnedOwnerClaimVariable]: false,
        }
      : {
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
      // current Capsule + InstallConfig, pinned digest/variables, verified
      // non-secret ProviderBinding metadata, and exact Accounts client shape.
      // This path can validate or delete; it can never call saveOidcClient.
      const current = await materialize({ ...call, phase: "apply_check" });
      const profile = call.installConfig
        .accountsOidcModuleVariableMaterialization;
      if (!current || !profile) {
        invalid("Accounts OIDC client retirement authority is missing");
      }
      const clientId = current.variables[profile.clientIdVariable];
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

function exactProfile(
  profile: InstallConfigAccountsOidcModuleVariableMaterialization,
): InstallConfigAccountsOidcModuleVariableMaterialization {
  const pairwise = profile.contract === PAIRWISE_PROFILE_CONTRACT;
  if (!pairwise && profile.contract !== BROWSER_PROFILE_CONTRACT) {
    invalid("Accounts OIDC module-variable profile is invalid");
  }
  const allowedKeys = pairwise
    ? [
        "contract",
        "workerNameVariable",
        "projectNameVariable",
        "additionalInputVariables",
        "forbiddenNonEmptyInputVariables",
        "issuerUrlVariable",
        "clientIdVariable",
        "ownerSubjectVariable",
        "allowUnpinnedOwnerClaimVariable",
      ]
    : [
        "contract",
        "resourceNameVariable",
        "publicUrlVariable",
        "additionalInputVariables",
        "forbiddenNonEmptyInputVariables",
        "accountsUrlVariable",
        "issuerUrlVariable",
        "clientIdVariable",
        "redirectUriVariable",
        "callbackPath",
        "scopes",
      ];
  if (Object.keys(profile).some((key) => !allowedKeys.includes(key))) {
    invalid("Accounts OIDC module-variable profile is invalid");
  }
  const sourceAndTargetNames = pairwise
    ? [
        profile.workerNameVariable,
        profile.projectNameVariable,
        profile.issuerUrlVariable,
        profile.clientIdVariable,
        profile.ownerSubjectVariable,
        profile.allowUnpinnedOwnerClaimVariable,
      ]
    : [
        profile.resourceNameVariable,
        profile.publicUrlVariable,
        profile.accountsUrlVariable,
        profile.issuerUrlVariable,
        profile.clientIdVariable,
        profile.redirectUriVariable,
      ];
  const additionalInputVariables = profile.additionalInputVariables;
  const forbiddenNonEmptyInputVariables =
    profile.forbiddenNonEmptyInputVariables;
  if (
    !(pairwise
      ? sameStrings(
          additionalInputVariables ?? [],
          FLAT_CLOUDFLARE_TARGET_VARIABLES,
        )
      : sameStrings(additionalInputVariables ?? [], []) ||
        // Rows composed before the nested Cloudflare target fix carried these
        // output-shaped names. They were never root module inputs, so their
        // absence at materialization time is safe. Accept the sealed legacy
        // profile while validating the actual DB-owned `cloudflare` object.
        sameStrings(
          additionalInputVariables ?? [],
          FLAT_CLOUDFLARE_TARGET_VARIABLES,
        )) ||
    !sameStrings(
      forbiddenNonEmptyInputVariables ?? [],
      pairwise
        ? ["auth_password_hash", "notification_push_gateway_token"]
        : [],
    )
  ) {
    invalid("Accounts OIDC module-variable profile metadata inputs are not exact");
  }
  if (!pairwise) {
    exactCallbackPath(profile.callbackPath);
    exactScopes(profile.scopes);
  }
  const names = [
    ...sourceAndTargetNames,
    ...(additionalInputVariables ?? []),
    ...(forbiddenNonEmptyInputVariables ?? []),
  ];
  if (
    sourceAndTargetNames.some(
      (name) =>
        !OPENTOFU_VARIABLE.test(name) ||
        isSecretKey(name) ||
        name.toUpperCase() === "ENCRYPTION_KEY",
    ) ||
    names.some((name) => !OPENTOFU_VARIABLE.test(name))
  ) {
    invalid("Accounts OIDC module-variable target is invalid");
  }
  if (new Set(names).size !== names.length) {
    invalid("Accounts OIDC module-variable names must be unique");
  }
  return profile;
}

function exactCloudflareBinding(
  bindings: readonly ResolvedCapsuleProviderBinding[],
  workspaceId: string,
): ResolvedCapsuleProviderBinding {
  const candidates = bindings.filter(
    (entry) => entry.provider === CLOUDFLARE_PROVIDER,
  );
  if (candidates.length !== 1) {
    invalid("Accounts OIDC requires one exact Cloudflare ProviderBinding");
  }
  const binding = candidates[0]!;
  const connection = binding.connection;
  // `binding.provider` and `connection.providerSource` are the authoritative
  // resolver-normalized OpenTofu source. `connection.provider` is an opaque
  // recipe label and may use the equivalent unqualified spelling.
  if (
    !sameProviderSource(connection.providerSource, binding.provider) ||
    connection.status !== "verified" ||
    !connection.verifiedAt
  ) {
    invalid("Accounts OIDC requires a current verified Cloudflare connection");
  }
  if (
    connection.scope === "workspace"
      ? connection.workspaceId !== workspaceId
      : !isWorkspaceBindableOperatorConnection(connection)
  ) {
    invalid("Accounts OIDC Cloudflare connection scope authority is invalid");
  }
  if (
    !hasCanonicalCredentialVerificationCapability(
      connection.credentialVerification,
      CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
    )
  ) {
    invalid("Accounts OIDC Cloudflare verification capability is missing");
  }
  return binding;
}

function hasCanonicalCredentialVerificationCapability(
  verification: ResolvedCapsuleProviderBinding["connection"]["credentialVerification"],
  required: string,
): boolean {
  if (verification?.kind !== "takosumi.credential-verification@v1") {
    return false;
  }
  const capabilities = verification.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.length > 64 ||
    capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(capability),
    ) ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(
      (capability, index) => index > 0 && capabilities[index - 1]! >= capability,
    )
  ) {
    return false;
  }
  return capabilities.includes(required);
}

function verifiedCloudflareMetadata(binding: ResolvedCapsuleProviderBinding): {
  readonly accountId: string;
  readonly workersSubdomain: string;
} {
  const settings = binding.connection.scopeHints?.providerSettings;
  const defaults = binding.connection.scopeHints?.moduleInputDefaults;
  const accountId = settings?.accountId;
  const workersSubdomain = settings?.workersSubdomain;
  if (
    typeof accountId !== "string" ||
    typeof workersSubdomain !== "string" ||
    !CLOUDFLARE_ACCOUNT_ID.test(accountId) ||
    !WORKER_LABEL.test(workersSubdomain) ||
    defaults?.cloudflare_account_id !== accountId ||
    defaults?.cloudflare_workers_subdomain !== workersSubdomain
  ) {
    invalid("Accounts OIDC Cloudflare verified metadata is incomplete");
  }
  return { accountId, workersSubdomain };
}

function exactResourceName(
  variables: Readonly<Record<string, unknown>>,
  profile: InstallConfigAccountsOidcModuleVariableMaterialization,
): string {
  const selectedRaw = profile.contract === PAIRWISE_PROFILE_CONTRACT
    ? variables[profile.workerNameVariable] ||
      variables[profile.projectNameVariable]
    : variables[profile.resourceNameVariable];
  if (typeof selectedRaw !== "string") {
    invalid("Accounts OIDC Worker/project name is missing");
  }
  const selected = selectedRaw.trim();
  if (
    !selected ||
    selected !== selectedRaw ||
    !WORKER_LABEL.test(selected)
  ) {
    invalid("Accounts OIDC Worker/project name is invalid");
  }
  return selected;
}

function exactPublicOrigin(
  variables: Readonly<Record<string, unknown>>,
  profile: InstallConfigAccountsOidcModuleVariableMaterialization,
  resourceName: string,
  workersSubdomain: string,
): string {
  if (profile.contract === PAIRWISE_PROFILE_CONTRACT) {
    return exactHttpsOrigin(
      `https://${resourceName}.${workersSubdomain}.workers.dev`,
    );
  }
  const reviewed = variables[profile.publicUrlVariable];
  if (reviewed === undefined || reviewed === null || reviewed === "") {
    return exactHttpsOrigin(
      `https://${resourceName}.${workersSubdomain}.workers.dev`,
    );
  }
  if (typeof reviewed !== "string") {
    invalid("Accounts OIDC reviewed public URL is invalid");
  }
  return exactHttpsOrigin(reviewed);
}

function assertExactMaterializerInputVariables(
  variables: Readonly<Record<string, unknown>>,
  profile: InstallConfigAccountsOidcModuleVariableMaterialization,
): void {
  if (
    profile.contract === BROWSER_PROFILE_CONTRACT &&
    FLAT_CLOUDFLARE_TARGET_VARIABLES.some((name) =>
      Object.hasOwn(variables, name)
    )
  ) {
    // Legacy v2 profile metadata is accepted only so already-persisted rows
    // keep working when RunEngine filters these undeclared flat names. If a
    // source ever declares them, they must not survive into runner authority.
    invalid("Accounts OIDC legacy flat Cloudflare module inputs are invalid");
  }
  const allowed = new Set(profile.contract === PAIRWISE_PROFILE_CONTRACT
    ? [
        profile.workerNameVariable,
        profile.projectNameVariable,
        ...(profile.additionalInputVariables ?? []),
      ]
    : [
        profile.resourceNameVariable,
        profile.publicUrlVariable,
        ...(profile.additionalInputVariables ?? []),
      ]);
  if (Object.keys(variables).some((name) => !allowed.has(name))) {
    invalid(
      "Accounts OIDC materializer requires exact non-secret metadata inputs",
    );
  }
}

function assertModuleCloudflareTargetsMatchVerifiedMetadata(
  variables: Readonly<Record<string, unknown>>,
  metadata: { readonly accountId: string; readonly workersSubdomain: string },
): void {
  if (
    variables.cloudflare_account_id !== metadata.accountId ||
    variables.cloudflare_workers_subdomain !== metadata.workersSubdomain
  ) {
    invalid(
      "Accounts OIDC module Cloudflare targets differ from verified metadata",
    );
  }
}

function assertInstallConfigCloudflareTargetsMatchVerifiedMetadata(
  installConfig: InstallConfig,
  metadata: { readonly accountId: string; readonly workersSubdomain: string },
): void {
  const raw = installConfig.variableMapping.cloudflare;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    invalid(
      "Accounts OIDC module Cloudflare targets differ from verified metadata",
    );
  }
  const target = raw as Readonly<Record<string, unknown>>;
  const names = Object.keys(target).sort();
  if (
    !sameStrings(names, ["account_id", "workers_subdomain"]) ||
    target.account_id !== metadata.accountId ||
    target.workers_subdomain !== metadata.workersSubdomain
  ) {
    invalid(
      "Accounts OIDC module Cloudflare targets differ from verified metadata",
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

function profileCallbackPath(
  profile: InstallConfigAccountsOidcModuleVariableMaterialization,
): string {
  return profile.contract === PAIRWISE_PROFILE_CONTRACT
    ? PAIRWISE_CALLBACK_PATH
    : exactCallbackPath(profile.callbackPath);
}

function profileScopes(
  profile: InstallConfigAccountsOidcModuleVariableMaterialization,
): readonly string[] {
  return profile.contract === PAIRWISE_PROFILE_CONTRACT
    ? PAIRWISE_SCOPES
    : exactScopes(profile.scopes);
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
