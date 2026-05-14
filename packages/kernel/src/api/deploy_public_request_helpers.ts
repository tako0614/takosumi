import type {
  JsonObject,
  ManifestResource,
  PlatformOperationRecoveryMode,
} from "takosumi-contract";
import { listArtifactKinds } from "takosumi-contract";
import { operationJournalEffectDigest } from "../domains/deploy/operation_journal.ts";
import { apiError, MalformedJsonRequestError } from "./errors.ts";
import {
  type BearerCheckFail,
  type BearerCheckOk,
  type DeployPublicHandledResponse,
  type DeployPublicMode,
  type DeployPublicProvenance,
  type DeployPublicRecoveryMode,
  TAKOSUMI_MANIFEST_ARTIFACT_SIZE_MAX_BYTES_DEFAULT,
} from "./deploy_public_types.ts";

export type ArtifactSizeQuotaResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly response: DeployPublicHandledResponse };

export function validateManifestArtifactSizeQuota(
  resources: readonly ManifestResource[],
  fallbackMaxBytes: number,
): ArtifactSizeQuotaResult {
  for (const resource of resources) {
    const artifact = readManifestArtifactSpec(resource);
    if (!artifact) continue;
    const rawSize = artifact.size;
    if (rawSize === undefined) continue;
    if (
      typeof rawSize !== "number" || !Number.isInteger(rawSize) ||
      rawSize < 0
    ) {
      return {
        ok: false,
        response: {
          status: 400,
          body: apiError(
            "invalid_argument",
            `resources.${resource.name}.spec.artifact.size must be a non-negative integer byte count`,
            { resource: resource.name, value: rawSize },
          ),
        },
      };
    }
    const size = rawSize;
    const kind = typeof artifact.kind === "string" && artifact.kind.length > 0
      ? artifact.kind
      : undefined;
    const maxBytes = manifestArtifactMaxBytesForKind(kind, fallbackMaxBytes);
    if (size <= maxBytes) continue;
    return {
      ok: false,
      response: {
        status: 413,
        body: apiError(
          "resource_exhausted",
          `resources.${resource.name}.spec.artifact.size exceeds the configured artifact quota`,
          {
            resource: resource.name,
            kind: kind ?? null,
            size,
            maxBytes,
            rule: "manifest-artifact-size",
          },
        ),
      },
    };
  }
  return { ok: true };
}

function readManifestArtifactSpec(
  resource: ManifestResource,
): JsonObject | undefined {
  if (!isJsonObject(resource.spec)) return undefined;
  const artifact = resource.spec.artifact;
  return isJsonObject(artifact) ? artifact : undefined;
}

function manifestArtifactMaxBytesForKind(
  kind: string | undefined,
  fallback: number,
): number {
  if (!kind) return fallback;
  const registered = listArtifactKinds().find((entry) => entry.kind === kind);
  return validPositiveInteger(registered?.maxSize)
    ? registered.maxSize
    : fallback;
}

export function resolveManifestArtifactMaxBytes(value: unknown): number {
  return validPositiveInteger(value)
    ? value
    : TAKOSUMI_MANIFEST_ARTIFACT_SIZE_MAX_BYTES_DEFAULT;
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function readDeployPublicProvenance(
  value: unknown,
):
  | { readonly ok: true; readonly value?: DeployPublicProvenance }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!isJsonObject(value)) {
    return {
      ok: false,
      error: "provenance must be a JSON object when provided",
    };
  }
  if (
    value.kind !== undefined &&
    typeof value.kind !== "string"
  ) {
    return {
      ok: false,
      error: "provenance.kind must be a string when provided",
    };
  }
  return { ok: true, value };
}

export function journalDetail(
  detail: JsonObject | undefined,
  provenance: DeployPublicProvenance | undefined,
): JsonObject | undefined {
  if (!provenance) return detail;
  return {
    ...(detail ?? {}),
    provenance,
  };
}

export function attachProvenanceToResources(
  resources: readonly ManifestResource[],
  provenance: DeployPublicProvenance | undefined,
): readonly ManifestResource[] {
  if (!provenance) return resources;
  const provenanceDigest = operationJournalEffectDigest(provenance);
  return resources.map((resource) => ({
    ...resource,
    metadata: {
      ...(resource.metadata ?? {}),
      takosumiDeployProvenance: {
        kind: "takosumi.deploy-provenance-digest@v1",
        digest: provenanceDigest,
      },
    },
  }));
}

export function checkBearer(
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

export function readBearerToken(
  header: string | undefined,
): string | undefined {
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

export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function readJsonBody(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown>; rawText: string }
  | { ok: false; error: string }
> {
  const text = await request.text();
  if (text.trim() === "") return { ok: true, value: {}, rawText: text };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedJsonRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  return { ok: true, value: value as Record<string, unknown>, rawText: text };
}

export function readIdempotencyKey(
  header: string | undefined,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string } {
  const trimmed = header?.trim();
  if (!trimmed) {
    return { ok: true, value: `generated:${crypto.randomUUID()}` };
  }
  if (trimmed.length > 256) {
    return {
      ok: false,
      error: "X-Idempotency-Key must be at most 256 characters",
    };
  }
  return { ok: true, value: trimmed };
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function readMode(
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

export function readRecoveryMode(
  value: unknown,
):
  | { ok: true; value?: DeployPublicRecoveryMode }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (
    value === "inspect" || value === "continue" || value === "compensate"
  ) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error:
      "recoveryMode must be one of inspect|continue|compensate when provided",
  };
}

export function platformRecoveryMode(
  value: DeployPublicRecoveryMode | undefined,
): PlatformOperationRecoveryMode {
  return value ?? "normal";
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
