import type { WorkspaceBillingBindingIntent } from "takosumi-contract";
import type { WorkspaceBillingEnrollmentAcknowledgement, WorkspaceBillingEnrollmentPort } from "./workspace-billing-bootstrap.ts";

/** Financial-owned contract: a Workspace's billing Organization is derived,
 * not created over a server-to-server call. The Takoserver RP recomputes the
 * same reference from its realm billing authority and the Workspace reference,
 * and creates the Organization inside its own fresh issuance. */
export const WORKSPACE_BILLING_ORGANIZATION_CONTRACT = "takoserver.workspace-billing-organization@v1";
/** The contract's grammars (the Takoserver wallet attribution grammar). */
const WORKSPACE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BILLING_AUTHORITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `org_wb_` + the first 32 lowercase hex of SHA-256(JSON.stringify([contract, billingAuthority, workspaceRef])). */
export async function workspaceBillingOrganizationRef(billingAuthority: string, workspaceRef: string): Promise<string> {
  return `org_wb_${(await sha256Hex(JSON.stringify([WORKSPACE_BILLING_ORGANIZATION_CONTRACT, billingAuthority, workspaceRef]))).slice(0, 32)}`;
}

/** The same intent always yields the same acknowledgement, so there is no
 * second Organization and no unknown acknowledgement to reconcile. */
export function createDerivedWorkspaceBillingEnrollment(billingAuthority: string): WorkspaceBillingEnrollmentPort {
  if (typeof billingAuthority !== "string" || !BILLING_AUTHORITY.test(billingAuthority)) throw new TypeError("An exact billing authority is required");
  return Object.freeze({
    async ensureOrganization(intent: WorkspaceBillingBindingIntent): Promise<WorkspaceBillingEnrollmentAcknowledgement | null> {
      if (intent.billingAuthority !== billingAuthority || typeof intent.workspaceRef !== "string" || !WORKSPACE_REF.test(intent.workspaceRef)) return null;
      const organizationRef = await workspaceBillingOrganizationRef(billingAuthority, intent.workspaceRef);
      const ownerAcknowledgementRef = `wbo_ack_${(await sha256Hex(JSON.stringify([WORKSPACE_BILLING_ORGANIZATION_CONTRACT, "acknowledgement", intent.intentId, organizationRef]))).slice(0, 32)}`;
      return Object.freeze({
        intentId: intent.intentId, workspaceId: intent.workspaceId, billingAuthority,
        workspaceRef: intent.workspaceRef, organizationRef, ownerAcknowledgementRef,
      });
    },
  });
}
