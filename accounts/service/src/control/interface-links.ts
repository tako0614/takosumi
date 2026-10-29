import type { CapsuleInterfaceLinkRequest } from "takosumi-contract/capsules";
import type { Capsule } from "takosumi-contract/install-configs";
import type { InterfaceLink } from "takosumi-contract/interfaces";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { InterfaceServiceError, type InterfaceLinkWriteFence } from "../../../../core/domains/interfaces/service.ts";
import { errorJson, json, methodNotAllowed, readJsonObject } from "../http-helpers.ts";
import { type ControlDispatchContext, controlPlaneUnavailable } from "./shared.ts";
import { mayApproveInterfaceProvider, mayDecideInterfaceLinkRequests, requireAppAccess } from "./app-authorization.ts";
import { linkedAppDisplay } from "./capsule-app.ts";

/** The caller supplies the canonical consumer Capsule; each side authorizes itself. */
export async function handleCapsuleInterfaceLinks(ctx: ControlDispatchContext, capsule: Capsule, segments: readonly string[], method: string): Promise<Response> {
  // Provider-side consent: `GET .../interface-links/requests` and
  // `POST .../interface-links/:linkId/{approve,decline}` address the PROVIDER
  // app. A requirement literally named "requests" keeps its PUT and DELETE.
  if ((segments.length === 4 && segments[3] === "requests" && method === "GET") ||
    (segments.length === 5 && (segments[4] === "approve" || segments[4] === "decline"))) {
    return handleInterfaceLinkRequests(ctx, capsule, segments, method);
  }
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
    }, mayApproveProvider: (provider) => mayApproveInterfaceProvider({
      // A link is approved at creation only when the requester may change
      // links on the PROVIDER app too; otherwise it waits as pending_approval.
      operations: ctx.operations, store: ctx.store, session: ctx.session, consumerCapsuleId: capsule.id, provider,
      ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
      ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
    }) };
    const body = await readJsonObject(ctx.request);
    if (!body) return errorJson("invalid_request", "JSON object is required", 400);
    if (typeof body.expectedGeneration !== "number" || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0) return errorJson("invalid_request", "expectedGeneration must be a non-negative integer", 400);
    const actor = { actorAccountId: ctx.session.subject, roles: [], requestId: ctx.request.headers.get("x-request-id") ?? "interface-link", workspaceId: capsule.workspaceId };
    if (method === "DELETE") return json({ link: await service.revokeCapsuleInterfaceLink(capsule.id, key, body.expectedGeneration, actor, writeFence, authorizedProvider) });
    if (typeof body.interfaceId !== "string" || !body.interfaceId.trim()) return errorJson("invalid_request", "interfaceId is required", 400);
    if (body.expectedRequirementFingerprint !== undefined && (typeof body.expectedRequirementFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(body.expectedRequirementFingerprint))) return errorJson("invalid_request", "expectedRequirementFingerprint must be a SHA-256 digest", 400);
    return json({ link: await service.putCapsuleInterfaceLink({ capsuleId: capsule.id, requirementKey: key, interfaceId: body.interfaceId, expectedGeneration: body.expectedGeneration, ...(typeof body.expectedRequirementFingerprint === "string" ? { expectedRequirementFingerprint: body.expectedRequirementFingerprint } : {}) }, actor, writeFence) });
  } catch (error) {
    return interfaceLinkError(error);
  }
}

function interfaceLinkError(error: unknown): Response {
  if (!(error instanceof InterfaceServiceError)) throw error;
  // interface_link_approval_required (a re-point that would leave the app
  // with only a pending link) is a 409 like the other conflicts.
  return errorJson(error.code, error.message, error.code === "permission_denied" ? 403 : error.code === "not_found" ? 404 : error.code === "invalid_argument" ? 400 : error.code === "failed_precondition" ? 412 : 409);
}

function interfaceLinkDecisionRefused(): Response {
  return errorJson("app_access_denied", "Approving or declining Interface links requires a person: an account session, a personal access token, or a delegated app acting for its user on another app.", 403);
}

/**
 * Pending links aimed at `provider`, and the provider's approve / decline.
 * Every request decides `change_interface_link` on the PROVIDER app; members
 * of the consumer app gain nothing here.
 */
async function handleInterfaceLinkRequests(ctx: ControlDispatchContext, provider: Capsule, segments: readonly string[], method: string): Promise<Response> {
  const service = ctx.operations.interfaces;
  if (!service?.listProviderInterfaceLinkRequests || !service.approveInterfaceLink || !service.declineInterfaceLink) return controlPlaneUnavailable();
  const verb = segments.length === 5 ? segments[4] as "approve" | "decline" : undefined;
  if (verb && method !== "POST") return methodNotAllowed("POST");
  const linkId = verb ? decodeURIComponent(segments[3] ?? "") : "";
  if (verb && !linkId) return errorJson("not_found", "Interface link route not found", 404);
  const decide = (session: ControlDispatchContext["session"]) => requireAppAccess({
    operations: ctx.operations, store: ctx.store, session, workspaceId: provider.workspaceId, capsuleId: provider.id, capsule: provider, action: "change_interface_link",
    ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
    ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
  });
  const credentialMayDecide = () => mayDecideInterfaceLinkRequests({
    operations: ctx.operations, session: ctx.session, providerCapsuleId: provider.id,
    ...(ctx.assertActive ? { assertActive: ctx.assertActive } : {}),
  });
  if (!(await credentialMayDecide())) return interfaceLinkDecisionRefused();
  const decision = await decide(verb ? { ...ctx.session, requiredAccess: "write" } : ctx.session);
  if (!decision.ok) return decision.response;
  try {
    if (!verb) {
      const requests = await projectInterfaceLinkRequests(ctx, await service.listProviderInterfaceLinkRequests(provider.id));
      return json({ requests }, 200, { "cache-control": "no-store" });
    }
    const body = await readJsonObject(ctx.request);
    if (!body) return errorJson("invalid_request", "JSON object is required", 400);
    const allowed = verb === "approve" ? ["expectedGeneration", "approvedPermissions"] : ["expectedGeneration"];
    const unknown = Object.keys(body).find((key) => !allowed.includes(key));
    if (unknown) return errorJson("invalid_request", `${unknown} is not accepted here`, 400);
    if (typeof body.expectedGeneration !== "number" || !Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 0) return errorJson("invalid_request", "expectedGeneration must be a non-negative integer", 400);
    const approvedPermissions = body.approvedPermissions;
    if (approvedPermissions !== undefined && (!Array.isArray(approvedPermissions) || approvedPermissions.some((permission) => typeof permission !== "string"))) return errorJson("invalid_request", "approvedPermissions must be an array of permission names", 400);
    const initialAuthority = await ctx.operations.workspaces.captureManagementAuthority(provider.workspaceId);
    // Re-decided immediately before the write: a role removed, an ownership
    // transfer (epoch) or a changed bearer fails closed.
    const writeFence: InterfaceLinkWriteFence = { assertCurrent: async () => {
      ctx.assertActive?.();
      if (ctx.session.reauthorizeBearer && !(await ctx.session.reauthorizeBearer())) throw new InterfaceServiceError("permission_denied", "Interface link caller authority changed");
      if (!(await credentialMayDecide()) || !(await decide({ ...ctx.session, requiredAccess: "write" })).ok) throw new InterfaceServiceError("permission_denied", "Interface link management access changed");
      const current = await ctx.operations.workspaces.captureManagementAuthority(provider.workspaceId);
      if (current.managementEpoch !== initialAuthority.managementEpoch) throw new InterfaceServiceError("conflict", "Workspace management authority changed");
      ctx.assertActive?.();
      return initialAuthority;
    } };
    const actor = { actorAccountId: ctx.session.subject, roles: [], requestId: ctx.request.headers.get("x-request-id") ?? "interface-link", workspaceId: provider.workspaceId };
    const input = { providerCapsuleId: provider.id, linkId, expectedGeneration: body.expectedGeneration };
    const link = verb === "approve"
      ? await service.approveInterfaceLink({ ...input, ...(approvedPermissions !== undefined ? { approvedPermissions: approvedPermissions as string[] } : {}) }, actor, writeFence)
      : await service.declineInterfaceLink(input, actor, writeFence);
    return json({ link });
  } catch (error) {
    return interfaceLinkError(error);
  }
}

async function projectInterfaceLinkRequests(ctx: ControlDispatchContext, links: readonly InterfaceLink[]): Promise<CapsuleInterfaceLinkRequest[]> {
  if (links.length === 0) return [];
  const consumers = new Map((await ctx.operations.capsules.getCapsulesByIds([...new Set(links.map((link) => link.consumerCapsuleId))])).map((app) => [app.id, app]));
  const displays = new Map<string, ReturnType<typeof linkedAppDisplay>>();
  const accounts = new Map<string, Promise<string | undefined>>();
  const requests = await Promise.all(links.map(async (link): Promise<CapsuleInterfaceLinkRequest | undefined> => {
    const consumer = consumers.get(link.consumerCapsuleId);
    if (!consumer || consumer.status === "destroyed") return undefined;
    let display = displays.get(consumer.id);
    if (!display) {
      display = linkedAppDisplay(ctx, consumer);
      displays.set(consumer.id, display);
    }
    let requester = accounts.get(link.requestedBy);
    if (!requester) {
      requester = link.requestedBy === "system"
        ? Promise.resolve(undefined)
        : Promise.resolve(ctx.store.findAccount(link.requestedBy as TakosumiSubject)).then((account) => account?.displayName?.trim() || undefined);
      accounts.set(link.requestedBy, requester);
    }
    const [consumerApp, requestedByDisplayName] = await Promise.all([display, requester]);
    return {
      linkId: link.id,
      generation: link.generation,
      consumerApp,
      requirementKey: link.requirementKey,
      providerInterfaceId: link.providerInterfaceId,
      interfaceType: link.interface.type,
      interfaceVersion: link.interface.version,
      requestedPermissions: [...link.requestedPermissions],
      ...(requestedByDisplayName ? { requestedByDisplayName } : {}),
      createdAt: link.createdAt,
    };
  }));
  return requests.filter((request): request is CapsuleInterfaceLinkRequest => request !== undefined)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.linkId.localeCompare(right.linkId));
}
