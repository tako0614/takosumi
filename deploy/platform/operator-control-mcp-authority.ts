// Composition of the optional operator-control MCP adapter's authority
// (TASK-0118 P9.1-e). The adapter itself only builds bounded public requests
// and applies its owner fence; this module reads the facts the fence needs
// and dispatches through the ordinary public control handlers as the token's
// subject, without a Workspace.

import type { TrustedNativeClient } from "takosumi-contract";
import {
  handleAuthenticatedControlRoute,
  type ControlPlaneOperations,
} from "@takosjp/takosumi-accounts-service";
import { personalResourceNamespace } from "../../accounts/service/src/control/personal-resources.ts";
import type { AccountsStore } from "../../accounts/service/src/store.ts";
import type { ActivityCursorSealer } from "../../accounts/service/src/control/activity-cursor.ts";
import type { OperatorControlMcpAuthority } from "../operator-control-mcp.ts";

export interface OperatorControlMcpAuthorityInput {
  readonly operations: ControlPlaneOperations;
  readonly store: AccountsStore;
  /** The verified Interface OAuth invocation. */
  readonly session: {
    readonly subject: string;
    /** The MCP's own app: the Interface owner Capsule named by the token. */
    readonly capsuleId: string;
    /** Compatibility bearer restriction while tokens still carry a Workspace. */
    readonly workspaceId?: string;
  };
  /** The inbound request URL; public requests are dispatched on its origin. */
  readonly requestUrl: string;
  readonly issuer?: string;
  readonly legacyWorkspaceSunset?: string;
  readonly appOwnershipMutationsFrozen?: true;
  readonly trustedNativeClients?: readonly TrustedNativeClient[];
  readonly activityCursorSealer?: ActivityCursorSealer;
}

/**
 * The authority one MCP invocation acts with. Public handlers run as the
 * subject with no Workspace binding and no credential kind (an in-process
 * composition), so their ordinary per-app decisions apply; the adapter's own
 * fence narrows them first (see OperatorControlMcpAuthority).
 */
export function createOperatorControlMcpAuthority(
  input: OperatorControlMcpAuthorityInput,
): OperatorControlMcpAuthority {
  const { operations, store, session } = input;
  return {
    subject: session.subject,
    capsuleId: session.capsuleId,
    ...(session.workspaceId !== undefined ? { workspaceId: session.workspaceId } : {}),
    dispatchPublicControl: async (controlRequest) => {
      const sourceUrl = new URL(controlRequest.url);
      const targetUrl = new URL(input.requestUrl);
      targetUrl.pathname = sourceUrl.pathname;
      targetUrl.search = sourceUrl.search;
      targetUrl.hash = "";
      const response = await handleAuthenticatedControlRoute({
        request: new Request(targetUrl, {
          method: controlRequest.method,
          headers: controlRequest.headers,
          body:
            controlRequest.method === "GET" || controlRequest.method === "HEAD"
              ? undefined
              : controlRequest.body,
        }),
        url: targetUrl,
        store,
        operations,
        subject: session.subject,
        entry: "operator_mcp",
        ...(input.legacyWorkspaceSunset
          ? { legacyWorkspaceSunset: input.legacyWorkspaceSunset }
          : {}),
        ...(input.appOwnershipMutationsFrozen ? { appOwnershipMutationsFrozen: true } : {}),
        ...(input.trustedNativeClients ? { trustedNativeClients: input.trustedNativeClients } : {}),
        ...(input.activityCursorSealer ? { activityCursorSealer: input.activityCursorSealer } : {}),
        ...(input.issuer ? { issuer: input.issuer } : {}),
      });
      return response ?? Response.json({ error: "not found" }, { status: 404 });
    },
    app: async (capsuleId) => {
      try {
        const capsule = await operations.capsules.getCapsule(capsuleId);
        if (capsule.id !== capsuleId) return undefined;
        const ownership = await operations.appOwnership?.getOwnership(capsuleId);
        return {
          workspaceId: capsule.workspaceId,
          ...(ownership?.capsuleId === capsuleId
            ? { ownerAccountId: ownership.ownerAccountId }
            : {}),
        };
      } catch {
        return undefined;
      }
    },
    installPlan: async (installPlanId) => {
      try {
        const plan = await operations.gitInstallPlans.get(installPlanId);
        if (!plan || plan.id !== installPlanId) return undefined;
        return {
          ...(plan.capsuleId ? { capsuleId: plan.capsuleId } : {}),
          workspaceId: plan.workspaceId,
          createdBy: plan.createdBy,
          actorSubject: plan.actorSubject,
        };
      } catch {
        return undefined;
      }
    },
    run: async (runId) => {
      try {
        const run = await operations.getRun(runId);
        return run.id === runId
          ? { ...(run.capsuleId ? { capsuleId: run.capsuleId } : {}) }
          : undefined;
      } catch {
        return undefined;
      }
    },
    installNamespaceId: async () => {
      try {
        // Never creates the namespace: this is a read for the restriction only.
        return (await personalResourceNamespace(
          operations,
          store,
          { subject: session.subject },
          false,
        ))?.id;
      } catch {
        return undefined;
      }
    },
  };
}
