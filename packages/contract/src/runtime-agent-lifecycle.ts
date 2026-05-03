/**
 * Runtime-agent lifecycle protocol.
 *
 * Plugins (kernel-side) are paper-thin HTTP clients. They post these envelopes
 * to a runtime-agent service which dispatches to a per-provider connector
 * (cloud SDK call or local OS call). Credentials live ONLY on the runtime-agent
 * host.
 *
 * Endpoints (runtime-agent HTTP API):
 *   POST /v1/lifecycle/apply
 *   POST /v1/lifecycle/destroy
 *   POST /v1/lifecycle/describe
 *   GET  /v1/health
 *
 * Auth: bearer token shared between kernel and runtime-agent.
 */

import type { JsonObject, JsonValue } from "./types.ts";

/**
 * Artifact descriptor — a discriminated union over `kind` (open string).
 *
 * - `kind: "oci-image"` typically uses `uri` (e.g. `ghcr.io/me/api:v1`)
 * - `kind: "js-bundle"` / `"lambda-zip"` / `"tarball"` / etc. use `hash`
 *   pointing at a `takosumi artifact push`-uploaded blob
 *
 * `kind` is intentionally open: 3rd-party connectors can introduce new kinds
 * without changing the contract package.
 */
export interface Artifact {
  readonly kind: string;
  /** Content-addressed hash returned by `POST /v1/artifacts` (e.g. `sha256:abc…`). */
  readonly hash?: string;
  /** External pointer (OCI registry URI, https URL, etc). */
  readonly uri?: string;
  /** Kind-specific metadata (entrypoint / handler / mime / compatibility-date / …). */
  readonly metadata?: JsonObject;
}

/** Response shape for `POST /v1/artifacts` and inspect endpoints. */
export interface ArtifactStored {
  readonly hash: string;
  readonly kind: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly metadata?: JsonObject;
}

/**
 * Locator for the kernel-side artifact store. The kernel embeds this in every
 * `LifecycleApplyRequest` so connectors can fetch uploaded bytes when their
 * spec carries `artifact.hash`. Token is short-lived and scoped to read-only
 * artifact access.
 */
export interface ArtifactStoreLocator {
  readonly baseUrl: string;
  readonly token: string;
}

export interface LifecycleApplyRequest {
  /** Shape ref (e.g. `object-store@v1`). */
  readonly shape: string;
  /** Provider id (e.g. `aws-s3`, `filesystem`). */
  readonly provider: string;
  readonly resourceName: string;
  readonly spec: JsonValue;
  readonly tenantId?: string;
  /** Optional metadata forwarded by kernel (audit trail, request id). */
  readonly metadata?: JsonObject;
  /** Where the connector can fetch artifact bytes by hash, when spec carries
   *  `artifact.hash`. Absent for pure pointer-based deploys. */
  readonly artifactStore?: ArtifactStoreLocator;
}

export interface LifecycleApplyResponse {
  /** Stable handle (e.g. AWS ARN, Docker container id). Used for destroy/describe. */
  readonly handle: string;
  /** Outputs the shape declares (for ${ref:...} resolution). */
  readonly outputs: JsonObject;
}

export interface LifecycleDestroyRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly tenantId?: string;
  readonly metadata?: JsonObject;
}

export interface LifecycleDestroyResponse {
  readonly ok: boolean;
  /** Optional reason on partial / soft failures. */
  readonly note?: string;
}

export interface LifecycleDescribeRequest {
  readonly shape: string;
  readonly provider: string;
  readonly handle: string;
  readonly tenantId?: string;
}

export type LifecycleStatus =
  | "running"
  | "stopped"
  | "missing"
  | "error"
  | "unknown";

export interface LifecycleDescribeResponse {
  readonly status: LifecycleStatus;
  readonly outputs?: JsonObject;
  readonly note?: string;
}

/** Standard error envelope returned by runtime-agent HTTP responses (4xx / 5xx). */
export interface LifecycleErrorBody {
  readonly error: string;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly details?: JsonObject;
}

/** HTTP path constants — single source of truth for kernel client + agent server. */
export const LIFECYCLE_APPLY_PATH = "/v1/lifecycle/apply" as const;
export const LIFECYCLE_DESTROY_PATH = "/v1/lifecycle/destroy" as const;
export const LIFECYCLE_DESCRIBE_PATH = "/v1/lifecycle/describe" as const;
export const LIFECYCLE_HEALTH_PATH = "/v1/health" as const;

/** Kernel-side artifact endpoints. */
export const ARTIFACTS_BASE_PATH = "/v1/artifacts" as const;

/** Auth header convention (Bearer <token>). Token is shared via TAKOSUMI_AGENT_TOKEN env. */
export const LIFECYCLE_AUTH_HEADER = "authorization" as const;
export const LIFECYCLE_AGENT_TOKEN_ENV = "TAKOSUMI_AGENT_TOKEN" as const;
export const LIFECYCLE_AGENT_URL_ENV = "TAKOSUMI_AGENT_URL" as const;
