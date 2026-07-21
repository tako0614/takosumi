import type { Context, Hono } from "hono";
import type {
  ActorContext,
  FormAvailability,
  InstalledFormReference,
  JsonObject,
  ResourceObject,
  ResourceShapeKind,
  TakoformDeclaredInterface,
  TakoformResource,
  TakoformHostErrorCode,
} from "takosumi-contract";
import {
  createTakoformHostDiscovery,
  installedFormReferenceKey,
  isInstalledFormReference,
  isResourceShapeKind,
  TAKOFORM_FORM_HOST_API_PATH,
  TAKOFORM_FORM_HOST_API_VERSION,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
} from "takosumi-contract";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  ApplyResourceRequest,
  ResourceServiceError,
  ResourceShapeService,
} from "../domains/resource-shape/mod.ts";
import { formatResourceShapeId } from "../domains/resource-shape/mod.ts";
import { PortableDeclarationReadLimitError } from "../domains/interfaces/portable_declarations.ts";
import { readJsonObject, requestIdFromContext } from "./errors.ts";
import type { ApiEndpoint } from "./route_families.ts";
import { parsePageQuery } from "./page_query.ts";

const PORTABLE_FORM_MANAGER = "takoform.form-host.v1";
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u;

export interface PortableFormAvailabilityReader {
  listFormAvailability(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly identity?: InstalledFormReference;
    readonly page?: PageParams;
  }): Promise<Page<FormAvailability>>;
}

export interface PortableInterfaceDeclarationReader {
  listDeclaredInterfaces(input: {
    readonly actor: ActorContext;
    readonly space: string;
    readonly name?: string;
    readonly version?: string;
    readonly resourceKind?: string;
    readonly resourceName?: string;
  }): Promise<readonly TakoformDeclaredInterface[]>;
}

export type PortableFormHostAuthResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly response: Response };

export interface RegisterPortableFormHostRoutesOptions {
  readonly service: ResourceShapeService;
  readonly availability: PortableFormAvailabilityReader;
  /** Uses the same trusted principal resolution as the canonical Resource API. */
  readonly authorize: (c: Context) => Promise<PortableFormHostAuthResult>;
  readonly canReadForms: (actor: ActorContext) => boolean;
  readonly interfaceDeclarations?: PortableInterfaceDeclarationReader;
}

/**
 * Portable Form host routes mounted by the Resource Shape family. They are
 * intentionally excluded from Takosumi's own OpenAPI inventory; the portable
 * contract advertises them through its well-known document. Keeping the list
 * beside the mount calls lets the edge ingress derive routing without a second
 * hand-maintained prefix list.
 */
export const PORTABLE_FORM_HOST_ENDPOINTS: readonly ApiEndpoint[] = [
  portableEndpoint("GET", TAKOFORM_FORM_HOST_WELL_KNOWN_PATH, {
    operationId: "getTakoformHostDiscovery",
    auth: "none",
  }),
  portableEndpoint("GET", `${TAKOFORM_FORM_HOST_API_PATH}/interfaces`, {
    operationId: "listTakoformDeclaredInterfaces",
  }),
  portableEndpoint("GET", `${TAKOFORM_FORM_HOST_API_PATH}/interfaces/:name`, {
    operationId: "getTakoformDeclaredInterface",
  }),
  portableEndpoint("GET", `${TAKOFORM_FORM_HOST_API_PATH}/forms`, {
    operationId: "listTakoformAvailableForms",
  }),
  portableEndpoint("POST", `${TAKOFORM_FORM_HOST_API_PATH}/resources/preview`, {
    operationId: "previewTakoformResource",
  }),
  portableEndpoint("GET", `${TAKOFORM_FORM_HOST_API_PATH}/resources`, {
    operationId: "listTakoformResources",
  }),
  portableEndpoint(
    "PUT",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name`,
    { operationId: "putTakoformResource" },
  ),
  portableEndpoint(
    "GET",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name`,
    { operationId: "getTakoformResource" },
  ),
  portableEndpoint(
    "DELETE",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name`,
    { operationId: "deleteTakoformResource" },
  ),
  portableEndpoint(
    "POST",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/import`,
    { operationId: "importTakoformResource" },
  ),
  portableEndpoint(
    "POST",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/observe`,
    { operationId: "observeTakoformResource" },
  ),
  portableEndpoint(
    "POST",
    `${TAKOFORM_FORM_HOST_API_PATH}/resources/:kind/:name/refresh`,
    { operationId: "refreshTakoformResource" },
  ),
] as const;

function portableEndpoint(
  method: ApiEndpoint["method"],
  path: string,
  options: {
    readonly operationId: string;
    readonly auth?: ApiEndpoint["auth"];
  },
): ApiEndpoint {
  return {
    method,
    path,
    summary: `Portable Form host API: ${options.operationId}`,
    auth: options.auth ?? "deploy-control-token",
    operationId: options.operationId,
    discoverable: false,
    tag: "resource-shape",
    openapi: { okSchema: "ResourceShapeResponse" },
  };
}

/**
 * Mounts the provider-neutral Form host facade. Every lifecycle call delegates
 * to ResourceShapeService; this module owns no Resource, Run, audit, or
 * idempotency ledger.
 */
export function registerPortableFormHostRoutes(
  app: Hono,
  options: RegisterPortableFormHostRoutesOptions,
): void {
  const base = TAKOFORM_FORM_HOST_API_PATH;
  const declarations = options.interfaceDeclarations;

  app.get(TAKOFORM_FORM_HOST_WELL_KNOWN_PATH, (c) =>
    c.json(
      createTakoformHostDiscovery(new URL(c.req.url).origin, {
        interfaceDeclarations: declarations !== undefined,
      }),
      200,
    ),
  );

  if (declarations) {
    app.get(`${base}/interfaces`, async (c) => {
      const auth = await options.authorize(c);
      if (!auth.ok) return portableAuthError(c, auth.response);
      if (!options.canReadForms(auth.actor)) {
        return portableError(
          c,
          "permission_denied",
          "interface declaration read scope is required",
          403,
        );
      }
      const query = declarationQuery(c);
      if (!query.ok) return query.response;
      const listed = await readPortableDeclarations(c, declarations, {
        actor: auth.actor,
        ...query.value,
      });
      if (!listed.ok) return listed.response;
      return c.json({ interfaces: listed.value }, 200);
    });

    app.get(`${base}/interfaces/:name`, async (c) => {
      const auth = await options.authorize(c);
      if (!auth.ok) return portableAuthError(c, auth.response);
      if (!options.canReadForms(auth.actor)) {
        return portableError(
          c,
          "permission_denied",
          "interface declaration read scope is required",
          403,
        );
      }
      const query = declarationQuery(c);
      if (!query.ok) return query.response;
      const name = c.req.param("name");
      if (!name) return failed(c, "interface name is required").response;
      const listed = await readPortableDeclarations(c, declarations, {
        actor: auth.actor,
        ...query.value,
        name,
      });
      if (!listed.ok) return listed.response;
      const matches = listed.value;
      if (matches.length === 0) {
        return portableError(
          c,
          "resource_not_found",
          "no declared interface matches that exact identity",
          404,
        );
      }
      if (matches.length !== 1) {
        const versions = new Set(matches.map((match) => match.version));
        if (query.value.version === undefined && versions.size > 1) {
          return portableError(
            c,
            "interface_identity_ambiguous",
            "interface name matches multiple visible versions; provide version",
            409,
          );
        }
        return portableError(
          c,
          "interface_instance_ambiguous",
          "declared interface identity matches multiple visible instances; provide version and Resource selector",
          409,
        );
      }
      return c.json(matches[0]!, 200);
    });
  }

  app.get(`${base}/forms`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    if (!options.canReadForms(auth.actor)) {
      return portableError(
        c,
        "permission_denied",
        "form availability read scope is required",
        403,
      );
    }
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const page = pageQuery(c);
    if (!page.ok) return page.response;
    const identity = formIdentityFromQuery(c, false);
    if (!identity.ok) return identity.response;
    const result = await options.availability.listFormAvailability({
      actor: auth.actor,
      space: space.value,
      ...(identity.value ? { identity: identity.value } : {}),
      page: page.value,
    });
    return c.json(
      {
        forms: result.items,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      },
      200,
    );
  });

  app.post(`${base}/resources/preview`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const parsed = await parseResourceBody(c, auth.actor);
    if (!parsed.ok) return parsed.response;
    const operation = await desiredWriteOperation(
      options.service,
      parsed.request,
    );
    const available = await requireAvailableForm(
      c,
      options,
      auth.actor,
      parsed.request,
      operation,
    );
    if (!available.ok) return available.response;
    const result = await options.service.preview(parsed.request);
    if (!result.ok) return serviceError(c, result.error);
    return c.json(
      {
        resource: portableResource(result.value.resource),
        review: {
          planDigest: result.value.planDigest,
          specDigest: result.value.specDigest,
        },
        summary: "portable resource preview ready",
      },
      200,
    );
  });

  app.put(`${base}/resources/:kind/:name`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const parsed = await parseResourceBody(
      c,
      withIdempotencyRequest(auth.actor, key.value),
      true,
    );
    if (!parsed.ok) return parsed.response;
    const review = reviewFromBody(c, parsed.body);
    if (!review.ok) return review.response;
    const replay = await completedApplyReplay(options.service, parsed.request);
    if (replay)
      return portableJson(c, portableResource(replay), 200, key.value);
    const operation = await desiredWriteOperation(
      options.service,
      parsed.request,
    );
    const available = await requireAvailableForm(
      c,
      options,
      auth.actor,
      parsed.request,
      operation,
    );
    if (!available.ok) return available.response;
    const result = await options.service.apply(parsed.request, review.value);
    if (!result.ok) return serviceError(c, result.error);
    return portableJson(c, portableResource(result.value), 200, key.value);
  });

  app.post(`${base}/resources/:kind/:name/import`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const parsed = await parseResourceBody(
      c,
      withIdempotencyRequest(auth.actor, key.value),
      true,
    );
    if (!parsed.ok) return parsed.response;
    const nativeId = stringValue(parsed.body.nativeId);
    if (!nativeId)
      return portableError(c, "invalid_argument", "nativeId is required", 400);
    const importRequest = {
      ...parsed.request,
      nativeId,
    };
    const replayStatus =
      await options.service.importReplayStatus(importRequest);
    if (!replayStatus) {
      const available = await requireAvailableForm(
        c,
        options,
        auth.actor,
        parsed.request,
        "import",
      );
      if (!available.ok) return available.response;
    }
    const result = await options.service.importResource(importRequest, {
      replayOnly: replayStatus !== undefined,
    });
    if (!result.ok) return serviceError(c, result.error);
    return portableJson(
      c,
      {
        resource: portableResource(result.value.resource),
        import: {
          summary: "portable import completed",
          ...(result.value.import.runId
            ? { runId: result.value.import.runId }
            : {}),
        },
      },
      200,
      key.value,
    );
  });

  app.get(`${base}/resources`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const space = requiredQuery(c, "space");
    if (!space.ok) return space.response;
    const identity = formIdentityFromQuery(c, true);
    if (!identity.ok) return identity.response;
    const page = pageQuery(c);
    if (!page.ok) return page.response;
    const result = await options.service.listPage(space.value, page.value);
    const key = installedFormReferenceKey(identity.value);
    return c.json(
      {
        resources: result.items
          .filter(
            (item) => item.form && installedFormReferenceKey(item.form) === key,
          )
          .map(portableResource),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      },
      200,
    );
  });

  app.get(`${base}/resources/:kind/:name`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const located = await exactStoredResource(c, options.service, false);
    if (!located.ok) return located.response;
    return portableJson(c, portableResource(located.value), 200);
  });

  app.post(`${base}/resources/:kind/:name/observe`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const located = await exactStoredResource(c, options.service, true);
    if (!located.ok) return located.response;
    const result = await options.service.observe(
      located.value.metadata.space,
      located.value.kind,
      located.value.metadata.name,
      withIdempotencyRequest(auth.actor, key.value),
      { expectedGeneration: located.value.metadata.generation },
    );
    if (!result.ok) return serviceError(c, result.error);
    return portableJson(
      c,
      {
        resource: portableResource(result.value.resource),
        observation: {
          status: result.value.observation.status,
          summary: `portable observation ${result.value.observation.status}`,
          ...(result.value.observation.runId
            ? { runId: result.value.observation.runId }
            : {}),
        },
      },
      200,
      key.value,
    );
  });

  app.post(`${base}/resources/:kind/:name/refresh`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const located = await exactStoredResource(c, options.service, true);
    if (!located.ok) return located.response;
    const result = await options.service.refresh(
      located.value.metadata.space,
      located.value.kind,
      located.value.metadata.name,
      withIdempotencyRequest(auth.actor, key.value),
      { expectedGeneration: located.value.metadata.generation },
    );
    if (!result.ok) return serviceError(c, result.error);
    return portableJson(
      c,
      {
        resource: portableResource(result.value.resource),
        refresh: {
          summary: "portable refresh completed",
          ...(result.value.refresh.runId
            ? { runId: result.value.refresh.runId }
            : {}),
        },
      },
      200,
      key.value,
    );
  });

  app.delete(`${base}/resources/:kind/:name`, async (c) => {
    const auth = await options.authorize(c);
    if (!auth.ok) return portableAuthError(c, auth.response);
    const key = idempotencyKey(c);
    if (!key.ok) return key.response;
    const located = await exactStoredResource(c, options.service, true, true);
    if (!located.ok) return located.response;
    if (!located.value) return c.body(null, 204);
    const result = await options.service.delete(
      located.value.metadata.space,
      located.value.kind,
      located.value.metadata.name,
      withIdempotencyRequest(auth.actor, key.value),
      {
        expectedManagedBy: PORTABLE_FORM_MANAGER,
        expectedGeneration: located.value.metadata.generation,
      },
    );
    if (!result.ok) return serviceError(c, result.error);
    c.header("idempotency-key", key.value);
    return c.body(null, 204);
  });
}

async function parseResourceBody(
  c: Context,
  actor: ActorContext,
  requireWritePrecondition = false,
): Promise<
  | {
      readonly ok: true;
      readonly request: ApplyResourceRequest;
      readonly body: JsonObject;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const body = await readJsonObject(c.req.raw);
  if (body.apiVersion !== TAKOFORM_FORM_HOST_API_VERSION) {
    return failed(
      c,
      "apiVersion must name the exact supported portable API version",
    );
  }
  const kind = stringValue(body.kind);
  if (!kind || !isResourceShapeKind(kind)) return failed(c, "kind is invalid");
  const pathKind = c.req.param("kind");
  if (pathKind && pathKind !== kind)
    return failed(c, "path kind does not match body kind");
  if (!isInstalledFormReference(body.form)) {
    return failed(c, "form must be an exact InstalledFormReference");
  }
  if (body.form.formRef.kind !== kind)
    return failed(c, "form kind does not match resource kind");
  if (!isJsonObject(body.metadata)) return failed(c, "metadata is required");
  const metadata = body.metadata;
  const name = stringValue(metadata.name);
  const space = stringValue(metadata.space);
  if (!name || !space)
    return failed(c, "metadata.name and metadata.space are required");
  if (c.req.param("name") && c.req.param("name") !== name) {
    return failed(c, "path name does not match metadata.name");
  }
  if ("managedBy" in metadata)
    return failed(c, "metadata.managedBy is host-owned");
  if (!isJsonObject(body.spec)) return failed(c, "spec must be an object");
  const labels = stringMap(metadata.labels);
  if ("labels" in metadata && labels === undefined) {
    return failed(
      c,
      "metadata.labels must be an object whose values are strings",
    );
  }
  const generation = generationPrecondition(c, requireWritePrecondition);
  if (!generation.ok) return generation;
  return {
    ok: true,
    body: body as JsonObject,
    request: {
      actor,
      space,
      kind,
      form: body.form,
      name,
      spec: body.spec,
      managedBy: PORTABLE_FORM_MANAGER,
      expectedGeneration: generation.value,
      project: stringValue(metadata.project),
      environment: stringValue(metadata.environment),
      labels,
    },
  };
}

function generationPrecondition(
  c: Context,
  required: boolean,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly response: Response } {
  const create = c.req.header("if-none-match")?.trim();
  const update = c.req.header("if-match")?.trim();
  if (create && update)
    return failed(c, "If-Match and If-None-Match are mutually exclusive");
  if (create !== undefined) {
    if (create !== "*") return failed(c, "If-None-Match supports only '*'");
    return { ok: true, value: 0 };
  }
  if (update !== undefined) {
    const match = /^"([1-9][0-9]*)"$/u.exec(update);
    if (!match)
      return failed(c, "If-Match must contain one quoted resourceVersion");
    return { ok: true, value: Number(match[1]) };
  }
  return required
    ? failed(c, "If-None-Match: * or If-Match is required")
    : { ok: true, value: undefined };
}

async function exactStoredResource(
  c: Context,
  service: ResourceShapeService,
  requireMatch: boolean,
  allowAbsent?: false,
): Promise<
  | { readonly ok: true; readonly value: ResourceObject }
  | { readonly ok: false; readonly response: Response }
>;
async function exactStoredResource(
  c: Context,
  service: ResourceShapeService,
  requireMatch: boolean,
  allowAbsent: true,
): Promise<
  | { readonly ok: true; readonly value: ResourceObject | undefined }
  | { readonly ok: false; readonly response: Response }
>;
async function exactStoredResource(
  c: Context,
  service: ResourceShapeService,
  requireMatch: boolean,
  allowAbsent = false,
): Promise<
  | { readonly ok: true; readonly value: ResourceObject | undefined }
  | { readonly ok: false; readonly response: Response }
> {
  const expected = ifMatchPrecondition(c, requireMatch);
  if (!expected.ok) return expected;
  const space = requiredQuery(c, "space");
  if (!space.ok) return space;
  const identity = formIdentityFromQuery(c, true);
  if (!identity.ok) return identity;
  const kind = c.req.param("kind");
  if (!isResourceShapeKind(kind) || identity.value.formRef.kind !== kind) {
    return failed(c, "path kind does not match the exact form identity");
  }
  const name = c.req.param("name");
  if (!name) return failed(c, "resource name is required");
  const result = await service.get(space.value, kind, name);
  if (!result.ok) {
    if (allowAbsent && result.error.code === "not_found")
      return { ok: true, value: undefined };
    return { ok: false, response: serviceError(c, result.error) };
  }
  if (
    !result.value.form ||
    installedFormReferenceKey(result.value.form) !==
      installedFormReferenceKey(identity.value)
  ) {
    return {
      ok: false,
      response: portableError(
        c,
        "form_identity_conflict",
        "resource is pinned to a different exact form identity",
        409,
      ),
    };
  }
  if (
    expected.value !== undefined &&
    result.value.metadata.generation !== expected.value
  ) {
    return {
      ok: false,
      response: portableError(
        c,
        "resource_version_conflict",
        "resourceVersion precondition failed",
        412,
      ),
    };
  }
  return { ok: true, value: result.value };
}

function ifMatchPrecondition(
  c: Context,
  required: boolean,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly response: Response } {
  if (c.req.header("if-none-match") !== undefined) {
    return failed(c, "If-None-Match is not valid for an existing Resource");
  }
  const value = c.req.header("if-match")?.trim();
  if (value === undefined) {
    return required
      ? failed(c, "If-Match is required")
      : { ok: true, value: undefined };
  }
  const match = /^"([1-9][0-9]*)"$/u.exec(value);
  return match
    ? { ok: true, value: Number(match[1]) }
    : failed(c, "If-Match must contain one quoted resourceVersion");
}

function formIdentityFromQuery(
  c: Context,
  required: true,
):
  | { readonly ok: true; readonly value: InstalledFormReference }
  | { readonly ok: false; readonly response: Response };
function formIdentityFromQuery(
  c: Context,
  required: false,
):
  | { readonly ok: true; readonly value: InstalledFormReference | undefined }
  | { readonly ok: false; readonly response: Response };
function formIdentityFromQuery(c: Context, required: boolean) {
  const values = {
    apiVersion: c.req.query("apiVersion"),
    kind: c.req.query("kind"),
    definitionVersion: c.req.query("definitionVersion"),
    schemaDigest: c.req.query("schemaDigest"),
    packageDigest: c.req.query("packageDigest"),
  };
  if (!Object.values(values).some(Boolean) && !required)
    return { ok: true, value: undefined };
  if (!Object.values(values).every(Boolean))
    return failed(c, "the complete exact FormRef query is required");
  const identity = {
    formRef: {
      apiVersion: values.apiVersion,
      kind: values.kind,
      definitionVersion: values.definitionVersion,
      schemaDigest: values.schemaDigest,
    },
    packageDigest: values.packageDigest,
  };
  return isInstalledFormReference(identity)
    ? { ok: true, value: identity }
    : failed(c, "the exact FormRef query is invalid");
}

async function requireAvailableForm(
  c: Context,
  options: RegisterPortableFormHostRoutesOptions,
  actor: ActorContext,
  request: ApplyResourceRequest,
  operation: "create" | "update" | "import",
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly response: Response }
> {
  const result = await options.availability.listFormAvailability({
    actor,
    space: request.space,
    identity: request.form!,
    page: { limit: 1 },
  });
  const expected = installedFormReferenceKey(request.form!);
  const found = result.items.find(
    (item) => installedFormReferenceKey(item.identity) === expected,
  );
  if (!found)
    return {
      ok: false,
      response: portableError(
        c,
        "form_unknown",
        "exact form identity is unknown",
        404,
      ),
    };
  if (!found.definitionKnown) {
    return {
      ok: false,
      response: portableError(
        c,
        "form_unknown",
        "exact form identity is unknown",
        404,
      ),
    };
  }
  if (!found.installed)
    return {
      ok: false,
      response: portableError(
        c,
        "form_not_installed",
        "exact form package is not installed",
        409,
      ),
    };
  if (!found.executable || !found.activated)
    return {
      ok: false,
      response: portableError(
        c,
        "form_unavailable",
        "exact form is not executable on this host",
        409,
      ),
    };
  if (!found.availableToPrincipal)
    return {
      ok: false,
      response: portableError(
        c,
        "permission_denied",
        "principal is not allowed to use this exact form",
        403,
      ),
    };
  if (!found.operations.includes(operation))
    return {
      ok: false,
      response: portableError(
        c,
        "form_unavailable",
        `exact form does not support ${operation}`,
        409,
      ),
    };
  return { ok: true };
}

async function desiredWriteOperation(
  service: ResourceShapeService,
  request: ApplyResourceRequest,
): Promise<"create" | "update"> {
  const current = await service.get(request.space, request.kind, request.name);
  return current.ok ? "update" : "create";
}

function portableResource(resource: ResourceObject): TakoformResource {
  if (!resource.form)
    throw new TypeError("portable Resource must carry an exact form identity");
  return {
    apiVersion: TAKOFORM_FORM_HOST_API_VERSION,
    kind: resource.kind,
    form: resource.form,
    metadata: {
      name: resource.metadata.name,
      space: resource.metadata.space,
      project: resource.metadata.project,
      environment: resource.metadata.environment,
      labels: resource.metadata.labels,
      resourceVersion: String(resource.metadata.generation ?? 0),
    },
    spec: resource.spec,
    ...(resource.status
      ? {
          status: {
            phase: resource.status.phase,
            observedGeneration: resource.status.observedGeneration,
            portability: resource.status.resolution?.portability,
            // Canonical Outputs may contain provider/private implementation
            // evidence. Portable public values are exposed through audited
            // Form Interfaces, not copied wholesale from the host ledger.
            conditions: resource.status.conditions,
          },
        }
      : {}),
    id: formatResourceShapeId(
      resource.metadata.space,
      resource.kind,
      resource.metadata.name,
    ),
  };
}

async function completedApplyReplay(
  service: ResourceShapeService,
  request: ApplyResourceRequest,
): Promise<ResourceObject | undefined> {
  if (request.expectedGeneration === undefined) return undefined;
  const current = await service.get(request.space, request.kind, request.name);
  if (!current.ok) return undefined;
  if (current.value.metadata.generation === request.expectedGeneration) {
    return undefined;
  }
  if (
    current.value.status?.phase !== "Ready" ||
    current.value.status.observedGeneration !==
      current.value.metadata.generation ||
    current.value.metadata.managedBy !== PORTABLE_FORM_MANAGER ||
    !current.value.form ||
    !request.form ||
    installedFormReferenceKey(current.value.form) !==
      installedFormReferenceKey(request.form) ||
    current.value.metadata.project !== request.project ||
    current.value.metadata.environment !== request.environment ||
    canonicalJson(current.value.metadata.labels ?? null) !==
      canonicalJson(request.labels ?? null) ||
    canonicalJson(current.value.spec) !== canonicalJson(request.spec)
  ) {
    return undefined;
  }
  return current.value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function serviceError(c: Context, error: ResourceServiceError): Response {
  const mapping: Record<
    string,
    readonly [TakoformHostErrorCode, number, boolean]
  > = {
    invalid_form_ref: ["invalid_argument", 400, false],
    form_registry_unavailable: ["backend_unavailable", 503, true],
    form_not_installed: ["form_not_installed", 409, false],
    form_identity_conflict: ["form_identity_conflict", 409, false],
    not_found: ["resource_not_found", 404, false],
    resource_version_conflict: ["resource_version_conflict", 412, false],
    ownership_conflict: ["resource_busy", 409, false],
    reconcile_conflict: ["resource_busy", 409, true],
    import_conflict: ["import_conflict", 409, false],
    policy_denied: ["policy_denied", 403, false],
    deployment_admission_denied: ["policy_denied", 403, false],
    deployment_finalize_pending: ["resource_busy", 409, true],
  };
  const mapped =
    mapping[error.code] ??
    (error.code.startsWith("invalid_")
      ? (["invalid_argument", 400, false] as const)
      : (["backend_unavailable", 503, true] as const));
  return portableError(
    c,
    mapped[0],
    "portable form operation was rejected",
    mapped[1],
    mapped[2],
    error.code,
  );
}

function portableError(
  c: Context,
  code: TakoformHostErrorCode,
  message: string,
  status: number,
  retryable = false,
  hostCode?: string,
): Response {
  return c.json(
    {
      error: {
        code,
        message,
        requestId: requestIdFromContext(c),
        retryable,
        ...(hostCode ? { hostCode } : {}),
      },
    },
    status as 400,
  );
}

function portableAuthError(c: Context, response: Response): Response {
  return portableError(
    c,
    response.status === 403 ? "permission_denied" : "unauthenticated",
    "portable form authentication failed",
    response.status === 403 ? 403 : 401,
  );
}

function portableJson(
  c: Context,
  value: unknown,
  status: 200,
  key?: string,
): Response {
  const resource =
    isJsonObject(value) && isJsonObject(value.resource)
      ? (value.resource as unknown as TakoformResource)
      : (value as TakoformResource);
  if (resource.metadata?.resourceVersion)
    c.header("etag", `"${resource.metadata.resourceVersion}"`);
  if (key) c.header("idempotency-key", key);
  return c.json(value, status);
}

function idempotencyKey(
  c: Context,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly response: Response } {
  const key = c.req.header("idempotency-key")?.trim();
  return key && IDEMPOTENCY_KEY_RE.test(key)
    ? { ok: true, value: key }
    : failed(c, "Idempotency-Key must be 8-128 portable characters");
}

function withIdempotencyRequest(
  actor: ActorContext,
  key: string,
): ActorContext {
  return { ...actor, requestId: `${actor.requestId}:${key}`.slice(0, 256) };
}

function reviewFromBody(
  c: Context,
  body: JsonObject,
):
  | { readonly ok: true; readonly value: { readonly planDigest: string } }
  | { readonly ok: false; readonly response: Response } {
  if (!isJsonObject(body.review) || !stringValue(body.review.planDigest)) {
    return failed(c, "review.planDigest from preview is required");
  }
  return { ok: true, value: { planDigest: body.review.planDigest as string } };
}

function requiredQuery(c: Context, key: string) {
  const value = c.req.query(key);
  return value
    ? { ok: true as const, value }
    : failed(c, `${key} query is required`);
}

function declarationQuery(c: Context):
  | {
      readonly ok: true;
      readonly value: {
        readonly space: string;
        readonly name?: string;
        readonly version?: string;
        readonly resourceKind?: string;
        readonly resourceName?: string;
      };
    }
  | { readonly ok: false; readonly response: Response } {
  const space = requiredQuery(c, "space");
  if (!space.ok) return space;
  const name = c.req.query("name")?.trim() || undefined;
  const version = c.req.query("version")?.trim() || undefined;
  const resourceKind = c.req.query("resourceKind")?.trim() || undefined;
  const resourceName = c.req.query("resourceName")?.trim() || undefined;
  if ((resourceKind === undefined) !== (resourceName === undefined)) {
    return failed(c, "resourceKind and resourceName must be provided together");
  }
  return {
    ok: true,
    value: {
      space: space.value,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(resourceKind && resourceName ? { resourceKind, resourceName } : {}),
    },
  };
}

async function readPortableDeclarations(
  c: Context,
  reader: PortableInterfaceDeclarationReader,
  input: Parameters<
    PortableInterfaceDeclarationReader["listDeclaredInterfaces"]
  >[0],
): Promise<
  | { readonly ok: true; readonly value: readonly TakoformDeclaredInterface[] }
  | { readonly ok: false; readonly response: Response }
> {
  try {
    return { ok: true, value: await reader.listDeclaredInterfaces(input) };
  } catch (error) {
    if (!(error instanceof PortableDeclarationReadLimitError)) throw error;
    return {
      ok: false,
      response: portableError(c, "invalid_argument", error.message, 400),
    };
  }
}

function pageQuery(c: Context) {
  const parsed = parsePageQuery(c.req.query("limit"), c.req.query("cursor"));
  return parsed.ok
    ? { ok: true as const, value: parsed.value }
    : failed(c, parsed.message);
}

function failed(c: Context, message: string) {
  return {
    ok: false as const,
    response: portableError(c, "invalid_argument", message, 400),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isJsonObject(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? (Object.fromEntries(entries) as Readonly<Record<string, string>>)
    : undefined;
}
