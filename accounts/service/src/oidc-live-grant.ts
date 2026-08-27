import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { installExperienceOidcClient } from "takosumi-contract";
import type { CapsuleStatus } from "takosumi-contract/install-configs";
import type {
  ControlPlaneOperations,
  ControlWorkspaceRole,
} from "./control-operations.ts";
import type { AccountsStore } from "./store.ts";
import { oidcClientActivationDigest } from "./oidc-activation.ts";
import { accountsOidcModuleVariableProfile } from "../../../core/domains/deploy-control/accounts_oidc_module_variable_profile.ts";

export interface OidcLiveGrantClient {
  readonly clientId: string;
  readonly capsuleId?: string;
  readonly allowedScopes?: readonly string[];
}

export type OidcLiveGrantFailureReason =
  | "client_binding_changed"
  | "client_registration_missing"
  | "control_plane_unavailable"
  | "capsule_not_ready"
  | "capsule_missing"
  | "install_grant_missing"
  | "install_grant_stale"
  | "scope_not_granted"
  | "subject_missing"
  | "workspace_binding_changed"
  | "workspace_membership_inactive";

export type OidcLiveGrantValidation =
  | {
      readonly ok: true;
      readonly capsuleId?: string;
      readonly capsuleName?: string;
      readonly workspaceId?: string;
      readonly role?: ControlWorkspaceRole;
    }
  | {
      readonly ok: false;
      readonly reason: OidcLiveGrantFailureReason;
    };

/**
 * Validates the authority behind an OIDC authorization code or token against
 * the current source-of-truth records. Dynamic Capsule grants are deliberately
 * not snapshots: the client registration, Capsule readiness, InstallConfig
 * declaration, Workspace binding, membership, role, and scopes must all still
 * agree whenever authority is exercised.
 */
export async function validateOidcLiveGrant(input: {
  readonly store: AccountsStore;
  readonly operations?: ControlPlaneOperations;
  readonly client: OidcLiveGrantClient;
  readonly scope: string;
  readonly takosumiSubject?: TakosumiSubject;
  /**
   * The Capsule recorded on the authorization code/token. Authorize passes the
   * resolved client's Capsule id so the same binding check is used there too.
   */
  readonly capsuleId?: string;
  /** The Workspace recorded on an already-issued code/token, when present. */
  readonly workspaceId?: string;
}): Promise<OidcLiveGrantValidation> {
  if (input.client.capsuleId !== input.capsuleId) {
    return { ok: false, reason: "client_binding_changed" };
  }

  // Composition-owned clients are their own current grant. They have no
  // Capsule lifecycle or Workspace membership to revalidate.
  if (!input.client.capsuleId) {
    if (
      input.client.allowedScopes &&
      !oidcScopeIsAllowed(input.scope, input.client.allowedScopes)
    ) {
      return { ok: false, reason: "scope_not_granted" };
    }
    if (!input.workspaceId) return { ok: true };
    if (!input.operations) {
      return { ok: false, reason: "control_plane_unavailable" };
    }
    if (!input.takosumiSubject) {
      return { ok: false, reason: "subject_missing" };
    }
    const role = await currentWorkspaceRole(
      input.operations,
      input.workspaceId,
      input.takosumiSubject,
    );
    return role
      ? { ok: true, workspaceId: input.workspaceId, role }
      : { ok: false, reason: "workspace_membership_inactive" };
  }

  const capsuleId = input.client.capsuleId;
  const operations = input.operations;
  if (!operations) {
    return { ok: false, reason: "control_plane_unavailable" };
  }
  const currentClient = await input.store.findOidcClient(
    input.client.clientId,
  );
  if (!currentClient) {
    return { ok: false, reason: "client_registration_missing" };
  }
  if (
    currentClient.capsuleId !== capsuleId ||
    currentClient.namespacePath !== "identity.oidc" ||
    currentClient.subjectMode !== "pairwise"
  ) {
    return { ok: false, reason: "client_binding_changed" };
  }
  if (!oidcScopeIsAllowed(input.scope, currentClient.allowedScopes)) {
    return { ok: false, reason: "scope_not_granted" };
  }

  let capsule;
  try {
    capsule = await operations.capsules.getCapsule(capsuleId);
  } catch {
    await revokeOidcClientBestEffort(input.store, input.client.clientId);
    return { ok: false, reason: "capsule_missing" };
  }
  if (!oidcCapsuleStatusAllowsRuntime(capsule.status)) {
    // Terminal Capsules cannot recover this registration. Deleting it also
    // makes already-issued credentials fail at the client-binding check.
    if (capsule.status === "disabled" || capsule.status === "destroyed") {
      await revokeOidcClientBestEffort(input.store, input.client.clientId);
    }
    return { ok: false, reason: "capsule_not_ready" };
  }
  if (
    input.workspaceId !== undefined &&
    input.workspaceId !== capsule.workspaceId
  ) {
    return { ok: false, reason: "workspace_binding_changed" };
  }

  // The InstallConfig is the current service-owned grant declaration. This
  // check closes the crash window between updating that declaration and
  // activating the matching Accounts client registration.
  let installConfig;
  let executionAuthorityEpoch;
  try {
    [installConfig, executionAuthorityEpoch] = await Promise.all([
      operations.capsules.getInstallConfig(capsule.installConfigId),
      operations.capsules.getCapsuleExecutionAuthorityEpoch(capsule.id),
    ]);
  } catch {
    return { ok: false, reason: "install_grant_missing" };
  }
  const experience = installExperienceOidcClient(
    installConfig.installExperience,
  );
  if (!experience) {
    await revokeOidcClientBestEffort(input.store, input.client.clientId);
    return { ok: false, reason: "install_grant_missing" };
  }
  let repositoryMaterialized = false;
  try {
    repositoryMaterialized =
      accountsOidcModuleVariableProfile(installConfig)?.source ===
        "repository_install_ux";
  } catch {
    return { ok: false, reason: "install_grant_stale" };
  }
  if (experience.clientIdVariable && !repositoryMaterialized) {
    const mappedClientId = installConfig.variableMapping[
      experience.clientIdVariable
    ];
    if (
      typeof mappedClientId !== "string" ||
      mappedClientId.trim() !== input.client.clientId
    ) {
      return { ok: false, reason: "client_binding_changed" };
    }
  }
  let activationDigest: string;
  try {
    activationDigest = await oidcClientActivationDigest({
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      executionAuthorityEpoch,
      installConfig,
    });
  } catch {
    return { ok: false, reason: "install_grant_stale" };
  }
  if (currentClient.activationDigest !== activationDigest) {
    return { ok: false, reason: "install_grant_stale" };
  }
  if (
    !oidcScopeIsAllowed(
      input.scope,
      oidcAllowedScopes(experience.scopes),
    )
  ) {
    return { ok: false, reason: "scope_not_granted" };
  }

  const subject = input.takosumiSubject;
  if (!subject) {
    return { ok: false, reason: "subject_missing" };
  }
  const role = await currentWorkspaceRole(
    operations,
    capsule.workspaceId,
    subject,
  );
  if (!role) {
    return { ok: false, reason: "workspace_membership_inactive" };
  }
  return {
    ok: true,
    capsuleId,
    capsuleName: capsule.name,
    workspaceId: capsule.workspaceId,
    role,
  };
}

export function oidcAllowedScopes(
  scopes: readonly string[] | undefined,
): string[] {
  const configured = scopes?.map((scope) => scope.trim()).filter(Boolean) ?? [];
  const normalized = [...new Set(configured)];
  return normalized.includes("openid")
    ? normalized
    : [
        "openid",
        ...(normalized.length > 0 ? normalized : ["profile", "email"]),
      ];
}

function oidcScopeIsAllowed(
  requestedScope: string,
  allowedScopes: readonly string[],
): boolean {
  const allowed = new Set(allowedScopes);
  const requested = requestedScope.trim().split(/\s+/u).filter(Boolean);
  return requested.length > 0 && requested.every((scope) => allowed.has(scope));
}

function oidcCapsuleStatusAllowsRuntime(status: CapsuleStatus): boolean {
  // A stale Capsule is still the deployed Ready runtime; it merely has an
  // update available. Pending/error/disabled/destroyed are not runtime-ready.
  return status === "active" || status === "stale";
}

function preferredWorkspaceRole(
  roles: readonly string[],
): ControlWorkspaceRole | undefined {
  for (const role of [
    "owner",
    "admin",
    "member",
    "viewer",
  ] as const satisfies readonly ControlWorkspaceRole[]) {
    if (roles.includes(role)) return role;
  }
  return undefined;
}

async function currentWorkspaceRole(
  operations: ControlPlaneOperations,
  workspaceId: string,
  subject: TakosumiSubject,
): Promise<ControlWorkspaceRole | undefined> {
  try {
    const workspace = await operations.workspaces.getWorkspace(workspaceId);
    if (workspace.ownerUserId === subject) return "owner";
    const member = (await operations.members.listMembers(workspaceId)).find(
      (candidate) =>
        candidate.accountId === subject && candidate.status === "active",
    );
    return member ? preferredWorkspaceRole(member.roles) : undefined;
  } catch {
    return undefined;
  }
}

async function revokeOidcClientBestEffort(
  store: AccountsStore,
  clientId: string,
): Promise<void> {
  try {
    await store.revokeOidcClient(clientId);
  } catch {
    // The live-grant decision is already deny. Cleanup is deliberately
    // best-effort so a storage outage cannot turn a revoked grant back on.
  }
}
