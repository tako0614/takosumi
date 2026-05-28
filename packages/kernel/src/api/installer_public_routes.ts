/**
 * Public installer HTTP surface — 5 endpoints exposing the AppSpec /
 * Installation / Deployment public concept set.
 *
 * Wave 5 implementation: handlers delegate to `InstallerPipeline`. When
 * no pipeline is injected, the routes fall back to 501 not_implemented so
 * upstream tests that don't supply a pipeline still see a stable shape.
 *
 *   POST /v1/installations/dry-run
 *   POST /v1/installations
 *   POST /v1/installations/{id}/deployments/dry-run
 *   POST /v1/installations/{id}/deployments
 *   POST /v1/installations/{id}/rollback
 *
 * Wire shape is the 1:1 mirror of `@takos/takosumi-contract/installer-api`.
 *
 * Hardening (Wave M-Fix Agent 3):
 *
 *   - **Body size limit**: every handler enforces an upstream `Content-Length`
 *     ceiling before parsing JSON. The public surface accepts JSON only
 *     (prepared source archives are fetched out-of-band by URL), so the
 *     installer-side cap is {@link INSTALLER_JSON_BODY_LIMIT_BYTES}. The
 *     larger {@link PREPARED_SOURCE_ARCHIVE_LIMIT_BYTES} constant documents
 *     the cap that operator build/fetch services enforce when materializing
 *     prepared sources referenced by `source.kind: "prepared"`.
 *   - **Closed error envelopes**: 500 responses never leak the raw
 *     `Error.message` or stack to callers. The full error is logged via the
 *     kernel logger; the caller sees `{ error: { code: "internal_error",
 *     requestId } }`.
 *   - **Constant-time bearer comparison**: the installer bearer is compared
 *     to the configured token with a length-padded XOR loop so per-byte
 *     timing cannot reveal the secret.
 *   - **Request ID propagation**: inbound `x-request-id` /
 *     `x-correlation-id` headers are honoured when they look like a UUID or
 *     ULID; otherwise a fresh UUID is minted.
 *   - **Route param validation**: `installationId` must match the
 *     `ins_<16-32 base32/hex>` shape before the handler talks to the
 *     installer store, so path-traversal-shaped IDs never reach storage
 *     lookups.
 *   - **Unknown-field rejection**: JSON bodies must only contain
 *     well-known keys for the endpoint. Unknown top-level keys produce a
 *     400 closed envelope with code `invalid_argument` and a structured
 *     `unknown_field` reason — typos like `expectd` no longer silently
 *     succeed.
 */

import type { Context, Hono } from "hono";
import type {
  DeploymentApplyRequest,
  DeploymentDryRunRequest,
  InstallationApplyRequest,
  InstallationDryRunRequest,
  InstallerErrorCode,
  InstallerErrorEnvelope,
  RollbackRequest,
} from "takosumi-contract/installer-api";
import {
  type InstallerPipeline,
  InstallerPipelineError,
  type InstallerPipelineErrorCode,
} from "../domains/installer/mod.ts";
import { log } from "../shared/log.ts";

export const INSTALLER_INSTALLATIONS_PATH = "/v1/installations" as const;
export const INSTALLER_INSTALLATIONS_DRY_RUN_PATH =
  "/v1/installations/dry-run" as const;
export const INSTALLER_INSTALLATION_DEPLOYMENTS_PATH =
  "/v1/installations/:installationId/deployments" as const;
export const INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH =
  "/v1/installations/:installationId/deployments/dry-run" as const;
export const INSTALLER_INSTALLATION_ROLLBACK_PATH =
  "/v1/installations/:installationId/rollback" as const;

/**
 * Maximum allowed `Content-Length` for installer JSON request bodies.
 *
 * The 5 installer endpoints take JSON descriptors (source ref, expected
 * pin, deployment id). 1 MiB leaves comfortable headroom for the largest
 * realistic InstallationApplyRequest while keeping the public surface
 * cheap to deny on flooders before parse.
 */
export const INSTALLER_JSON_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

/**
 * Documented cap for prepared-source archive payloads. Prepared sources
 * are fetched by the kernel from `source.url`, not embedded in installer
 * request bodies, so this constant lives here only so operator build /
 * fetch services and reverse proxies have a single source of truth.
 */
export const PREPARED_SOURCE_ARCHIVE_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * Route-param shape for `installationId`. The kernel mints these with
 * the `ins_` prefix plus 16 lowercase hex characters
 * (`crypto.randomUUID().replace(/-/g, "").slice(0, 16)`); operators that
 * resize IDs in alternative installer implementations stay within the
 * documented base32/hex range below. Anything outside this regex is a
 * malformed ID and must not reach the installation store (so we cannot
 * accept `..`, slashes, query strings, or surrogate-pair smuggling).
 */
const INSTALLATION_ID_PATTERN = /^ins_[0-9a-zA-Z]{16,32}$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Accepted top-level keys per endpoint. Unknown keys produce a 400
 * `invalid_argument` envelope with `details.unknownField` so the caller
 * sees which key was rejected.
 */
const ALLOWED_KEYS: Record<InstallerRouteName, ReadonlySet<string>> = {
  installationDryRun: new Set(["spaceId", "source"]),
  installationApply: new Set(["spaceId", "source", "expected"]),
  deploymentDryRun: new Set(["source"]),
  deploymentApply: new Set(["source", "expected"]),
  rollback: new Set(["deploymentId"]),
};

type InstallerRouteName =
  | "installationDryRun"
  | "installationApply"
  | "deploymentDryRun"
  | "deploymentApply"
  | "rollback";

export interface InstallerPublicRouteDependencies {
  /**
   * Installer bearer resolver. When unset or empty, installer routes are
   * disabled and return 404 so public hosts do not leak an unconfigured
   * surface.
   */
  readonly getInstallerToken?: () => string | undefined;
  /**
   * Installer pipeline instance — when unset, every endpoint returns 501
   * not_implemented (Wave 5 default until bootstrap wires one in).
   */
  readonly pipeline?: InstallerPipeline;
}

export function mountInstallerPublicRoutes(
  app: Hono,
  dependencies: InstallerPublicRouteDependencies = {},
): void {
  const pipeline = dependencies.pipeline;

  if (!pipeline) {
    app.post(
      INSTALLER_INSTALLATIONS_DRY_RUN_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(
            notImplemented(c, "installer dry-run not yet implemented"),
            501,
          ),
    );
    app.post(
      INSTALLER_INSTALLATIONS_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(notImplemented(c, "installer apply not yet implemented"), 501),
    );
    app.post(
      INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(
            notImplemented(c, "deployment dry-run not yet implemented"),
            501,
          ),
    );
    app.post(
      INSTALLER_INSTALLATION_DEPLOYMENTS_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(
            notImplemented(c, "deployment apply not yet implemented"),
            501,
          ),
    );
    app.post(
      INSTALLER_INSTALLATION_ROLLBACK_PATH,
      (c) =>
        authorizeInstaller(c, dependencies) ??
          c.json(notImplemented(c, "rollback not yet implemented"), 501),
    );
    return;
  }

  app.post(INSTALLER_INSTALLATIONS_DRY_RUN_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    const bodyLimit = enforceBodyLimit(c, INSTALLER_JSON_BODY_LIMIT_BYTES);
    if (bodyLimit) return bodyLimit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<InstallationDryRunRequest>(
        c,
        "installationDryRun",
      );
      const response = await pipeline.installationDryRun(body);
      return c.json(response, 200);
    });
  });

  app.post(INSTALLER_INSTALLATIONS_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    const bodyLimit = enforceBodyLimit(c, INSTALLER_JSON_BODY_LIMIT_BYTES);
    if (bodyLimit) return bodyLimit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<InstallationApplyRequest>(
        c,
        "installationApply",
      );
      const response = await pipeline.installationApply(body);
      return c.json(response, 201);
    });
  });

  app.post(INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    const idCheck = ensureValidInstallationId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    const bodyLimit = enforceBodyLimit(c, INSTALLER_JSON_BODY_LIMIT_BYTES);
    if (bodyLimit) return bodyLimit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<DeploymentDryRunRequest>(
        c,
        "deploymentDryRun",
      );
      const response = await pipeline.deploymentDryRun(idCheck.value, body);
      return c.json(response, 200);
    });
  });

  app.post(INSTALLER_INSTALLATION_DEPLOYMENTS_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    const idCheck = ensureValidInstallationId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    const bodyLimit = enforceBodyLimit(c, INSTALLER_JSON_BODY_LIMIT_BYTES);
    if (bodyLimit) return bodyLimit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<DeploymentApplyRequest>(
        c,
        "deploymentApply",
      );
      const response = await pipeline.deploymentApply(idCheck.value, body);
      return c.json(response, 201);
    });
  });

  app.post(INSTALLER_INSTALLATION_ROLLBACK_PATH, async (c) => {
    const unauthorized = authorizeInstaller(c, dependencies);
    if (unauthorized) return unauthorized;
    const idCheck = ensureValidInstallationId(c);
    if (idCheck.kind === "invalid") return idCheck.response;
    const bodyLimit = enforceBodyLimit(c, INSTALLER_JSON_BODY_LIMIT_BYTES);
    if (bodyLimit) return bodyLimit;
    return await runHandler(c, async () => {
      const body = await readJsonBody<RollbackRequest>(c, "rollback");
      const response = await pipeline.rollback(idCheck.value, body);
      return c.json(response, 200);
    });
  });
}

function authorizeInstaller(
  c: Context,
  dependencies: InstallerPublicRouteDependencies,
): Response | undefined {
  const token = dependencies.getInstallerToken?.();
  if (!token) {
    return c.json(
      errorEnvelope(c, "not_found", "installer routes disabled"),
      404,
    );
  }
  const header = c.req.header("authorization") ?? "";
  if (!constantTimeEquals(header, `Bearer ${token}`)) {
    return c.json(
      errorEnvelope(c, "unauthenticated", "invalid installer bearer"),
      401,
    );
  }
  return undefined;
}

function notImplemented(
  c: Context,
  message: string,
): InstallerErrorEnvelope {
  return {
    error: {
      code: "not_implemented" satisfies InstallerErrorCode,
      message,
      requestId: resolveRequestId(c),
    },
  };
}

async function runHandler(
  c: Context,
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InstallerPipelineError) {
      return c.json(
        errorEnvelope(c, err.code, err.message),
        pipelineHttpStatus(err.code),
      );
    }
    const requestId = resolveRequestId(c);
    log.error("installer.public_routes.internal_error", {
      requestId,
      path: c.req.path,
      method: c.req.method,
      error: err,
    });
    // Do not leak `err.message` or stack to the caller; the full error
    // is recorded server-side. Callers correlate via `requestId`.
    return c.json(
      {
        error: {
          code: "internal_error" satisfies InstallerErrorCode,
          message: "internal error",
          requestId,
        },
      } satisfies InstallerErrorEnvelope,
      500,
    );
  }
}

async function readJsonBody<T>(
  c: Context,
  route: InstallerRouteName,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new InstallerPipelineError(
      "invalid_argument",
      "request body must be valid JSON",
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InstallerPipelineError(
      "invalid_argument",
      "request body must be a JSON object",
    );
  }
  const allowed = ALLOWED_KEYS[route];
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new InstallerPipelineError(
        "invalid_argument",
        `unknown_field: ${key}`,
      );
    }
  }
  return raw as T;
}

function enforceBodyLimit(
  c: Context,
  limitBytes: number,
): Response | undefined {
  const header = c.req.header("content-length");
  if (header === undefined) return undefined;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return c.json(
      errorEnvelope(c, "invalid_argument", "invalid content-length header"),
      400,
    );
  }
  if (parsed > limitBytes) {
    return c.json(
      errorEnvelope(
        c,
        "resource_exhausted",
        `request body exceeds ${limitBytes} byte limit`,
      ),
      413,
    );
  }
  return undefined;
}

function ensureValidInstallationId(
  c: Context,
):
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "invalid"; readonly response: Response } {
  const raw = c.req.param("installationId") ?? "";
  if (!INSTALLATION_ID_PATTERN.test(raw)) {
    return {
      kind: "invalid",
      response: c.json(
        errorEnvelope(
          c,
          "invalid_argument",
          "installationId has an unsupported shape",
        ),
        400,
      ),
    };
  }
  return { kind: "ok", value: raw };
}

function pipelineHttpStatus(
  code: InstallerPipelineErrorCode,
): 400 | 401 | 403 | 404 | 409 | 413 | 500 | 501 {
  switch (code) {
    case "invalid_argument":
      return 400;
    case "unauthenticated":
      return 401;
    case "permission_denied":
      return 403;
    case "not_found":
      return 404;
    // Phase A docs flip: failed_precondition surfaces as 409 Conflict (the
    // expected pin / publisher topology / source-drift conflicts with the
    // server's current state) and resource_exhausted surfaces as 413
    // Payload Too Large (the request would exceed an operator-configured
    // quota). The earlier 412 / 429 mapping was retired with the
    // idempotency / If-Match removal.
    case "failed_precondition":
      return 409;
    case "resource_exhausted":
      return 413;
    case "not_implemented":
      return 501;
    case "internal_error":
      return 500;
  }
}

function errorEnvelope(
  c: Context,
  code: InstallerErrorCode,
  message: string,
): InstallerErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId: resolveRequestId(c),
    },
  };
}

/**
 * Resolve the request id for an error envelope.
 *
 * Honour inbound `x-request-id` / `x-correlation-id` headers when they
 * match a UUID or Crockford-base32 ULID shape; otherwise mint a fresh
 * UUID. Validating the shape prevents a caller from forcing arbitrary
 * strings (or sensitive substrings) into operator log indexes.
 */
function resolveRequestId(c: Context): string {
  const fromHeader = c.req.header("x-request-id") ??
    c.req.header("x-correlation-id");
  if (fromHeader && isValidRequestIdShape(fromHeader)) return fromHeader;
  return crypto.randomUUID();
}

function isValidRequestIdShape(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  return UUID_PATTERN.test(value) || ULID_PATTERN.test(value);
}

/**
 * Length-padded XOR comparison so attackers cannot recover the installer
 * bearer one byte at a time via response-timing variance. Both operands
 * are encoded as UTF-8 bytes so multi-byte characters in operator tokens
 * are compared end-to-end.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}
