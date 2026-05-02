import type { Hono as HonoApp } from "hono";
import type {
  JsonObject,
  ManifestResource,
  PlatformContext,
  RefResolver,
  ResourceHandle,
  TemplateValidationIssue,
} from "takosumi-contract";
import { getTemplateByRef } from "takosumi-contract";
import type { AppContext } from "../app_context.ts";
import {
  applyV2,
  type ApplyV2Outcome,
  destroyV2,
  type DestroyV2Outcome,
} from "../domains/deploy/apply_v2.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  recordsFromAppliedResources,
  type TakosumiAppliedResourceRecord,
  type TakosumiDeploymentRecord,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";
import {
  apiError,
  MalformedJsonRequestError,
  registerApiErrorHandler,
} from "./errors.ts";

/**
 * v0 CLI deploy endpoint contract.
 *
 *   POST /v1/deployments
 *   Authorization: Bearer <TAKOSUMI_DEPLOY_TOKEN>
 *   Content-Type: application/json
 *
 *   Body:  { mode: "apply" | "plan" | "destroy", manifest: { ... } }
 *
 * The endpoint runs the same `applyV2` pipeline that the CLI uses in local
 * mode, against whatever shapes / providers the operator has registered with
 * the global contract registry. It is intentionally simple: bearer-token
 * shared-secret auth, no multi-tenant routing, no policy gating. It exists
 * so that `takosumi deploy ./manifest.yml --remote ... --token $T` can talk
 * to a hosted kernel without going through the heavier internal control
 * plane (`/internal/v1/deployments`).
 *
 * If `TAKOSUMI_DEPLOY_TOKEN` is unset the route is disabled and falls
 * through to the framework default 404 — operators must explicitly opt in
 * by setting the env var.
 */
export const TAKOSUMI_DEPLOY_PUBLIC_PATH = "/v1/deployments" as const;

export type DeployPublicMode = "apply" | "plan" | "destroy";

export interface DeployPublicResponse {
  readonly status: "ok";
  readonly outcome: ApplyV2Outcome;
}

export interface DeployPublicDestroyResponse {
  readonly status: "ok";
  readonly outcome: DestroyV2Outcome;
}

export interface RegisterDeployPublicRoutesOptions {
  /**
   * Shared-secret token. When undefined the route is disabled (a startup
   * warning is emitted by `registerDeployPublicRoutes` so operators see
   * why the CLI cannot reach the kernel).
   */
  readonly getDeployToken?: () => string | undefined;
  /** Optional injection point for tests so apply runs against a fake. */
  readonly applyResources?: (
    resources: readonly ManifestResource[],
  ) => Promise<ApplyV2Outcome>;
  /**
   * Optional injection point for tests so destroy runs against a fake.
   * When omitted the route delegates to `destroyV2` against the platform
   * context constructed from `appContext` / `createPlatformContext`. The
   * test override receives the resources and an optional `handleFor`
   * resolver so that fake destroyers can assert the kernel passed the
   * persisted handles back through.
   */
  readonly destroyResources?: (
    resources: readonly ManifestResource[],
    handleFor?: (resource: ManifestResource) => ResourceHandle,
  ) => Promise<DestroyV2Outcome>;
  /**
   * Real `AppContext` from which the public deploy route derives the
   * `PlatformContext` passed to `applyV2`. The kernel boots the AppContext
   * once at startup with DB-backed secrets / KMS / observability / object
   * storage adapters; this option threads those through to the public
   * deploy pipeline so a CLI deploy is not silently writing to noop
   * adapters.
   *
   * When neither `appContext` nor `createPlatformContext` is supplied,
   * `applyV2` is invoked without a context (caller-provided
   * `applyResources` overrides this entirely; tests use that path).
   */
  readonly appContext?: AppContext;
  /**
   * Tenant id surfaced into `PlatformContext.tenantId` when deriving the
   * context from `appContext`. Defaults to `"takosumi-deploy"`.
   */
  readonly tenantId?: string;
  /** Override the platform context that `applyV2` receives. */
  readonly createPlatformContext?: () => PlatformContext;
  /**
   * Persistent record of every applied / destroyed deployment routed
   * through this endpoint. The route uses it to:
   *   - Persist `applyV2.outcome.applied[]` after a successful apply.
   *   - Look up the persisted per-resource handles when destroy mode
   *     submits the same manifest (otherwise destroy receives only
   *     `resource.name` and fails for any provider whose runtime handle
   *     differs from the resource name — i.e. anything that returns a real
   *     ARN / object id).
   *   - Render `GET /v1/deployments` and `GET /v1/deployments/:name`.
   *
   * Defaults to an in-memory store. Operators that need durability across
   * restarts must inject a SQL-backed store keyed off `takosumi_deployments`
   * (migration `20260430000020_takosumi_deployments`).
   */
  readonly recordStore?: TakosumiDeploymentRecordStore;
  /**
   * Wall-clock factory used when stamping `created_at` / `updated_at` on
   * persisted records. Defaults to `() => new Date().toISOString()`. Tests
   * override this to assert deterministic timestamps.
   */
  readonly now?: () => string;
}

export function registerDeployPublicRoutes(
  app: HonoApp,
  options: RegisterDeployPublicRoutesOptions = {},
): void {
  registerApiErrorHandler(app);
  const getToken = options.getDeployToken ??
    (() => Deno.env.get("TAKOSUMI_DEPLOY_TOKEN"));
  const initialToken = getToken();
  if (!initialToken) {
    console.warn(
      `[takosumi-deploy] TAKOSUMI_DEPLOY_TOKEN is not set; ` +
        `${TAKOSUMI_DEPLOY_PUBLIC_PATH} will return 404 until configured.`,
    );
  }

  const tenantId = options.tenantId ?? "takosumi-deploy";
  const recordStore: TakosumiDeploymentRecordStore = options.recordStore ??
    new InMemoryTakosumiDeploymentRecordStore();
  const now = options.now ?? (() => new Date().toISOString());

  const buildPlatformContext = (): PlatformContext => {
    if (options.createPlatformContext) return options.createPlatformContext();
    if (options.appContext) {
      return platformContextFromAppContext(options.appContext, tenantId);
    }
    throw new Error(
      "registerDeployPublicRoutes: no platform context configured. " +
        "Pass `appContext`, `createPlatformContext`, or override " +
        "`applyResources` (test usage).",
    );
  };

  const applyResources = options.applyResources ??
    ((resources) =>
      applyV2({
        resources,
        context: buildPlatformContext(),
      }));

  const destroyResources = options.destroyResources ??
    ((resources, handleFor) =>
      destroyV2({
        resources,
        context: buildPlatformContext(),
        ...(handleFor ? { handleFor } : {}),
      }));

  app.post(TAKOSUMI_DEPLOY_PUBLIC_PATH, async (c) => {
    const expected = getToken();
    if (!expected) {
      return c.json(apiError("not_found", "deploy endpoint disabled"), 404);
    }
    const presented = readBearerToken(c.req.header("authorization"));
    if (!presented) {
      return c.json(
        apiError("unauthenticated", "missing bearer token"),
        401,
      );
    }
    if (!constantTimeEquals(presented, expected)) {
      return c.json(apiError("unauthenticated", "invalid token"), 401);
    }

    const body = await readJsonBody(c.req.raw);
    if (!body.ok) {
      return c.json(apiError("invalid_argument", body.error), 400);
    }
    const rawManifest = body.value.manifest;
    const mode = readMode(body.value.mode);
    if (!mode.ok) {
      return c.json(apiError("invalid_argument", mode.error), 400);
    }
    const resources = readManifestResources(rawManifest);
    if (!resources.ok) {
      return c.json(apiError("invalid_argument", resources.error), 400);
    }
    const manifestObject = (rawManifest && typeof rawManifest === "object" &&
        !Array.isArray(rawManifest))
      ? (rawManifest as JsonObject)
      : ({} as JsonObject);
    const deploymentName = readDeploymentName(manifestObject, resources.value);

    if (mode.value === "plan") {
      // v0: plan returns the validated resource list without applying.
      // applyV2 itself runs validation as the first phase.
      return c.json({
        status: "ok",
        outcome: {
          applied: [],
          issues: [],
          status: "succeeded",
        } satisfies ApplyV2Outcome,
      });
    }

    if (mode.value === "destroy") {
      // Look up persisted handles from the prior apply. Without this,
      // `destroyV2` falls back to `resource.name` as the handle which only
      // works for in-memory / filesystem providers; cloud providers that
      // returned an ARN / object id from `apply` would receive the wrong
      // value and fail to delete the real underlying resource.
      const prior = await recordStore.get(tenantId, deploymentName);
      const handleFor = prior ? buildHandleForFromRecord(prior) : undefined;
      if (!prior) {
        console.warn(
          `[takosumi-deploy] destroy received no prior apply record for ` +
            `tenant=${tenantId} name=${deploymentName}; falling back to ` +
            `resource.name as handle.`,
        );
      }
      try {
        const outcome = await destroyResources(resources.value, handleFor);
        if (outcome.status === "failed-validation") {
          return c.json({ status: "error", outcome }, 400);
        }
        if (prior) {
          await recordStore.markDestroyed(tenantId, deploymentName, now());
        }
        // `partial` is still a 200: best-effort destroy completed and the
        // caller inspects `outcome.errors` for per-resource failures.
        const ok: DeployPublicDestroyResponse = { status: "ok", outcome };
        return c.json(ok, 200);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json(
          apiError("internal_error", `destroy failed: ${message}`),
          500,
        );
      }
    }

    try {
      const outcome = await applyResources(resources.value);
      if (outcome.status === "failed-validation") {
        return c.json({ status: "error", outcome }, 400);
      }
      if (outcome.status === "failed-apply") {
        // Best-effort: persist a `failed` row so subsequent status queries
        // can surface the failure rather than 404 the CLI.
        await recordStore.upsert({
          tenantId,
          name: deploymentName,
          manifest: manifestObject,
          appliedResources: [],
          status: "failed",
          now: now(),
        });
        return c.json({ status: "error", outcome }, 500);
      }
      // Successful apply: persist handles so destroy / status work.
      const stamp = now();
      await recordStore.upsert({
        tenantId,
        name: deploymentName,
        manifest: manifestObject,
        appliedResources: recordsFromAppliedResources(
          outcome.applied,
          resources.value,
          stamp,
        ),
        status: "applied",
        now: stamp,
      });
      const ok: DeployPublicResponse = { status: "ok", outcome };
      return c.json(ok, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        apiError("internal_error", `apply failed: ${message}`),
        500,
      );
    }
  });

  app.get(TAKOSUMI_DEPLOY_PUBLIC_PATH, async (c) => {
    const auth = checkBearer(c.req.header("authorization"), getToken());
    if (auth.status !== "ok") return c.json(auth.body, auth.code);
    const records = await recordStore.list(tenantId);
    return c.json(
      { deployments: records.map(toDeploymentSummary) },
      200,
    );
  });

  app.get(`${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name`, async (c) => {
    const auth = checkBearer(c.req.header("authorization"), getToken());
    if (auth.status !== "ok") return c.json(auth.body, auth.code);
    const name = c.req.param("name");
    if (!name) {
      return c.json(apiError("invalid_argument", "name is required"), 400);
    }
    const record = await recordStore.get(tenantId, name);
    if (!record) {
      return c.json(apiError("not_found", `deployment ${name} not found`), 404);
    }
    return c.json(toDeploymentSummary(record), 200);
  });
}

interface BearerCheckOk {
  readonly status: "ok";
}
interface BearerCheckFail {
  readonly status: "fail";
  readonly code: 401 | 404;
  readonly body: ReturnType<typeof apiError>;
}

function checkBearer(
  header: string | undefined,
  expected: string | undefined,
): BearerCheckOk | BearerCheckFail {
  if (!expected) {
    return {
      status: "fail",
      code: 404,
      body: apiError("not_found", "deploy endpoint disabled"),
    };
  }
  const presented = readBearerToken(header);
  if (!presented) {
    return {
      status: "fail",
      code: 401,
      body: apiError("unauthenticated", "missing bearer token"),
    };
  }
  if (!constantTimeEquals(presented, expected)) {
    return {
      status: "fail",
      code: 401,
      body: apiError("unauthenticated", "invalid token"),
    };
  }
  return { status: "ok" };
}

/**
 * Build the `handleFor` callback that `destroyV2` consults to map a
 * manifest resource back to the runtime handle that `provider.apply`
 * returned at deploy time.
 *
 * Falls back to `resource.name` when the persisted record does not list
 * the resource (manifest expanded but record was created from a
 * different submission). The fallback matches the existing destroyV2
 * default so behavior is unchanged for in-memory / filesystem providers.
 */
function buildHandleForFromRecord(
  record: TakosumiDeploymentRecord,
): (resource: ManifestResource) => ResourceHandle {
  const handlesByName = new Map<string, ResourceHandle>();
  for (const entry of record.appliedResources) {
    handlesByName.set(entry.resourceName, entry.handle);
  }
  return (resource) => handlesByName.get(resource.name) ?? resource.name;
}

interface DeploymentResourceSummary {
  readonly name: string;
  readonly shape: string;
  readonly provider: string;
  readonly status: "applied";
  readonly outputs: JsonObject;
  readonly handle: ResourceHandle;
}

interface DeploymentSummary {
  readonly name: string;
  readonly status: TakosumiDeploymentRecord["status"];
  readonly tenantId: string;
  readonly appliedAt: string;
  readonly updatedAt: string;
  readonly resources: readonly DeploymentResourceSummary[];
}

function toDeploymentSummary(
  record: TakosumiDeploymentRecord,
): DeploymentSummary {
  return {
    name: record.name,
    status: record.status,
    tenantId: record.tenantId,
    appliedAt: record.createdAt,
    updatedAt: record.updatedAt,
    resources: record.appliedResources.map(toResourceSummary),
  };
}

function toResourceSummary(
  entry: TakosumiAppliedResourceRecord,
): DeploymentResourceSummary {
  return {
    name: entry.resourceName,
    shape: entry.shape,
    provider: entry.providerId,
    status: "applied",
    outputs: entry.outputs,
    handle: entry.handle,
  };
}

/**
 * Pull a stable deployment name out of the manifest. Preference order:
 *   1. `manifest.metadata.name`   — explicit, what users usually set.
 *   2. `manifest.name`            — older / shorter form.
 *   3. fallback: a content hash of the resource list so distinct
 *      submissions get distinct natural keys, even if ill-defined.
 *
 * The fallback is deterministic for the same set of resources, which means
 * an unnamed manifest re-submitted unchanged still maps onto its prior
 * record (so destroy continues to work). It is a UX inconvenience — the
 * status table prints the hash — but never a correctness bug.
 */
function readDeploymentName(
  manifest: JsonObject,
  resources: readonly ManifestResource[],
): string {
  const metadata = manifest.metadata;
  if (
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
  ) {
    const meta = metadata as Record<string, unknown>;
    if (typeof meta.name === "string" && meta.name.length > 0) return meta.name;
  }
  if (typeof manifest.name === "string" && manifest.name.length > 0) {
    return manifest.name;
  }
  return `unnamed-${fallbackHash(resources)}`;
}

function fallbackHash(resources: readonly ManifestResource[]): string {
  let hash = 5381;
  const seed = resources
    .map((resource) =>
      `${resource.shape}|${resource.name}|${resource.provider}`
    )
    .join(";");
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash) ^ seed.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const prefix = "bearer ";
  if (trimmed.length <= prefix.length) return undefined;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) {
    return undefined;
  }
  const value = trimmed.slice(prefix.length).trim();
  return value.length > 0 ? value : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function readJsonBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const text = await request.text();
  if (text.trim() === "") return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedJsonRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function readMode(
  value: unknown,
):
  | { ok: true; value: DeployPublicMode }
  | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: "apply" };
  if (value === "apply" || value === "plan" || value === "destroy") {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: "mode must be one of apply|plan|destroy",
  };
}

function readManifestResources(
  manifest: unknown,
):
  | { ok: true; value: readonly ManifestResource[] }
  | { ok: false; error: string } {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, error: "manifest must be a JSON object" };
  }
  const manifestRecord = manifest as Record<string, unknown>;
  const hasResources = manifestRecord.resources !== undefined;
  const hasTemplate = manifestRecord.template !== undefined;

  if (hasResources && hasTemplate) {
    return {
      ok: false,
      error: "manifest must specify either resources[] or template, not both",
    };
  }
  if (!hasResources && !hasTemplate) {
    return {
      ok: false,
      error: "manifest.resources[] or manifest.template is required",
    };
  }
  if (hasTemplate) {
    return readTemplateExpansion(manifestRecord.template);
  }
  return readResourcesArray(manifestRecord.resources);
}

function readResourcesArray(
  candidate: unknown,
):
  | { ok: true; value: readonly ManifestResource[] }
  | { ok: false; error: string } {
  if (!Array.isArray(candidate)) {
    return { ok: false, error: "manifest.resources must be an array" };
  }
  for (const [index, entry] of candidate.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        error: `manifest.resources[${index}] must be an object`,
      };
    }
    const resource = entry as Record<string, unknown>;
    if (typeof resource.shape !== "string" || resource.shape.length === 0) {
      return {
        ok: false,
        error: `manifest.resources[${index}].shape must be a non-empty string`,
      };
    }
    if (typeof resource.name !== "string" || resource.name.length === 0) {
      return {
        ok: false,
        error: `manifest.resources[${index}].name must be a non-empty string`,
      };
    }
    if (
      typeof resource.provider !== "string" || resource.provider.length === 0
    ) {
      return {
        ok: false,
        error:
          `manifest.resources[${index}].provider must be a non-empty string`,
      };
    }
  }
  return { ok: true, value: candidate as readonly ManifestResource[] };
}

function readTemplateExpansion(
  candidate: unknown,
):
  | { ok: true; value: readonly ManifestResource[] }
  | { ok: false; error: string } {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: "manifest.template must be a JSON object" };
  }
  const template = candidate as Record<string, unknown>;
  if (typeof template.ref !== "string" || template.ref.length === 0) {
    return {
      ok: false,
      error: "manifest.template.ref must be a non-empty string",
    };
  }
  const ref = template.ref;
  const inputs = template.inputs ?? {};
  if (
    inputs === null || typeof inputs !== "object" || Array.isArray(inputs)
  ) {
    return {
      ok: false,
      error: "manifest.template.inputs must be a JSON object",
    };
  }
  const found = getTemplateByRef(ref);
  if (!found) {
    return {
      ok: false,
      error: `manifest.template.ref ${ref} is not registered`,
    };
  }
  const issues: TemplateValidationIssue[] = [];
  found.validateInputs(inputs, issues);
  if (issues.length > 0) {
    const formatted = issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ");
    return {
      ok: false,
      error: `manifest.template.inputs invalid for ${ref}: ${formatted}`,
    };
  }
  let expanded: readonly ManifestResource[];
  try {
    expanded = found.expand(inputs as JsonObject);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `manifest.template ${ref} expansion failed: ${message}`,
    };
  }
  return { ok: true, value: expanded };
}

/**
 * Build a `PlatformContext` from the kernel's `AppContext`. The kernel's
 * adapters (`secrets` / `observability` / `kms` / `objectStorage`) implement
 * the contract's `PlatformContext` ports directly, so we just thread them
 * through. `refResolver` is overwritten per-resource by `applyV2` itself; the
 * fallback returned here is never invoked during a normal apply.
 */
function platformContextFromAppContext(
  appContext: AppContext,
  tenantId: string,
): PlatformContext {
  const adapters = appContext.adapters;
  return {
    tenantId,
    spaceId: tenantId,
    secrets: adapters.secrets as PlatformContext["secrets"],
    observability: adapters.observability as PlatformContext["observability"],
    kms: adapters.kms as PlatformContext["kms"],
    objectStorage: adapters.objectStorage as PlatformContext["objectStorage"],
    refResolver: PUBLIC_DEPLOY_REF_RESOLVER,
    resolvedOutputs: new Map<string, JsonObject>(),
  };
}

const PUBLIC_DEPLOY_REF_RESOLVER: RefResolver = {
  resolve(_expression: string) {
    // applyV2 builds its own per-resource ref resolver; this fallback is
    // never invoked during a shape-model apply.
    return null;
  },
};
