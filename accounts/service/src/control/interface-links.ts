import type { Capsule } from "takosumi-contract/install-configs";
import { InterfaceServiceError, type InterfaceLinkWriteFence } from "../../../../core/domains/interfaces/service.ts";
import { errorJson, json, methodNotAllowed, readJsonObject } from "../http-helpers.ts";
import { type ControlDispatchContext, canAccessWorkspace, controlPlaneUnavailable } from "./shared.ts";

/** The caller supplies the canonical consumer Capsule; each side authorizes itself. */
export async function handleCapsuleInterfaceLinks(ctx: ControlDispatchContext, capsule: Capsule, segments: readonly string[], method: string): Promise<Response> {
  const service = ctx.operations.interfaces;
  if (!service?.getInterfaceLinkRequirement || !service.getLatestCapsuleInterfaceLink || !service.listInterfaceLinkCandidateView || !service.putCapsuleInterfaceLink || !service.revokeCapsuleInterfaceLink || !service.get) return controlPlaneUnavailable();
  const key = decodeURIComponent(segments[3] ?? "");
  const candidates = segments.length === 5 && segments[4] === "candidates";
  if (!key || (segments.length !== 4 && !candidates)) return errorJson("not_found", "Interface link route not found", 404);
  if (candidates ? method !== "GET" : method !== "PUT" && method !== "DELETE") return methodNotAllowed(candidates ? "GET" : "PUT, DELETE");
  let controllingWorkspaceId = capsule.workspaceId;
  let authorizedProvider: { linkId: string; providerInterfaceId: string; providerCapsuleId: string } | undefined;
  let allowed = await canAccessWorkspace({ operations: ctx.operations, store: ctx.store, session: ctx.session, workspaceId: capsule.workspaceId });
  if (!allowed && method === "DELETE") {
    const link = await service.getLatestCapsuleInterfaceLink(capsule.id, key);
    if (link) {
      const provider = await ctx.operations.capsules.getCapsule(link.providerCapsuleId);
      allowed = await canAccessWorkspace({ operations: ctx.operations, store: ctx.store, session: ctx.session, workspaceId: provider.workspaceId });
      if (allowed) {
        controllingWorkspaceId = provider.workspaceId;
        authorizedProvider = { linkId: link.id, providerInterfaceId: link.providerInterfaceId, providerCapsuleId: link.providerCapsuleId };
      }
    }
  }
  if (!allowed) return errorJson("forbidden", "The authenticated session cannot manage this Interface link.", 403);
  try {
    if (candidates) {
      const { requirement } = await service.getInterfaceLinkRequirement(capsule.id, key);
      return json(await service.listInterfaceLinkCandidateView({ workspaceId: capsule.workspaceId, capsuleId: capsule.id, requirement }), 200, { "cache-control": "no-store" });
    }
    const initialAuthority = await ctx.operations.workspaces.captureManagementAuthority(controllingWorkspaceId);
    const writeFence: InterfaceLinkWriteFence = { assertCurrent: async () => {
      ctx.assertActive?.();
      if (ctx.session.reauthorizeBearer && !(await ctx.session.reauthorizeBearer())) throw new InterfaceServiceError("permission_denied", "Interface link caller authority changed");
      if (!(await canAccessWorkspace({ operations: ctx.operations, store: ctx.store, session: { ...ctx.session, requiredAccess: "write" }, workspaceId: controllingWorkspaceId }))) throw new InterfaceServiceError("permission_denied", "Interface link management access changed");
      const current = await ctx.operations.workspaces.captureManagementAuthority(controllingWorkspaceId);
      if (current.managementEpoch !== initialAuthority.managementEpoch) throw new InterfaceServiceError("conflict", "Workspace management authority changed");
      ctx.assertActive?.();
      return initialAuthority;
    } };
    const body = await readJsonObject(ctx.request);
    if (!body) return errorJson("invalid_request", "JSON object is required", 400);
    if (typeof body.expectedGeneration !== "number" || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0) return errorJson("invalid_request", "expectedGeneration must be a non-negative integer", 400);
    const actor = { actorAccountId: ctx.session.subject, roles: [], requestId: ctx.request.headers.get("x-request-id") ?? "interface-link", workspaceId: capsule.workspaceId };
    if (method === "DELETE") return json({ link: await service.revokeCapsuleInterfaceLink(capsule.id, key, body.expectedGeneration, actor, writeFence, authorizedProvider) });
    if (typeof body.interfaceId !== "string" || !body.interfaceId.trim()) return errorJson("invalid_request", "interfaceId is required", 400);
    return json({ link: await service.putCapsuleInterfaceLink({ capsuleId: capsule.id, requirementKey: key, interfaceId: body.interfaceId, expectedGeneration: body.expectedGeneration }, actor, writeFence) });
  } catch (error) {
    if (!(error instanceof InterfaceServiceError)) throw error;
    return errorJson(error.code, error.message, error.code === "permission_denied" ? 403 : error.code === "not_found" ? 404 : error.code === "invalid_argument" ? 400 : error.code === "failed_precondition" ? 412 : 409);
  }
}
