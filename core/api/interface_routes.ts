import type { Context, Hono } from "hono";
import type {
  ActorContext,
  Condition,
  CreateInterfaceBindingRequest,
  CreateInterfaceRequest,
  Interface,
  InterfacePhase,
  InterfaceWriteAuthority,
  IssueInterfaceTokenRequest,
  UpdateInterfaceRequest,
} from "takosumi-contract";
import { isValidInterfacePermissionToken } from "takosumi-contract";
import { TAKOSUMI_INTERNAL_ACTOR_HEADER } from "takosumi-contract/reference/compat";
import { decodeActorContext } from "takosumi-contract/internal/rpc";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import { isRecord } from "../shared/guards.ts";
import {
  InterfaceService,
  InterfaceServiceError,
  type InterfaceLinkWriteFence,
  type InterfaceRuntimeConsumer,
} from "../domains/interfaces/mod.ts";
import { apiError, readJsonObject, requestIdFromContext } from "./errors.ts";
import { parsePageQuery } from "./page_query.ts";
import type { ApiEndpoint } from "./route_families.ts";

export interface RegisterInterfaceRoutesOptions {
  readonly service: InterfaceService;
  readonly getInterfaceBearerToken?: () => string | undefined;
  readonly authorizeInterfaceBearer?: (input: {
    readonly token: string;
    readonly request: Request;
  }) => ActorContext | undefined | Promise<ActorContext | undefined>;
  /**
   * Optional host authorization for actors whose credential is not already
   * bound to one Workspace. The callback runs only after the route has resolved
   * the authoritative Interface Workspace. A successful result scopes the
   * actor to that Workspace for the remainder of the request.
   */
  readonly authorizeInterfaceWorkspace?: (input: {
    readonly actor: ActorContext;
    readonly workspaceId: string;
    readonly request: Request;
  }) => boolean | Promise<boolean>;
  /**
   * Optional per-app decision (TASK-0118 9.1) on a Capsule-owned Interface,
   * a `capsuleId` listing or an Interface link: for every write by an account
   * actor (a Workspace-bound one included), for reads by an account actor not
   * bound to a Workspace, and for every request of a credential limited to
   * apps. `action` is the app permission needed (`view`; `change_settings`
   * for Interface create, update, retire and status; `change_interface_link`
   * for Binding create and revoke and for links); `access` is its read/write
   * class. `true` / `false` decide; `undefined` means the app has no
   * ownership row yet and the Workspace decision above applies.
   */
  readonly authorizeInterfaceApp?: (input: {
    readonly actor: ActorContext;
    readonly capsuleId: string;
    readonly access: "read" | "write";
    readonly action: "view" | "change_settings" | "change_interface_link";
    readonly request: Request;
  }) => boolean | undefined | Promise<boolean | undefined>;
}

export const INTERFACE_ENDPOINTS: readonly ApiEndpoint[] = [
  endpoint("POST", "/api/v1/interfaces", "createInterface", {
    okStatus: "201",
    okSchema: "Interface",
    requestSchema: "CreateInterfaceRequest",
  }),
  endpoint("GET", "/api/v1/interfaces", "listInterfaces", {
    okSchema: "ListInterfacesResponse",
    query: [
      "workspaceId",
      "capsuleId",
      "workspace",
      "type",
      "phase",
      "ownerKind",
      "ownerId",
      "includeRetired",
      "permission",
      "limit",
      "cursor",
      "needsReview",
    ],
  }),
  endpoint("GET", "/api/v1/interfaces/:id", "getInterface", {
    okSchema: "Interface",
    pathParams: ["id"],
    query: ["permission"],
  }),
  endpoint("POST", "/api/v1/interfaces/:id/token", "issueInterfaceToken", {
    okSchema: "IssueInterfaceTokenResponse",
    requestSchema: "IssueInterfaceTokenRequest",
    pathParams: ["id"],
  }),
  endpoint("PATCH", "/api/v1/interfaces/:id", "updateInterface", {
    okSchema: "Interface",
    requestSchema: "UpdateInterfaceRequest",
    pathParams: ["id"],
  }),
  endpoint("POST", "/api/v1/interfaces/:id/status", "reportInterfaceStatus", {
    okSchema: "Interface",
    requestSchema: "ReportInterfaceStatusRequest",
    pathParams: ["id"],
  }),
  endpoint("DELETE", "/api/v1/interfaces/:id", "retireInterface", {
    okSchema: "Interface",
    pathParams: ["id"],
  }),
  endpoint("POST", "/api/v1/interfaces/:id/bindings", "createInterfaceBinding", {
    okStatus: "201",
    okSchema: "InterfaceBinding",
    requestSchema: "CreateInterfaceBindingRequest",
    pathParams: ["id"],
  }),
  endpoint("GET", "/api/v1/interfaces/:id/bindings", "listInterfaceBindings", {
    okSchema: "ListInterfaceBindingsResponse",
    pathParams: ["id"],
    query: ["permission"],
  }),
  endpoint(
    "GET",
    "/api/v1/interfaces/:id/bindings/:bindingId",
    "getInterfaceBinding",
    {
      okSchema: "InterfaceBinding",
      pathParams: ["id", "bindingId"],
      query: ["permission"],
    },
  ),
  endpoint(
    "DELETE",
    "/api/v1/interfaces/:id/bindings/:bindingId",
    "revokeInterfaceBinding",
    {
      okSchema: "InterfaceBinding",
      pathParams: ["id", "bindingId"],
    },
  ),
  endpoint("GET", "/api/v1/capsules/:id/interface-links/:requirementKey/candidates", "listInterfaceLinkCandidates", { okSchema: "ListInterfaceLinkCandidatesResponse", pathParams: ["id", "requirementKey"] }),
  endpoint("PUT", "/api/v1/capsules/:id/interface-links/:requirementKey", "putCapsuleInterfaceLink", { requestSchema: "PutCapsuleInterfaceLinkRequest", okSchema: "InterfaceLinkResponse", pathParams: ["id", "requirementKey"] }),
  endpoint("DELETE", "/api/v1/capsules/:id/interface-links/:requirementKey", "revokeCapsuleInterfaceLink", { requestSchema: "RevokeCapsuleInterfaceLinkRequest", okSchema: "InterfaceLinkResponse", pathParams: ["id", "requirementKey"] }),
] as const;

export function registerInterfaceRoutes(
  app: Hono,
  options: RegisterInterfaceRoutesOptions,
): void {
  const linkPath = "/api/v1/capsules/:id/interface-links/:requirementKey";
  app.get(`${linkPath}/candidates`, async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const denied = enforceControlActor(c, auth.actor);
    if (denied) return denied;
    return respond(c, async () => {
      // Decide the consumer app before reading its requirements.
      const consumerCapsule = await options.service.getInterfaceLinkConsumer(c.req.param("id"));
      const scoped = await scopeInterfaceLinkApp(c, options, auth.actor, { capsuleId: consumerCapsule.id, workspaceId: consumerCapsule.workspaceId }, "view");
      if (!scoped.ok) return scoped.response;
      const { capsule, requirement } = await options.service.getInterfaceLinkRequirement(c.req.param("id"), c.req.param("requirementKey"));
      return c.json(await options.service.listInterfaceLinkCandidateView({ workspaceId: capsule.workspaceId, capsuleId: capsule.id, requirement }), 200);
    });
  });
  app.put(linkPath, async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const denied = enforceControlActor(c, auth.actor);
    if (denied) return denied;
    return respond(c, async () => {
      const capsuleId = c.req.param("id");
      const requirementKey = c.req.param("requirementKey");
      // Decide the consumer app before reading its requirements.
      const consumerCapsule = await options.service.getInterfaceLinkConsumer(capsuleId);
      const consumer = { capsuleId: consumerCapsule.id, workspaceId: consumerCapsule.workspaceId };
      const scoped = await scopeInterfaceLinkApp(c, options, auth.actor, consumer, "change_interface_link");
      if (!scoped.ok) return scoped.response;
      await options.service.getInterfaceLinkRequirement(capsuleId, requirementKey);
      const body = await readJsonObject(c.req.raw, { maxBytes: 16_384 });
      const interfaceId = string(body.interfaceId);
      if (!interfaceId) throw invalid("interfaceId is required");
      const expectedRequirementFingerprint = body.expectedRequirementFingerprint;
      if (expectedRequirementFingerprint !== undefined && (typeof expectedRequirementFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(expectedRequirementFingerprint))) throw invalid("expectedRequirementFingerprint must be a SHA-256 digest");
      return c.json({ link: await options.service.putCapsuleInterfaceLink({ capsuleId, requirementKey, interfaceId, expectedGeneration: expectedLinkGeneration(body.expectedGeneration), ...(expectedRequirementFingerprint ? { expectedRequirementFingerprint } : {}) }, scoped.actor, await interfaceLinkWriteFence(c, options, scoped.actor, consumer, consumer)) }, 200);
    });
  });
  app.delete(linkPath, async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const denied = enforceControlActor(c, auth.actor);
    if (denied) return denied;
    return respond(c, async () => {
      const capsuleId = c.req.param("id");
      const requirementKey = c.req.param("requirementKey");
      const capsule = await options.service.getInterfaceLinkConsumer(capsuleId);
      const consumer = { capsuleId: capsule.id, workspaceId: capsule.workspaceId };
      // The consumer app revokes its own links; the provider app may revoke
      // a link that points at it.
      let controlling = consumer;
      let scoped = await scopeInterfaceLinkApp(c, options, auth.actor, consumer, "change_interface_link");
      let authorizedProvider: { linkId: string; providerInterfaceId: string; providerCapsuleId: string } | undefined;
      if (!scoped.ok) {
        const link = await options.service.getLatestCapsuleInterfaceLink(capsuleId, requirementKey);
        if (!link) return scoped.response;
        const provider = await options.service.get(link.providerInterfaceId);
        const providerApp = { capsuleId: link.providerCapsuleId, workspaceId: provider.metadata.workspaceId };
        scoped = await scopeInterfaceLinkApp(c, options, auth.actor, providerApp, "change_interface_link");
        if (scoped.ok) {
          controlling = providerApp;
          authorizedProvider = { linkId: link.id, providerInterfaceId: link.providerInterfaceId, providerCapsuleId: link.providerCapsuleId };
        }
      }
      if (!scoped.ok) return scoped.response;
      const body = await readJsonObject(c.req.raw, { maxBytes: 16_384 });
      return c.json({ link: await options.service.revokeCapsuleInterfaceLink(capsuleId, requirementKey, expectedLinkGeneration(body.expectedGeneration), scoped.actor, await interfaceLinkWriteFence(c, options, scoped.actor, controlling, consumer), authorizedProvider) }, 200);
    });
  });

  app.post("/api/v1/interfaces", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const body = await readJsonObject(c.req.raw, { maxBytes: 1_048_576 });
      const workspaceId = string(body.workspaceId);
      const ownerRef = isRecord(body.ownerRef) ? body.ownerRef : undefined;
      const capsuleOwnerId = ownerRef?.kind === "Capsule" ? string(ownerRef.id) : undefined;
      // Creating a Capsule-owned Interface is a change to that app, decided
      // per app like every other write to it; Workspace-owned Interfaces keep
      // the Workspace decision.
      const scoped = capsuleOwnerId
        ? await scopeInterface(c, options, auth.actor, {
            workspaceId: requireWorkspaceId(workspaceId),
            ownerRef: { kind: "Capsule", id: capsuleOwnerId },
          })
        : await scopeInterfaceWorkspace(c, options, auth.actor, workspaceId);
      if (!scoped.ok) return scoped.response;
      const record = await options.service.create(
        body as unknown as CreateInterfaceRequest,
        scoped.actor,
        undefined,
        undefined,
        scoped.authority,
      );
      return withEtag(c, record, 201);
    });
  });

  app.get("/api/v1/interfaces", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const requestedWorkspaceId = c.req.query("workspaceId");
      const capsuleId = c.req.query("capsuleId");
      if (requestedWorkspaceId && capsuleId) {
        throw invalid("workspaceId and capsuleId cannot be combined");
      }
      const phase = c.req.query("phase") as InterfacePhase | undefined;
      if (phase && !INTERFACE_PHASES.has(phase)) {
        throw invalid("phase is not a valid Interface phase");
      }
      const ownerKind = c.req.query("ownerKind") as
        Interface["metadata"]["ownerRef"]["kind"] | undefined;
      if (ownerKind && !OWNER_KINDS.has(ownerKind)) {
        throw invalid("ownerKind is not supported");
      }
      const ownerId = c.req.query("ownerId");
      if (capsuleId && ((ownerKind && ownerKind !== "Capsule") || (ownerId && ownerId !== capsuleId))) {
        throw invalid("capsuleId selects the Capsule-owned Interfaces of that app");
      }
      const owner = capsuleId
        ? { ownerKind: "Capsule" as const, ownerId: capsuleId }
        : {
          ...(ownerKind ? { ownerKind } : {}),
          ...(ownerId ? { ownerId } : {}),
        };
      const selector = {
        ...(c.req.query("type") ? { type: c.req.query("type") } : {}),
        ...(phase ? { phase } : {}),
        ...owner,
        includeRetired: truthy(c.req.query("includeRetired")),
      };
      const consumer = await runtimeConsumer(c, options, auth.actor);
      if (!consumer.ok) return consumer.response;
      // An app-bound runtime principal (no Workspace) discovers by its exact
      // current Principal Bindings across every internal partition, always
      // restricted to evidence of its own app. A Workspace would name no
      // authority of its own, so it is refused rather than used as a scope;
      // `capsuleId` only narrows to that provider app's Interfaces.
      if (consumer.consumer) {
        if (requestedWorkspaceId) {
          throw invalid("workspaceId is not accepted for an app-bound runtime principal; omit it to discover by its own Bindings");
        }
        const params = parsePageQuery(c.req.query("limit"), c.req.query("cursor"));
        if (!params.ok) throw invalid(params.message);
        const page = await options.service.listAuthorizedForPrincipalAcrossPartitionsPage(
          selector,
          auth.actor!.actorAccountId,
          requireRuntimePermission(c),
          params.value,
          consumer.consumer,
        );
        return c.json({
          interfaces: page.items,
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        }, 200);
      }
      let workspaceId = requestedWorkspaceId;
      let scoped: InterfaceWorkspaceAuthResult;
      if (!workspaceId && capsuleId) {
        // The app's own partition; the per-app decision (or, for an app
        // without an ownership row, the Workspace decision) authorizes it.
        workspaceId = (await options.service.getAppPartition(capsuleId)).workspaceId;
        scoped = await scopeInterface(c, options, auth.actor, {
          workspaceId,
          ownerRef: { kind: "Capsule", id: capsuleId },
        });
      } else {
        if (!workspaceId) throw invalid("workspaceId or capsuleId is required");
        scoped = await scopeInterfaceWorkspace(c, options, auth.actor, workspaceId);
      }
      if (!scoped.ok) return scoped.response;
      // The app's Interfaces that wait for its owner's review (TASK-0118 9.1).
      if (truthy(c.req.query("needsReview"))) {
        if (!capsuleId || isRuntimePrincipal(scoped.actor)) throw invalid("needsReview lists one app's Interfaces: pass capsuleId");
        return c.json({ interfaces: await options.service.listInterfacesNeedingReview(workspaceId, capsuleId) }, 200);
      }
      const filter = { workspaceId, ...selector };
      const interfaces = isRuntimePrincipal(scoped.actor)
        ? await options.service.listAuthorizedForPrincipal(
            filter,
            scoped.actor.actorAccountId,
            requireRuntimePermission(c),
            consumer.consumer,
          )
        : await options.service.list(filter);
      return c.json({ interfaces }, 200);
    });
  });

  app.get("/api/v1/interfaces/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const consumer = await runtimeConsumer(c, options, auth.actor);
      if (!consumer.ok) return consumer.response;
      const record = isRuntimePrincipal(auth.actor)
        ? await options.service.getAuthorizedForPrincipal(
            c.req.param("id"),
            auth.actor.actorAccountId,
            requireRuntimePermission(c),
            consumer.consumer,
          )
        : await options.service.get(c.req.param("id"));
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        record.metadata,
      );
      if (!scoped.ok) return scoped.response;
      return withEtag(c, record, 200);
    });
  });

  app.post("/api/v1/interfaces/:id/token", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const runtimeActor = isRuntimePrincipal(auth.actor)
      ? auth.actor
      : undefined;
    if (!runtimeActor) return runtimePrincipalForbidden(c);
    return respond(c, async () => {
      const body = await readJsonObject(c.req.raw, { maxBytes: 16_384 });
      const permission = runtimePermission(body.permission);
      const consumer = await runtimeConsumer(c, options, runtimeActor);
      if (!consumer.ok) return consumer.response;
      const iface = await options.service.getAuthorizedForPrincipal(
        c.req.param("id"),
        runtimeActor.actorAccountId,
        permission,
        consumer.consumer,
      );
      const scoped = await scopeInterface(
        c,
        options,
        runtimeActor,
        iface.metadata,
      );
      if (!scoped.ok) return scoped.response;
      const issued = await options.service.issueToken(
        iface.metadata.id,
        body as unknown as IssueInterfaceTokenRequest,
        {
          workspaceId: iface.metadata.workspaceId,
          subjectId: runtimeActor.actorAccountId,
          ...(consumer.consumer ? { consumer: consumer.consumer } : {}),
        },
        scoped.actor,
      );
      c.header("cache-control", "no-store");
      c.header("pragma", "no-cache");
      return c.json(issued, 200);
    });
  });

  app.patch("/api/v1/interfaces/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const current = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        current.metadata,
      );
      if (!scoped.ok) return scoped.response;
      requireEtag(c, current);
      const body = await readJsonObject(c.req.raw, { maxBytes: 1_048_576 });
      const record = await options.service.update(
        current.metadata.id,
        body as unknown as UpdateInterfaceRequest,
        current.metadata.generation,
        scoped.actor,
        current.status.resolvedRevision,
      );
      return withEtag(c, record, 200);
    });
  });

  app.delete("/api/v1/interfaces/:id", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const current = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        current.metadata,
      );
      if (!scoped.ok) return scoped.response;
      requireEtag(c, current);
      const record = await options.service.retire(
        current.metadata.id,
        current.metadata.generation,
        scoped.actor,
        current.status.resolvedRevision,
      );
      return withEtag(c, record, 200);
    });
  });

  app.post("/api/v1/interfaces/:id/status", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    // Status self-report is a control-plane operation. Runtime principals stay
    // excluded; operators and service-side probes may update conditions.
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const current = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        current.metadata,
      );
      if (!scoped.ok) return scoped.response;
      const body = await readJsonObject(c.req.raw, { maxBytes: 65_536 });
      const record = await options.service.reportStatusConditions(
        current.metadata.id,
        (Array.isArray(body.conditions)
          ? body.conditions
          : []) as unknown as readonly Condition[],
        scoped.actor,
      );
      return withEtag(c, record, 200);
    });
  });

  app.post("/api/v1/interfaces/:id/bindings", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const iface = await options.service.get(c.req.param("id"));
      // A Binding grants the app's Interface to someone: a link change.
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        iface.metadata,
        "change_interface_link",
      );
      if (!scoped.ok) return scoped.response;
      const body = await readJsonObject(c.req.raw, { maxBytes: 1_048_576 });
      const binding = await options.service.createBinding(
        c.req.param("id"),
        body as unknown as CreateInterfaceBindingRequest,
        scoped.actor,
        undefined,
        undefined,
        scoped.authority,
      );
      return c.json(binding, 201);
    });
  });

  app.get("/api/v1/interfaces/:id/bindings", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const consumer = await runtimeConsumer(c, options, auth.actor);
      if (!consumer.ok) return consumer.response;
      const iface = isRuntimePrincipal(auth.actor)
        ? await options.service.getAuthorizedForPrincipal(
            c.req.param("id"),
            auth.actor.actorAccountId,
            requireRuntimePermission(c),
            consumer.consumer,
          )
        : await options.service.get(c.req.param("id"));
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        iface.metadata,
      );
      if (!scoped.ok) return scoped.response;
      return c.json(
        {
          bindings: isRuntimePrincipal(scoped.actor)
            ? await options.service.listAuthorizedBindingsForPrincipal(
                c.req.param("id"),
                scoped.actor.actorAccountId,
                requireRuntimePermission(c),
                consumer.consumer,
              )
            : await options.service.listBindings(c.req.param("id")),
        },
        200,
      );
    });
  });

  app.get("/api/v1/interfaces/:id/bindings/:bindingId", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    return respond(c, async () => {
      const consumer = await runtimeConsumer(c, options, auth.actor);
      if (!consumer.ok) return consumer.response;
      const iface = isRuntimePrincipal(auth.actor)
        ? await options.service.getAuthorizedForPrincipal(
            c.req.param("id"),
            auth.actor.actorAccountId,
            requireRuntimePermission(c),
            consumer.consumer,
          )
        : await options.service.get(c.req.param("id"));
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        iface.metadata,
      );
      if (!scoped.ok) return scoped.response;
      if (isRuntimePrincipal(scoped.actor)) {
        const binding = (
          await options.service.listAuthorizedBindingsForPrincipal(
            c.req.param("id"),
            scoped.actor.actorAccountId,
            requireRuntimePermission(c),
            consumer.consumer,
          )
        ).find((entry) => entry.metadata.id === c.req.param("bindingId"));
        if (!binding) {
          throw new InterfaceServiceError(
            "not_found",
            "InterfaceBinding not found",
          );
        }
        return c.json(binding, 200);
      }
      return c.json(
        await options.service.getBinding(
          c.req.param("id"),
          c.req.param("bindingId"),
        ),
        200,
      );
    });
  });

  app.delete("/api/v1/interfaces/:id/bindings/:bindingId", async (c) => {
    const auth = await authorize(c, options);
    if (!auth.ok) return auth.response;
    const controlDenied = enforceControlActor(c, auth.actor);
    if (controlDenied) return controlDenied;
    return respond(c, async () => {
      const iface = await options.service.get(c.req.param("id"));
      const scoped = await scopeInterface(
        c,
        options,
        auth.actor,
        iface.metadata,
        "change_interface_link",
      );
      if (!scoped.ok) return scoped.response;
      return c.json(
        await options.service.revokeBinding(
          c.req.param("id"),
          c.req.param("bindingId"),
          scoped.actor,
        ),
        200,
      );
    });
  });
}

const INTERFACE_PHASES = new Set<InterfacePhase>([
  "Pending",
  "Resolved",
  "NotReady",
  "Unknown",
  "Terminating",
  "Retired",
]);
const OWNER_KINDS = new Set<Interface["metadata"]["ownerRef"]["kind"]>([
  "Workspace",
  "Capsule",
]);

type InterfaceAuthResult =
  | { readonly ok: true; readonly actor?: ActorContext }
  | { readonly ok: false; readonly response: Response };

async function authorize(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
): Promise<InterfaceAuthResult> {
  const configured = options.getInterfaceBearerToken?.();
  if (!configured && !options.authorizeInterfaceBearer) return { ok: true };
  const bearer = bearerToken(c.req.header("authorization"));
  if (!bearer) return { ok: false, response: unauthorized(c) };
  if (configured && constantTimeEqualsString(configured, bearer)) {
    const actorHeader = c.req.header(TAKOSUMI_INTERNAL_ACTOR_HEADER);
    if (!actorHeader) return { ok: true };
    try {
      return { ok: true, actor: decodeActorContext(actorHeader) };
    } catch {
      return { ok: false, response: unauthorized(c) };
    }
  }
  if (options.authorizeInterfaceBearer) {
    const actor = await options.authorizeInterfaceBearer({
      token: bearer,
      request: c.req.raw,
    });
    return actor
      ? { ok: true, actor }
      : { ok: false, response: unauthorized(c) };
  }
  return { ok: false, response: unauthorized(c) };
}

type InterfaceWorkspaceAuthResult =
  | {
    readonly ok: true;
    readonly actor?: ActorContext;
    /** The authority that admitted the request; recorded on Capsule-owned writes. */
    readonly authority: InterfaceWriteAuthority;
  }
  | { readonly ok: false; readonly response: Response };

/** The app action an Interface request needs on a Capsule-owned Interface. */
type InterfaceAppAction = "view" | "change_settings" | "change_interface_link";

async function scopeInterfaceWorkspace(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
  workspaceId: string | undefined,
): Promise<InterfaceWorkspaceAuthResult> {
  if (!workspaceId) throw invalid("workspaceId is required");
  // No actor means the configured internal deploy-control bearer was used
  // without an actor header. That remains the explicit operator authority.
  if (!actor) return { ok: true, authority: "operator" };
  // A credential limited to apps never holds Workspace authority.
  if (!actor.roles.includes("runtime-principal") && actor.appIds !== undefined) {
    return { ok: false, response: workspaceForbidden(c) };
  }
  if (isRuntimePrincipal(actor) && !actor.workspaceId) {
    // An app-bound runtime principal carries no Workspace (TASK-0118 9.1).
    // It reaches this point only for one exact Interface it already read
    // through its own Principal Binding with the evidence restriction of
    // runtimeConsumer (read, bindings, token); discovery never scopes it to
    // a Workspace, and runtime principals never reach a mutation. The
    // Interface's partition is recorded here only as the request's context,
    // never as authority. Without an app it has no authority.
    if (!string(actor.capsuleId)) return { ok: false, response: workspaceForbidden(c) };
    return { ok: true, actor: { ...actor, workspaceId }, authority: "workspace" };
  }
  if (actor.workspaceId && actor.workspaceId !== workspaceId) {
    return { ok: false, response: workspaceForbidden(c) };
  }
  if (options.authorizeInterfaceWorkspace) {
    if (
      !(await options.authorizeInterfaceWorkspace({
        actor,
        workspaceId,
        request: c.req.raw,
      }))
    ) {
      return { ok: false, response: workspaceForbidden(c) };
    }
  } else if (!actor.workspaceId) {
    // An authenticated but unscoped actor is never global authority. Hosts
    // that accept account sessions or unbound PATs must prove membership via
    // authorizeInterfaceWorkspace above.
    return { ok: false, response: workspaceForbidden(c) };
  }
  return {
    ok: true,
    actor:
      actor.workspaceId === workspaceId ? actor : { ...actor, workspaceId },
    authority: "workspace",
  };
}

type RuntimeConsumerResult =
  | { readonly ok: true; readonly consumer?: InterfaceRuntimeConsumer }
  | { readonly ok: false; readonly response: Response };

/**
 * The evidence restriction for a Workspace-free runtime principal
 * (TASK-0118 9.1). Its pairwise subject is learnable by providers it talks
 * to, and whoever may write Bindings in a partition (another tenant of a
 * shared legacy partition included) may bind any subject there, so a
 * Binding is accepted only when it was materialized from an active
 * Interface link of the token's own app, or sits on an Interface that app
 * owns. The app must exist (an unknown app is 404). A Workspace-bound
 * runtime principal keeps its Workspace fence instead; other actors are not
 * runtime principals.
 */
async function runtimeConsumer(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
): Promise<RuntimeConsumerResult> {
  if (!isRuntimePrincipal(actor) || actor.workspaceId) return { ok: true };
  const capsuleId = string(actor.capsuleId);
  if (!capsuleId) return { ok: false, response: workspaceForbidden(c) };
  await options.service.getAppPartition(capsuleId);
  return { ok: true, consumer: { capsuleId } };
}

/**
 * Scope a request to one Interface's owner. When the host provides
 * {@link RegisterInterfaceRoutesOptions.authorizeInterfaceApp}, a
 * Capsule-owned Interface is decided per app for an account actor: every
 * write (create, update, retire and status need `change_settings`; Binding
 * create and revoke, which grant the app's Interface to someone, need
 * `change_interface_link`), reads by an actor without a Workspace
 * restriction, and every request of a credential limited to apps. A
 * Workspace-bound credential must still name the Interface's own partition,
 * but Workspace membership alone no longer changes another person's app: in
 * a shared legacy partition it would let a co-tenant repoint the app's
 * Interface or bind the app's subject to one they made. Service principals,
 * Workspace-owned Interfaces and apps without an ownership row keep the
 * Workspace decision.
 */
async function scopeInterface(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
  owner: Pick<Interface["metadata"], "workspaceId" | "ownerRef">,
  writeAction: Exclude<InterfaceAppAction, "view"> = "change_settings",
): Promise<InterfaceWorkspaceAuthResult> {
  const access = interfaceAccess(c);
  if (owner.ownerRef.kind === "Capsule") {
    const decided = await decideInterfaceApp(c, options, actor, {
      capsuleId: owner.ownerRef.id,
      workspaceId: owner.workspaceId,
    }, access === "read" ? "view" : writeAction);
    if (decided) return decided;
  }
  return await scopeInterfaceWorkspace(c, options, actor, owner.workspaceId);
}

/**
 * The per-app decision for an account actor on one app, or `undefined` when
 * the Workspace decision applies (no host decision, a runtime or service
 * principal, a Workspace-bound read, or an app without an ownership row).
 */
async function decideInterfaceApp(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
  app: { readonly capsuleId: string; readonly workspaceId: string },
  action: InterfaceAppAction,
  mode: {
    /** Workspace-bound reads keep the Workspace decision (Interfaces); links decide every request per app. */
    readonly workspaceBoundReads?: boolean;
  } = {},
): Promise<InterfaceWorkspaceAuthResult | undefined> {
  if (
    !appDecidedActor(options, actor) ||
    (mode.workspaceBoundReads !== false && actor.workspaceId && action === "view" && actor.appIds === undefined)
  ) {
    return undefined;
  }
  if (actor.workspaceId && actor.workspaceId !== app.workspaceId) {
    return { ok: false, response: workspaceForbidden(c) };
  }
  if (actor.appIds !== undefined && !actor.appIds.includes(app.capsuleId)) {
    return { ok: false, response: appForbidden(c) };
  }
  const decided = await options.authorizeInterfaceApp!({
    actor,
    capsuleId: app.capsuleId,
    access: action === "view" ? "read" : "write",
    action,
    request: c.req.raw,
  });
  if (decided === true) {
    return {
      ok: true,
      actor: actor.workspaceId === app.workspaceId ? actor : { ...actor, workspaceId: app.workspaceId },
      authority: "app",
    };
  }
  if (decided === false) return { ok: false, response: appForbidden(c) };
  return undefined;
}

function requireWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) throw invalid("workspaceId is required");
  return workspaceId;
}

/** Reads and token issuance (an invocation of a Ready binding) are read access. */
function interfaceAccess(c: Context): "read" | "write" {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "POST" && /\/token$/u.test(new URL(c.req.url).pathname)) return "read";
  return "write";
}

function appForbidden(c: Context): Response {
  return c.json(
    apiError(
      "forbidden",
      "Interface belongs to an app the caller cannot manage",
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function workspaceForbidden(c: Context): Response {
  return c.json(
    apiError(
      "forbidden",
      "Interface belongs to a different Workspace",
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function isRuntimePrincipal(
  actor: ActorContext | undefined,
): actor is ActorContext {
  return actor?.roles.includes("runtime-principal") === true;
}

function enforceControlActor(
  c: Context,
  actor: ActorContext | undefined,
): Response | undefined {
  if (!isRuntimePrincipal(actor)) return undefined;
  return c.json(
    apiError(
      "forbidden",
      "runtime principals cannot mutate Interface desired state or bindings",
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function runtimePrincipalForbidden(c: Context): Response {
  return c.json(
    apiError(
      "forbidden",
      "only a runtime Principal can request an Interface token",
      undefined,
      requestIdFromContext(c),
    ),
    403,
  );
}

function requireRuntimePermission(c: Context): string {
  return runtimePermission(c.req.query("permission"));
}

function runtimePermission(value: unknown): string {
  const permission = string(value);
  if (!isValidInterfacePermissionToken(permission)) {
    throw invalid(
      "permission is required for runtime Interface discovery and must be one RFC 6749 scope token",
    );
  }
  return permission;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? "");
  return match?.[1]?.trim() || undefined;
}

function unauthorized(c: Context): Response {
  return c.json(
    apiError(
      "unauthenticated",
      "invalid Interface API bearer",
      undefined,
      requestIdFromContext(c),
    ),
    401,
  );
}

async function respond(
  c: Context,
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof InterfaceServiceError)) throw error;
    return c.json(
      apiError(error.code, error.message, undefined, requestIdFromContext(c)),
      status(error),
    );
  }
}

function status(error: InterfaceServiceError): 400 | 403 | 404 | 409 | 412 {

  switch (error.code) {
    case "permission_denied":
      return 403;
    case "invalid_argument":
      return 400;
    case "not_found":
      return 404;
    case "already_exists":
    case "conflict":
    case "interface_link_approval_required":
      return 409;
    case "failed_precondition":
      return 412;
  }
}

function invalid(message: string): InterfaceServiceError {
  return new InterfaceServiceError("invalid_argument", message);
}

function etag(record: Interface): string {
  return `\"if-${record.metadata.generation}-${record.status.resolvedRevision}\"`;
}

function requireEtag(c: Context, record: Interface): void {
  if (c.req.header("if-match") !== etag(record)) {
    throw new InterfaceServiceError(
      "failed_precondition",
      "If-Match must equal the current Interface ETag",
    );
  }
}

function withEtag(
  c: Context,
  record: Interface,
  statusCode: 200 | 201,
): Response {
  c.header("etag", etag(record));
  return c.json(record, statusCode);
}

function truthy(value: string | undefined): boolean {
  return (
    value !== undefined &&
    ["1", "true", "yes", "on"].includes(value.toLowerCase())
  );
}

function endpoint(
  method: ApiEndpoint["method"],
  path: string,
  operationId: string,
  openapi: ApiEndpoint["openapi"],
): ApiEndpoint {
  return {
    method,
    path,
    summary: `Runtime Interface API: ${operationId}`,
    auth: "deploy-control-token",
    operationId,
    tag: "interfaces",
    openapi,
  };
}

function expectedLinkGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid("expectedGeneration must be a non-negative integer");
  return value;
}

async function interfaceLinkWriteFence(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
  controlling: { readonly capsuleId: string; readonly workspaceId: string },
  consumer: { readonly capsuleId: string; readonly workspaceId: string },
): Promise<InterfaceLinkWriteFence> {
  const workspaceId = controlling.workspaceId;
  const initial = await options.service.captureInterfaceLinkWriteAuthority(workspaceId);
  return {
    assertCurrent: async () => {
      const auth = await authorize(c, options);
      if (!auth.ok || auth.actor?.roles.includes("runtime-principal") === true || auth.actor?.actorAccountId !== actor?.actorAccountId) throw new InterfaceServiceError("permission_denied", "Interface link caller authority changed");
      const scoped = await scopeInterfaceLinkApp(c, options, auth.actor, controlling, "change_interface_link");
      if (!scoped.ok) throw new InterfaceServiceError("permission_denied", "Interface link management access changed");
      const current = await options.service.captureInterfaceLinkWriteAuthority(workspaceId);
      if (initial && (!current || current.managementEpoch !== initial.managementEpoch)) throw new InterfaceServiceError("conflict", "Workspace management authority changed");
      return initial;
    },
    // An account caller's link is approved at creation only when it may
    // change links on the PROVIDER app too (its own app needs no approval);
    // otherwise it waits as pending_approval, as on Accounts. The operator
    // keeps the approval policy alone.
    ...(appDecidedActor(options, actor)
      ? {
        mayApproveProvider: async (provider: { readonly capsuleId: string; readonly workspaceId: string }) =>
          provider.capsuleId === consumer.capsuleId ||
          (await scopeInterfaceLinkApp(c, options, actor, provider, "change_interface_link")).ok,
      }
      : {}),
  };
}

/** An account actor the host decides per app (TASK-0118 9.1). */
function appDecidedActor(
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
): actor is ActorContext {
  return actor !== undefined && options.authorizeInterfaceApp !== undefined &&
    !actor.roles.includes("runtime-principal") && actor.principalKind !== "service";
}

/**
 * An Interface link request on one app: decided per app for an account actor
 * (`view` for candidates; `change_interface_link` for links), like the
 * Accounts link routes; otherwise (and for an app without an ownership row)
 * the Workspace decision.
 */
async function scopeInterfaceLinkApp(
  c: Context,
  options: RegisterInterfaceRoutesOptions,
  actor: ActorContext | undefined,
  app: { readonly capsuleId: string; readonly workspaceId: string },
  action: "view" | "change_interface_link",
): Promise<InterfaceWorkspaceAuthResult> {
  const decided = await decideInterfaceApp(c, options, actor, app, action, { workspaceBoundReads: false });
  return decided ?? await scopeInterfaceWorkspace(c, options, actor, app.workspaceId);
}
