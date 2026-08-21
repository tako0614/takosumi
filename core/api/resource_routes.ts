// Resource Shape composition.
//
// Resource Shape records, stores, schemas, and typed operations remain part of
// the Core domain. The former `/v1/resources`, `/v1/target-pools`, and
// `/v1/space-policies` HTTP family is retired and is intentionally not mounted
// here. This module only composes the portable Takoform host protocol, which
// has its own `/.well-known/takoform` and `/apis/forms...` contract.

import type { Context, Hono } from "hono";
import type {
  ActorContext,
  ResourceCapsuleOwner,
  ResourceShapeKind,
} from "takosumi-contract";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import {
  type PortableInterfaceDeclarationReader,
  registerPortableFormHostRoutes,
} from "./form_host_routes.ts";
import type { PortableHostIdempotencyCoordinator } from "./portable_host_idempotency.ts";
import type {
  ResourceArtifactService,
  ResourceFormTransitionService,
  ResourceShapeService,
} from "../domains/resource-shape/mod.ts";
import { apiError, requestIdFromContext } from "./errors.ts";

/**
 * Trusted in-process authoring-surface identity. Public ingress must strip
 * this header before setting its own value. Kept for typed/domain callers and
 * historical migration code; no retired HTTP route reads it.
 */
export const TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER =
  "x-takosumi-resource-managed-by";

export interface RegisterResourceShapeRoutesOptions {
  readonly service: ResourceShapeService;
  /** Mount the portable Takoform host surface (defaults to true). */
  readonly takoformHost?: boolean;
  /** Durable replay authority for the portable Form host lifecycle surface. */
  readonly portableHostIdempotency?: PortableHostIdempotencyCoordinator;
  /** Separate exact-Form identity transition service and durable saga. */
  readonly resourceFormTransition?: ResourceFormTransitionService;
  /** Optional canonical byte ingress backed by a host-installed artifact writer. */
  readonly artifactService?: ResourceArtifactService;
  /** Optional portable declaration read (ADR 0002). */
  readonly interfaceDeclarations?: PortableInterfaceDeclarationReader;
  /** Retained typed-operation configuration; not an HTTP capability. */
  readonly enabledResourceShapeKinds?: readonly ResourceShapeKind[];
  /** Retained schemas that may read retained state in typed operations. */
  readonly installedResourceShapeKinds?: readonly ResourceShapeKind[];
  /** Resolves the acting principal for the portable host request. */
  readonly resolveActor?: (c: Context) => ActorContext | Promise<ActorContext>;
  /** Bearer used by host compositions that expose the portable protocol. */
  readonly getResourceShapeBearerToken?: () => string | undefined;
  /** Scoped bearer resolver supplied by an operator/account plane. */
  readonly authorizeResourceShapeBearer?: (input: {
    readonly token: string;
    readonly request: Request;
  }) => ActorContext | undefined | Promise<ActorContext | undefined>;
  /** Resolves an authenticated Capsule Run to its exact durable Resource owner. */
  readonly resolveResourceCapsuleOwner?: (input: {
    readonly actor: ActorContext;
    readonly request: Request;
    readonly space: string;
    readonly kind: ResourceShapeKind;
    readonly name: string;
  }) => ResourceCapsuleOwner | undefined | Promise<ResourceCapsuleOwner | undefined>;
}

/**
 * Historical export retained only so migration/import code can distinguish
 * the retired family. It is deliberately empty: no `/v1` Resource Shape
 * endpoint is part of capabilities, OpenAPI, or route discovery.
 */
export const RESOURCE_SHAPE_ENDPOINTS: readonly [] = [];

/**
 * Compose only the portable host protocol. The retired Resource Shape HTTP
 * family is not registered, even when a domain service is present.
 */
export function registerResourceShapeRoutes(
  app: Hono,
  options: RegisterResourceShapeRoutesOptions,
): void {
  if (
    options.takoformHost === false ||
    options.portableHostIdempotency === undefined
  ) {
    return;
  }

  registerPortableFormHostRoutes(app, {
    service: options.service,
    availability: options.service,
    authorize: (c) => authorizeResourceShapeRequest(c, options),
    canReadForms: hasFormAvailabilityReadScope,
    canWriteInterfaces: hasInterfaceDeclarationWriteScope,
    idempotency: options.portableHostIdempotency,
    ...(options.resolveResourceCapsuleOwner
      ? { resolveResourceCapsuleOwner: options.resolveResourceCapsuleOwner }
      : {}),
    ...(options.resourceFormTransition
      ? { formTransition: options.resourceFormTransition }
      : {}),
    ...(options.interfaceDeclarations
      ? { interfaceDeclarations: options.interfaceDeclarations }
      : {}),
  });
}

async function resolveActor(
  c: Context,
  options: RegisterResourceShapeRoutesOptions,
): Promise<ActorContext> {
  if (options.resolveActor) return options.resolveActor(c);
  return {
    actorAccountId: "self-host",
    roles: ["owner"],
    requestId: requestIdFromContext(c),
  };
}

type ResourceShapeAuthResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly response: Response };

export async function authorizeResourceShapeRequest(
  c: Context,
  options: RegisterResourceShapeRoutesOptions,
): Promise<ResourceShapeAuthResult> {
  const configuredToken = options.getResourceShapeBearerToken?.();
  if (!configuredToken && !options.authorizeResourceShapeBearer) {
    return { ok: true, actor: await resolveActor(c, options) };
  }

  const bearer = bearerTokenFromAuthorization(c.req.header("authorization"));
  if (!bearer) return invalidResourceShapeBearer(c);

  if (options.authorizeResourceShapeBearer) {
    const actor = await options.authorizeResourceShapeBearer({
      token: bearer,
      request: c.req.raw,
    });
    if (actor) return { ok: true, actor };
    return invalidResourceShapeBearer(c);
  }

  if (!configuredToken || !constantTimeEqualsString(bearer, configuredToken)) {
    return invalidResourceShapeBearer(c);
  }
  return { ok: true, actor: await resolveActor(c, options) };
}

function bearerTokenFromAuthorization(
  value: string | undefined,
): string | undefined {
  const prefix = "Bearer ";
  return value?.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function invalidResourceShapeBearer(c: Context): ResourceShapeAuthResult {
  return {
    ok: false,
    response: c.json(
      apiError(
        "unauthenticated",
        "invalid resource shape bearer",
        undefined,
        requestIdFromContext(c),
      ),
      401,
    ),
  };
}

/** Scope helper shared by the retained portable Form host facade. */
export function hasFormAvailabilityReadScope(actor: ActorContext): boolean {
  if (actor.scopes === undefined) return true;
  const scopes = new Set(actor.scopes);
  return (
    scopes.has("*") ||
    scopes.has("forms:read") ||
    scopes.has("resources:read") ||
    scopes.has("resources:*") ||
    scopes.has("read") ||
    scopes.has("admin")
  );
}

/**
 * Interface declarations have their own mutation authority. Resource,
 * Capsule, and generic account write grants cannot silently acquire it merely
 * because a declaration is attached to a retained Resource.
 */
export function hasInterfaceDeclarationWriteScope(
  actor: ActorContext,
): boolean {
  if (actor.scopes === undefined) return true;
  const scopes = new Set(actor.scopes);
  return (
    scopes.has("*") ||
    scopes.has("admin") ||
    scopes.has("interfaces:write") ||
    scopes.has("interfaces:*")
  );
}
