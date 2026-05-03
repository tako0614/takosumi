import type { Context, Hono as HonoApp } from "hono";
import {
  signGatewayResponse,
  TAKOSUMI_GATEWAY_IDENTITY_NONCE_HEADER,
  TAKOSUMI_GATEWAY_IDENTITY_REQUEST_ID_HEADER,
  TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_HEADER,
  TAKOSUMI_GATEWAY_IDENTITY_TIMESTAMP_HEADER,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  type TakosumiActorContext,
} from "takosumi-contract";
import type {
  GatewayManifestIssuer,
  RegisterRuntimeAgentInput,
  RuntimeAgentHeartbeatInput,
  RuntimeAgentRegistry,
} from "../agents/types.ts";
import type { MutationBoundaryOperation } from "../services/entitlements/mod.ts";
import type { WorkerAuthzService } from "../services/security/mod.ts";
import { DomainError } from "../shared/errors.ts";
import { apiError, readJsonObject, registerApiErrorHandler } from "./errors.ts";
import { readInternalAuth } from "./internal_auth.ts";
import type { MutationBoundaryEntitlementService } from "./internal_routes.ts";

export const TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS = {
  enroll: "/api/internal/v1/runtime/agents/enroll",
  heartbeat: "/api/internal/v1/runtime/agents/:agentId/heartbeat",
  lease: "/api/internal/v1/runtime/agents/:agentId/leases",
  report: "/api/internal/v1/runtime/agents/:agentId/reports",
  drain: "/api/internal/v1/runtime/agents/:agentId/drain",
  gatewayManifest: "/api/internal/v1/runtime/agents/:agentId/gateway-manifest",
} as const;

export type RuntimeAgentAuthResult =
  | {
    readonly ok: true;
    readonly actor?: {
      readonly actorAccountId: string;
      readonly spaceId?: string;
    } & Partial<TakosumiActorContext>;
    readonly workloadIdentityId?: string;
  }
  | { readonly ok: false; readonly status?: 401 | 403; readonly error: string };

export interface RegisterRuntimeAgentRoutesOptions {
  readonly registry: RuntimeAgentRegistry;
  /**
   * Explicit runtime-agent RPC auth hook. Tests may inject a test-only
   * authenticator; production callers should prefer signed internal auth.
   */
  readonly authenticate?: (
    request: Request,
  ) => Promise<RuntimeAgentAuthResult> | RuntimeAgentAuthResult;
  /** Convenience bridge for callers that already use internal signed auth. */
  readonly getInternalServiceSecret?: () => string | undefined;
  readonly security?: WorkerAuthzService;
  readonly entitlements?: MutationBoundaryEntitlementService;
  /**
   * Issuer the kernel uses to mint a signed gateway manifest for the
   * agent. When omitted the gateway-manifest route returns 501.
   */
  readonly gatewayManifestIssuer?: GatewayManifestIssuer;
  /**
   * Per-RPC gateway identity signer. When provided, the registered routes
   * sign every successful response with the kernel-trusted Ed25519 key so
   * the agent can verify the response really came from the trusted gateway.
   * When omitted, responses are emitted unsigned (pre-Phase-18 behaviour).
   */
  readonly gatewayResponseSigner?: GatewayResponseSigner;
}

export interface GatewayResponseSigner {
  /** Ed25519 private key used to sign gateway response identity headers. */
  readonly privateKey: CryptoKey;
  readonly clock?: () => Date;
}

export function registerRuntimeAgentRoutes(
  app: HonoApp,
  options: RegisterRuntimeAgentRoutesOptions,
): void {
  registerApiErrorHandler(app);
  const authenticate = options.authenticate ??
    createDefaultAuthenticator(options);
  const { registry } = options;
  const signer = options.gatewayResponseSigner;
  if (signer) {
    const clock = signer.clock ?? (() => new Date());
    // Wrap every runtime-agent response with the kernel-trusted Ed25519
    // identity signature so a malicious gateway URL cannot spoof responses.
    const wrap = async (
      c: Context,
      next: () => Promise<void>,
    ): Promise<void | Response> => {
      await next();
      const res = c.res;
      if (!res || res.status >= 400) return;
      const cloned = res.clone();
      const body = await cloned.text();
      const timestamp = clock().toISOString();
      const path = new URL(c.req.url).pathname;
      const requestId = c.req.header(TAKOSUMI_INTERNAL_REQUEST_ID_HEADER) ??
        crypto.randomUUID();
      const nonce = crypto.randomUUID();
      const sig = await signGatewayResponse({
        privateKey: signer.privateKey,
        method: c.req.method,
        path,
        body,
        timestamp,
        requestId,
        nonce,
      });
      const headers = new Headers(res.headers);
      headers.set(TAKOSUMI_GATEWAY_IDENTITY_SIGNATURE_HEADER, sig);
      headers.set(TAKOSUMI_GATEWAY_IDENTITY_TIMESTAMP_HEADER, timestamp);
      headers.set(TAKOSUMI_GATEWAY_IDENTITY_REQUEST_ID_HEADER, requestId);
      headers.set(TAKOSUMI_GATEWAY_IDENTITY_NONCE_HEADER, nonce);
      c.res = new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    };
    for (const path of Object.values(TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS)) {
      app.use(path, wrap);
    }
  }

  app.post(TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.enroll, async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return runtimeAgentAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const provider = optionalString(request.provider);
    if (!provider) {
      return c.json(apiError("invalid_argument", "provider is required"), 400);
    }
    const authorization = await authorizeRuntimeAgentMutation({
      auth,
      options,
      request,
      serviceGrantPermission: "runtime-agent.register",
      entitlementOperation: "runtime-agent.register",
    });
    if (!authorization.ok) {
      return c.json(authorization.body, authorization.status);
    }

    return await toJsonResponse(c, async () => {
      const agent = await registry.register({
        agentId: optionalString(request.agentId),
        provider,
        endpoint: optionalString(request.endpoint),
        capabilities: optionalCapabilities(request.capabilities),
        metadata: optionalRecord(request.metadata),
        heartbeatAt: optionalString(request.heartbeatAt) ??
          optionalString(request.enrolledAt),
        hostKeyDigest: optionalString(request.hostKeyDigest),
      });
      return c.json({ agent, renewAfterMs: 30_000 }, 201);
    });
  });

  app.post(TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.heartbeat, async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return runtimeAgentAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const subject = authorizeRuntimeAgentPathSubject({
      auth,
      agentId: c.req.param("agentId"),
    });
    if (!subject.ok) return c.json(subject.body, subject.status);
    const authorization = await authorizeRuntimeAgentMutation({
      auth,
      options,
      request,
      serviceGrantPermission: "runtime-agent.heartbeat",
    });
    if (!authorization.ok) {
      return c.json(authorization.body, authorization.status);
    }

    return await toJsonResponse(c, async () => {
      const input: RuntimeAgentHeartbeatInput = {
        agentId: c.req.param("agentId"),
        status: optionalHeartbeatStatus(request.status),
        metadata: optionalRecord(request.metadata),
      };
      const agent = await registry.heartbeat(input);
      return c.json({ agent });
    });
  });

  app.post(TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.lease, async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return runtimeAgentAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const subject = authorizeRuntimeAgentPathSubject({
      auth,
      agentId: c.req.param("agentId"),
    });
    if (!subject.ok) return c.json(subject.body, subject.status);
    const authorization = await authorizeRuntimeAgentMutation({
      auth,
      options,
      request,
      serviceGrantPermission: "runtime-agent.lease",
    });
    if (!authorization.ok) {
      return c.json(authorization.body, authorization.status);
    }

    return await toJsonResponse(c, async () => {
      const lease = await registry.leaseWork({
        agentId: c.req.param("agentId"),
        leaseTtlMs: optionalNumber(request.leaseTtlMs),
      });
      return c.json({ lease: lease ?? null });
    });
  });

  app.post(TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.report, async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return runtimeAgentAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const subject = authorizeRuntimeAgentPathSubject({
      auth,
      agentId: c.req.param("agentId"),
    });
    if (!subject.ok) return c.json(subject.body, subject.status);
    const leaseId = optionalString(request.leaseId);
    if (!leaseId) {
      return c.json(apiError("invalid_argument", "leaseId is required"), 400);
    }
    const authorization = await authorizeRuntimeAgentMutation({
      auth,
      options,
      request,
      serviceGrantPermission: "runtime-agent.report",
    });
    if (!authorization.ok) {
      return c.json(authorization.body, authorization.status);
    }

    return await toJsonResponse(c, async () => {
      const agentId = c.req.param("agentId");
      if (request.status === "completed") {
        const work = await registry.completeWork({
          agentId,
          leaseId,
          result: optionalRecord(request.result),
        });
        return c.json({ work });
      }
      if (request.status === "failed") {
        const work = await registry.failWork({
          agentId,
          leaseId,
          reason: optionalString(request.reason) ??
            "runtime agent reported failure",
          retry: optionalBoolean(request.retry),
          result: optionalRecord(request.result),
        });
        return c.json({ work });
      }
      if (request.status === "progress") {
        const work = await registry.reportProgress({
          agentId,
          leaseId,
          progress: optionalRecord(request.progress),
          extendUntil: optionalString(request.extendUntil),
        });
        return c.json({ work });
      }
      return c.json(
        apiError(
          "invalid_argument",
          "status must be progress, completed, or failed",
        ),
        400,
      );
    });
  });

  app.post(TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.drain, async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return runtimeAgentAuthError(c, auth);
    const request = await readJsonObject(c.req.raw);
    const authorization = await authorizeRuntimeAgentMutation({
      auth,
      options,
      request,
      serviceGrantPermission: "runtime-agent.drain",
      entitlementOperation: "runtime-agent.drain",
    });
    if (!authorization.ok) {
      return c.json(authorization.body, authorization.status);
    }
    const subject = authorizeRuntimeAgentPathSubject({
      auth,
      agentId: c.req.param("agentId"),
      allowServicePrincipal: true,
    });
    if (!subject.ok) return c.json(subject.body, subject.status);

    return await toJsonResponse(c, async () => {
      const agent = await registry.requestDrain(
        c.req.param("agentId"),
        optionalString(request.drainRequestedAt),
      );
      return c.json({ agent });
    });
  });

  app.post(TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.gatewayManifest, async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return runtimeAgentAuthError(c, auth);
    const issuer = options.gatewayManifestIssuer;
    if (!issuer) {
      return c.json(
        apiError(
          "not_implemented",
          "gateway manifest issuer not configured",
        ),
        501,
      );
    }
    const request = await readJsonObject(c.req.raw);
    const subject = authorizeRuntimeAgentPathSubject({
      auth,
      agentId: c.req.param("agentId"),
    });
    if (!subject.ok) return c.json(subject.body, subject.status);
    const gatewayUrl = optionalString(request.gatewayUrl);
    if (!gatewayUrl) {
      return c.json(
        apiError("invalid_argument", "gatewayUrl is required"),
        400,
      );
    }
    return await toJsonResponse(c, async () => {
      const signed = await issuer.issue({
        agentId: c.req.param("agentId"),
        gatewayUrl,
      });
      return c.json(signed);
    });
  });
}

function createDefaultAuthenticator(
  options: RegisterRuntimeAgentRoutesOptions,
): (request: Request) => Promise<RuntimeAgentAuthResult> {
  if (!options.getInternalServiceSecret) {
    return () =>
      Promise.resolve({
        ok: false,
        status: 401,
        error: "internal service secret missing",
      });
  }
  return async (request) => {
    const auth = await readInternalAuth(request, {
      secret: options.getInternalServiceSecret?.(),
    });
    if (!auth.ok) return auth;
    return {
      ok: true,
      actor: auth.actor,
      workloadIdentityId: auth.workloadIdentityId,
    };
  };
}

interface AuthorizeRuntimeAgentMutationInput {
  readonly auth: Extract<RuntimeAgentAuthResult, { ok: true }>;
  readonly options: RegisterRuntimeAgentRoutesOptions;
  readonly request: Record<string, unknown>;
  readonly serviceGrantPermission: string;
  readonly entitlementOperation?: MutationBoundaryOperation;
}

type RuntimeAgentAuthorizationResponse =
  | { readonly ok: true }
  | {
    readonly ok: false;
    readonly status: 403;
    readonly body: {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
    };
  };

function authorizeRuntimeAgentPathSubject(input: {
  readonly auth: Extract<RuntimeAgentAuthResult, { ok: true }>;
  readonly agentId: string;
  readonly allowServicePrincipal?: boolean;
}): RuntimeAgentAuthorizationResponse {
  if (input.allowServicePrincipal && isServicePrincipal(input.auth)) {
    return { ok: true };
  }
  const subjectAgentId = input.auth.actor?.agentId ??
    input.auth.workloadIdentityId;
  if (!subjectAgentId || subjectAgentId !== input.agentId) {
    return {
      ok: false,
      status: 403,
      body: apiError("permission_denied", "runtime agent identity mismatch", {
        agentId: input.agentId,
        subjectAgentId,
      }),
    };
  }
  return { ok: true };
}

function isServicePrincipal(
  auth: Extract<RuntimeAgentAuthResult, { ok: true }>,
): boolean {
  return auth.actor?.principalKind === "service" ||
    (auth.actor?.serviceId !== undefined &&
      auth.workloadIdentityId === auth.actor.serviceId);
}

async function authorizeRuntimeAgentMutation(
  input: AuthorizeRuntimeAgentMutationInput,
): Promise<RuntimeAgentAuthorizationResponse> {
  const spaceId = optionalString(input.request.spaceId) ??
    input.auth.actor?.spaceId;
  const groupId = optionalString(input.request.groupId);

  try {
    if (input.options.security) {
      await input.options.security.authorizeInternalServiceCall({
        sourceIdentityId: input.auth.workloadIdentityId,
        targetService: "takosumi",
        permission: input.serviceGrantPermission,
        spaceId,
        groupId,
      });
    }

    if (input.options.entitlements && input.entitlementOperation && spaceId) {
      await input.options.entitlements.requireMutationBoundary({
        spaceId,
        groupId,
        accountId: input.auth.actor?.actorAccountId ?? "",
        operation: input.entitlementOperation,
      });
    }

    return { ok: true };
  } catch (error) {
    if (error instanceof DomainError && error.code === "permission_denied") {
      return {
        ok: false,
        status: 403,
        body: apiError(error.code, error.message, error.details),
      };
    }
    throw error;
  }
}

async function toJsonResponse(
  c: Context,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DomainError) {
      const status = domainStatus(error);
      return c.json(
        apiError(error.code, error.message, error.details),
        status,
      );
    }
    throw error;
  }
}

function runtimeAgentAuthError(
  c: Context,
  auth: Extract<RuntimeAgentAuthResult, { ok: false }>,
): Response {
  const status = auth.status ?? 401;
  return c.json(
    apiError(
      status === 403 ? "permission_denied" : "unauthenticated",
      auth.error,
    ),
    status,
  );
}

function domainStatus(error: DomainError): 400 | 403 | 404 | 409 | 501 {
  switch (error.code) {
    case "invalid_argument":
      return 400;
    case "permission_denied":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "not_implemented":
      return 501;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalHeartbeatStatus(
  value: unknown,
): RuntimeAgentHeartbeatInput["status"] {
  return value === "ready" || value === "draining" ? value : undefined;
}

function optionalCapabilities(
  value: unknown,
): RegisterRuntimeAgentInput["capabilities"] {
  const record = optionalRecord(value);
  if (!record) return undefined;
  const providers = Array.isArray(record.providers)
    ? record.providers.filter((provider) => typeof provider === "string")
    : undefined;
  return {
    providers,
    maxConcurrentLeases: optionalNumber(record.maxConcurrentLeases),
    labels: optionalStringRecord(record.labels),
  };
}

function optionalStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  const record = optionalRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}
