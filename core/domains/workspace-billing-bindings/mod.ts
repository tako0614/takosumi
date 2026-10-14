/** Workspace owner enrollment authority over the existing Control ledger. */
import { type WorkspaceBillingBinding, type WorkspaceBillingBindingIntent, type WorkspaceBillingBindingState, workspaceBillingIntentMatches } from "takosumi-contract";
import {
  assertWorkspaceManagementAdmission, assertWorkspaceManagementAuthorityInput,
  type OpenTofuControlStore, type StoredWorkspaceBillingBindingIntent, type WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";
import { OpenTofuControllerError, requireNonEmptyString } from "../deploy-control/errors.ts";

function publicIntent(intent: StoredWorkspaceBillingBindingIntent): WorkspaceBillingBindingIntent {
  return {
    intentId: intent.intentId, workspaceId: intent.workspaceId, billingAuthority: intent.billingAuthority,
    workspaceRef: intent.workspaceRef, workspaceCreatedAt: intent.workspaceCreatedAt,
    actorAccountId: intent.actorAccountId, managementEpoch: intent.managementEpoch, createdAt: intent.createdAt,
  };
}

export interface PrepareWorkspaceBillingBindingRequest {
  readonly workspaceId: string;
  readonly billingAuthority: string;
  readonly actorAccountId: string;
  readonly expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority;
}

export interface ClaimWorkspaceBillingBindingRequest {
  readonly workspaceId: string;
  readonly intentId: string;
  readonly actorAccountId: string;
  readonly organizationRef: string;
  readonly ownerAcknowledgementRef: string;
}

/** Append-only references: no relink, rollback, delete, wallet, or Org implementation. */
export class WorkspaceBillingBindingsService {
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;

  constructor(input: { readonly store: OpenTofuControlStore; readonly newId?: (prefix: string) => string; readonly now?: () => Date }) {
    this.#store = input.store;
    this.#newId = input.newId ?? ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
    this.#now = input.now ?? (() => new Date());
  }

  /** Live projection; historical raw source rows remain available to owner recovery separately. */
  async get(workspaceId: string): Promise<WorkspaceBillingBindingState> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const workspace = await this.#store.getWorkspace(workspaceId);
    if (!workspace) throw new OpenTofuControllerError("not_found", "Workspace does not exist.");
    const [intent, binding] = await Promise.all([
      this.#store.getWorkspaceBillingBindingIntent(workspaceId), this.#store.getWorkspaceBillingBinding(workspaceId),
    ]);
    if (intent && (intent.workspaceCreatedAt !== workspace.createdAt ||
      intent.originalWorkspace.ownerUserId !== workspace.ownerUserId || intent.originalWorkspace.type !== workspace.type ||
      intent.originalWorkspace.handle !== workspace.handle)) {
      throw new OpenTofuControllerError("failed_precondition", "Retained billing references belong to a different Workspace incarnation.");
    }
    if (binding && (!intent || !workspaceBillingIntentMatches(binding, intent))) {
      throw new OpenTofuControllerError("failed_precondition", "Retained billing acknowledgement does not match its original intent.");
    }
    return { ...(intent ? { intent: publicIntent(intent) } : {}), ...(binding ? { binding } : {}) };
  }

  async prepare(input: PrepareWorkspaceBillingBindingRequest): Promise<WorkspaceBillingBindingIntent> {
    requireNonEmptyString(input.workspaceId, "workspaceId");
    requireNonEmptyString(input.billingAuthority, "billingAuthority");
    requireNonEmptyString(input.actorAccountId, "actorAccountId");
    // Capture before all awaited Workspace/member preparation. Never refresh
    // this tuple after external owner work or a failed admission.
    const management = assertWorkspaceManagementAdmission(
      await this.#store.getWorkspaceManagement(input.workspaceId), input.workspaceId,
      input.expectedWorkspaceManagementAuthority,
    );
    const authority = input.expectedWorkspaceManagementAuthority ?? {
      workspaceId: input.workspaceId, managementState: "active" as const, managementEpoch: management.managementEpoch,
    };
    assertWorkspaceManagementAuthorityInput(authority, input.workspaceId);
    const [workspace, actor] = await Promise.all([
      this.#store.getWorkspace(input.workspaceId), this.#store.getWorkspaceMember(input.workspaceId, input.actorAccountId),
    ]);
    if (!workspace) throw new OpenTofuControllerError("not_found", "Workspace does not exist.");
    if (!actor || actor.status !== "active" || actor.accountId !== input.actorAccountId || actor.workspaceId !== input.workspaceId ||
      (!actor.roles.includes("owner") && !actor.roles.includes("admin"))) {
      throw new OpenTofuControllerError("permission_denied", "Current Workspace owner/admin membership is required to enroll billing.");
    }
    const intent: StoredWorkspaceBillingBindingIntent = {
      intentId: this.#newId("wbi"), workspaceId: workspace.id, billingAuthority: input.billingAuthority,
      workspaceRef: this.#newId("wrk"), workspaceCreatedAt: workspace.createdAt, actorAccountId: actor.accountId,
      managementEpoch: authority.managementEpoch, createdAt: this.#now().toISOString(),
      originalWorkspace: workspace, originalActor: actor, originalAuthority: authority,
    };
    const result = await this.#store.prepareWorkspaceBillingBinding(intent);
    if (result.status === "refused") throw new OpenTofuControllerError("failed_precondition", "Workspace billing enrollment authority changed.");
    if (result.status === "conflict") throw new OpenTofuControllerError("failed_precondition", "Workspace billing enrollment conflicts with retained references.");
    if (result.record.actorAccountId !== input.actorAccountId) {
      throw new OpenTofuControllerError("failed_precondition", "Existing pending billing enrollment belongs to another original actor.");
    }
    return publicIntent(result.record);
  }

  async claim(input: ClaimWorkspaceBillingBindingRequest): Promise<WorkspaceBillingBinding> {
    const intent = await this.#store.getWorkspaceBillingBindingIntent(input.workspaceId);
    if (!intent || intent.intentId !== input.intentId) throw new OpenTofuControllerError("failed_precondition", "Original Workspace billing intent is required.");
    if (intent.actorAccountId !== input.actorAccountId) throw new OpenTofuControllerError("permission_denied", "The original enrollment actor is required.");
    const binding: WorkspaceBillingBinding = {
      ...publicIntent(intent), organizationRef: input.organizationRef,
      ownerAcknowledgementRef: input.ownerAcknowledgementRef, boundAt: this.#now().toISOString(),
    };
    const result = await this.#store.claimWorkspaceBillingBinding({ expectedIntent: intent, binding });
    if (result.status === "refused") throw new OpenTofuControllerError("failed_precondition", "Original Workspace billing authority changed before acknowledgement.");
    if (result.status === "conflict") throw new OpenTofuControllerError("failed_precondition", "Workspace billing acknowledgement conflicts with retained references.");
    return result.record;
  }
}
