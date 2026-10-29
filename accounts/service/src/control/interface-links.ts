import type { Capsule } from "takosumi-contract/install-configs";
import { InterfaceServiceError, type InterfaceLinkWriteFence } from "../../../../core/domains/interfaces/service.ts";
import { errorJson, json, methodNotAllowed, readJsonObject } from "../http-helpers.ts";
import { type ControlDispatchContext, controlPlaneUnavailable } from "./shared.ts";
import { requireAppAccess } from "./app-authorization.ts";

/** The caller supplies the canonical consumer Capsule; each side authorizes itself. */
export async function handleCapsuleInterfaceLinks(ctx: ControlDispatchContext, capsule: Capsule, segments: readonly string[], method: string): Promise<Response> {
  const service = ctx.operations.interfaces;
  if (!service?.getInterfaceLinkRequirement || !service.getLatestCapsuleInterfaceLink || !service.listInterfaceLinkCandidateView || !service.putCapsuleInterfaceLink || !service.revokeCapsuleInterfaceLink || !service.get) return controlPlaneUnavailable();
  const key = decodeURIComponent(segments[3] ?? "");
  const candidates = segments.length === 5 && segments[4] === "candidates";
  if (!key || (segments.length !== 4 && !candidates)) return errorJson("not_found", "Interface link route not found", 404);
  if (candidates ? method !== "GET" : method !== "PUT" && method !== "DELETE") return methodNotAllowed(candidates ? "GET" : "PUT, DELETE");
  // Each side authorizes as its own app: the consumer for every action, the
  // provider only to revoke a link that points at it.
  let controlling: Capsule = capsule;
  let authorizedProvider: { linkId: string; providerInterfaceId: string; providerCapsuleId: string } | undefined;
  const decide = (app: Capsule, action: "view" | "change_interface_link", session = ctx.session) => requireAppAccess({
    operations: ctx.operations, store: ctx.store, session, workspaceId: app.workspaceId, capsuleId: app.id, capsule: app, action,
    ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
    ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
  });
  let decision = await decide(capsule, candidates ? "view" : "change_interface_link");
  if (!decision.ok && method === "DELETE") {
    const link = await service.getLatestCapsuleInterfaceLink(capsule.id, key);
    if (link) {
      const provider = await ctx.operations.capsules.getCapsule(link.providerCapsuleId);
      const providerDecision = await decide(provider, "change_interface_link");
      if (providerDecision.ok) {
        decision = providerDecision;
        controlling = provider;
        authorizedProvider = { linkId: link.id, providerInterfaceId: link.providerInterfaceId, providerCapsuleId: link.providerCapsuleId };
      }
    }
  }
  if (!decision.ok) return decision.response;
  const controllingWorkspaceId = controlling.workspaceId;
  try {
    if (candidates) {
      const { requirement } = await service.getInterfaceLinkRequirement(capsule.id, key);
      const view = await service.listInterfaceLinkCandidateView({ workspaceId: capsule.workspaceId, capsuleId: capsule.id, requirement });
      if (ctx.session.credential !== "oauth-access-token") return json(view, 200, { "cache-control": "no-store" });
      // An app's own token sees only providers its own grant could already
      // view; it never enumerates other apps' Interfaces.
      const visible = [];
      for (const candidate of view.candidates) {
        const provider = await ctx.operations.capsules.getCapsule(candidate.providerCapsuleId);
        if ((await decide(provider, "view")).ok) visible.push(candidate);
      }
      return json({ ...view, candidates: visible }, 200, { "cache-control": "no-store" });
    }
    const initialAuthority = await ctx.operations.workspaces.captureManagementAuthority(controllingWorkspaceId);
    const writeFence: InterfaceLinkWriteFence = { assertCurrent: async () => {
      ctx.assertActive?.();
      if (ctx.session.reauthorizeBearer && !(await ctx.session.reauthorizeBearer())) throw new InterfaceServiceError("permission_denied", "Interface link caller authority changed");
      if (!(await decide(controlling, "change_interface_link", { ...ctx.session, requiredAccess: "write" })).ok) throw new InterfaceServiceError("permission_denied", "Interface link management access changed");
      const current = await ctx.operations.workspaces.captureManagementAuthority(controllingWorkspaceId);
      if (current.managementEpoch !== initialAuthority.managementEpoch) throw new InterfaceServiceError("conflict", "Workspace management authority changed");
      ctx.assertActive?.();
      return initialAuthority;
    }, mayApproveProvider: async (provider) => {
      // A link is approved at creation only when the requester may change
      // links on the PROVIDER app too; an app's own token never approves
      // another app's Interface. Otherwise it waits as pending_approval.
      if (provider.capsuleId === capsule.id) return true;
      if (ctx.session.credential === "oauth-access-token") return false;
      const providerCapsule = await ctx.operations.capsules.getCapsule(provider.capsuleId);
      if (providerCapsule.id !== provider.capsuleId || providerCapsule.workspaceId !== provider.workspaceId) return false;
      return (await decide(providerCapsule, "change_interface_link", { ...ctx.session, requiredAccess: "write" })).ok;
    } };
    const body = await readJsonObject(ctx.request);
    if (!body) return errorJson("invalid_request", "JSON object is required", 400);
    if (typeof body.expectedGeneration !== "number" || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0) return errorJson("invalid_request", "expectedGeneration must be a non-negative integer", 400);
    const actor = { actorAccountId: ctx.session.subject, roles: [], requestId: ctx.request.headers.get("x-request-id") ?? "interface-link", workspaceId: capsule.workspaceId };
    if (method === "DELETE") return json({ link: await service.revokeCapsuleInterfaceLink(capsule.id, key, body.expectedGeneration, actor, writeFence, authorizedProvider) });
    if (typeof body.interfaceId !== "string" || !body.interfaceId.trim()) return errorJson("invalid_request", "interfaceId is required", 400);
    if (body.expectedRequirementFingerprint !== undefined && (typeof body.expectedRequirementFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(body.expectedRequirementFingerprint))) return errorJson("invalid_request", "expectedRequirementFingerprint must be a SHA-256 digest", 400);
    return json({ link: await service.putCapsuleInterfaceLink({ capsuleId: capsule.id, requirementKey: key, interfaceId: body.interfaceId, expectedGeneration: body.expectedGeneration, ...(typeof body.expectedRequirementFingerprint === "string" ? { expectedRequirementFingerprint: body.expectedRequirementFingerprint } : {}) }, actor, writeFence) });
  } catch (error) {
    if (!(error instanceof InterfaceServiceError)) throw error;
    return errorJson(error.code, error.message, error.code === "permission_denied" ? 403 : error.code === "not_found" ? 404 : error.code === "invalid_argument" ? 400 : error.code === "failed_precondition" ? 412 : 409);
  }
}
