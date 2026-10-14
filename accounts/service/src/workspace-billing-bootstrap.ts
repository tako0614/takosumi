import type { WorkspaceBillingBinding, WorkspaceBillingBindingIntent } from "takosumi-contract";
import type { ControlPlaneOperations } from "./control-operations.ts";
import { SharedAccountWorkspaceError, type SharedWorkspaceBillingResolver } from "./shared-account-workspace.ts";

/** The configured billing owner authenticates this port independently. The
 * intent is an immutable Control DTO, never browser-provided account authority. */
export interface WorkspaceBillingEnrollmentAcknowledgement {
  readonly intentId: string;
  readonly workspaceId: string;
  readonly billingAuthority: string;
  readonly workspaceRef: string;
  readonly organizationRef: string;
  readonly ownerAcknowledgementRef: string;
}

export interface WorkspaceBillingEnrollmentPort {
  /** An unknown acknowledgement returns null. The next attempt MUST reuse this
   * exact durable intent/ref rather than create a second Organization. Existing
   * protected references need reviewed adoption, never an owner-marker guess. */
  ensureOrganization(intent: WorkspaceBillingBindingIntent): Promise<WorkspaceBillingEnrollmentAcknowledgement | null>;
}

export function createWorkspaceBillingBootstrapResolver(input: {
  readonly operations: Pick<ControlPlaneOperations, "workspaces" | "members">;
  readonly billingAuthority: string;
  readonly enrollment?: WorkspaceBillingEnrollmentPort;
}): SharedWorkspaceBillingResolver {
  if (!opaqueReference(input.billingAuthority)) throw new TypeError("An exact billing authority is required");
  const unavailable = (): never => {
    throw new SharedAccountWorkspaceError("binding_unavailable", "Workspace billing binding is unavailable.", 503);
  };
  const ownerCall = async <T>(call: () => Promise<T>): Promise<T> => {
    try { return await call(); } catch { return unavailable(); }
  };
  return async ({ workspaceId, canonicalAccountId, assertCurrentGrant }) => {
    const assertGrant = async () => {
      if (!await assertCurrentGrant()) throw new SharedAccountWorkspaceError("invalid_session", "A current account grant is required.", 401);
    };
    await assertGrant();
    const bindings = input.operations.workspaces.billingBindings;
    if (!bindings) return unavailable();
    const state = await ownerCall(() => bindings.get(workspaceId));
    if (state.binding) {
      if (state.binding.workspaceId !== workspaceId || state.binding.billingAuthority !== input.billingAuthority ||
        !opaqueReference(state.binding.organizationRef) || !workspaceReference(state.binding.workspaceRef)) return unavailable();
      await assertGrant();
      return projection(state.binding);
    }
    // Without the actual financial owner there is no enrollment side effect,
    // no invented success and no replacement for an existing protected Org.
    if (!input.enrollment) return null;
    const member = await input.operations.members.getMember?.(workspaceId, canonicalAccountId);
    if (!member || member.accountId !== canonicalAccountId || member.workspaceId !== workspaceId ||
      member.status !== "active" || !member.roles.some((role) => role === "owner" || role === "admin")) return unavailable();
    await assertGrant();
    const intent = await ownerCall(() => bindings.prepare({workspaceId,billingAuthority:input.billingAuthority,actorAccountId:canonicalAccountId}));
    if (intent.workspaceId !== workspaceId || intent.billingAuthority !== input.billingAuthority ||
      intent.actorAccountId !== canonicalAccountId || !workspaceReference(intent.workspaceRef)) return unavailable();
    await assertGrant();
    let acknowledgement: WorkspaceBillingEnrollmentAcknowledgement | null;
    try { acknowledgement = await input.enrollment.ensureOrganization(publicIntent(intent)); }
    catch { return null; }
    if (!acknowledgement) return null;
    if (acknowledgement.intentId !== intent.intentId || acknowledgement.workspaceId !== intent.workspaceId ||
      acknowledgement.billingAuthority !== intent.billingAuthority || acknowledgement.workspaceRef !== intent.workspaceRef ||
      !opaqueReference(acknowledgement.organizationRef) || !opaqueReference(acknowledgement.ownerAcknowledgementRef)) return unavailable();
    await assertGrant();
    // Control atomically rechecks the original captured member, Workspace
    // incarnation and management epoch. They are never refreshed after await.
    const binding = await ownerCall(() => bindings.claim({workspaceId,intentId:intent.intentId,actorAccountId:canonicalAccountId,
      organizationRef:acknowledgement!.organizationRef,ownerAcknowledgementRef:acknowledgement!.ownerAcknowledgementRef}));
    if (binding.intentId !== intent.intentId || binding.workspaceId !== workspaceId ||
      binding.billingAuthority !== input.billingAuthority || binding.workspaceRef !== intent.workspaceRef ||
      binding.organizationRef !== acknowledgement.organizationRef || binding.ownerAcknowledgementRef !== acknowledgement.ownerAcknowledgementRef) return unavailable();
    await assertGrant();
    return projection(binding);
  };
}

function publicIntent(intent: WorkspaceBillingBindingIntent): WorkspaceBillingBindingIntent {
  return {intentId:intent.intentId,workspaceId:intent.workspaceId,billingAuthority:intent.billingAuthority,
    workspaceRef:intent.workspaceRef,workspaceCreatedAt:intent.workspaceCreatedAt,actorAccountId:intent.actorAccountId,
    managementEpoch:intent.managementEpoch,createdAt:intent.createdAt};
}

function projection(binding: WorkspaceBillingBinding) {
  return {workspaceId:binding.workspaceId,workspaceRef:binding.workspaceRef,organizationId:binding.organizationRef};
}

function opaqueReference(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/u.test(value);
}

function workspaceReference(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
}
