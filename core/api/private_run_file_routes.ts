import type { Hono } from "hono";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
import {
  PrivateRunFilesError,
  PrivateRunFilesService,
  type PrivateRunFileBlobPort,
  type PrivateRunFileDigest,
  type PrivateRunFileOperation,
  type PrivateRunFileRepositoryPort,
} from "../domains/private-run-files/mod.ts";
import {
  PrivateRunFileGrantError,
  type PrivateRunFileGrantClaims,
  type PrivateRunFileGrantCodec,
} from "../domains/private-run-files/grant.ts";

export const PRIVATE_RUN_FILE_HTTP_PATH = "/internal/private-run-files/v1";
export const PRIVATE_RUN_FILE_MAX_BYTES = 16 * 1024 * 1024;
// Base64 for 16 MiB is 22,369,624 bytes; leave bounded JSON framing room.
const MAX_JSON_BYTES = 22_400_000;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export interface PrivateRunFileRouteDependencies {
  readonly grants: PrivateRunFileGrantCodec;
  readonly repository: PrivateRunFileRepositoryPort;
  readonly blobs: PrivateRunFileBlobPort;
  readonly maxBytes: number;
}

/** Internal machine-only route; deliberately absent from OpenAPI and CORS. */
export function mountPrivateRunFileRoutes(
  app: Hono,
  dependencies: PrivateRunFileRouteDependencies,
): void {
  if (dependencies.maxBytes !== PRIVATE_RUN_FILE_MAX_BYTES) {
    throw new TypeError("private run file HTTP requires the 16 MiB domain cap");
  }
  for (const operation of ["read", "commit", "resolve"] as const) {
    app.post(`${PRIVATE_RUN_FILE_HTTP_PATH}/${operation}`, async (c) => {
      // An Origin-bearing browser request has no role at this Runner-only seam.
      if (c.req.header("origin")) return c.json({ kind: "authorization_rejected" }, 403);
      const header = c.req.header("authorization");
      if (!header?.startsWith("Bearer ") || header.indexOf(" ", 7) !== -1) {
        return c.json({ kind: "authorization_rejected" }, 401);
      }
      let claims: PrivateRunFileGrantClaims;
      try {
        claims = await dependencies.grants.open(header.slice(7));
      } catch {
        return c.json({ kind: "authorization_rejected" }, 401);
      }
      if (!claims.operations.includes(operation)) {
        return c.json({ kind: "authorization_rejected" }, 403);
      }
      const service = serviceForClaims(dependencies, claims, header.slice(7));
      try {
        const body = await boundedJson(c.req.raw);
        if (operation === "read") {
          exactFields(body, []);
          const result = await service.read({
            scope: claims.scope,
            authority: claims.authority,
          });
          return c.json(result.kind === "absent"
            ? { kind: "absent" }
            : {
              kind: "present",
              version: result.version,
              digest: result.digest,
              bytesBase64: encodeBase64(result.bytes),
            });
        }
        if (operation === "commit") {
          exactFields(body, ["expectedVersion", "commitId", "bytesBase64"]);
          const expectedVersion = version(body.expectedVersion);
          const commitId = text(body.commitId);
          const bytes = decodeBase64(body.bytesBase64, dependencies.maxBytes);
          const result = await service.commit({
            scope: claims.scope,
            authority: claims.authority,
            expectedVersion,
            commitId,
            bytes,
          });
          return c.json(result.kind === "committed" || result.kind === "replayed"
            ? { kind: result.kind, receipt: publicReceipt(result.receipt) }
            : result);
        }
        exactFields(body, ["expectedVersion", "commitId", "digest"]);
        const digest = body.digest;
        if (typeof digest !== "string" || !digestPattern.test(digest)) invalid();
        const result = await service.resolve({
          scope: claims.scope,
          authority: claims.authority,
          expectedVersion: version(body.expectedVersion),
          commitId: text(body.commitId),
          digest: digest as PrivateRunFileDigest,
        });
        return c.json(result.kind === "committed"
          ? { kind: "committed", receipt: publicReceipt(result.receipt) }
          : result);
      } catch (error) {
        if (error instanceof PrivateRunFileGrantError) {
          return c.json({ kind: "authorization_rejected" }, 403);
        }
        if (error instanceof PrivateRunFilesError) {
          const status = error.code === "too_large" ? 413
            : error.code === "invalid_argument" ? 400
            : error.code === "authorization_rejected" ? 403
            : 503;
          return c.json({ kind: error.code }, status);
        }
        return c.json({ kind: "unavailable" }, 503);
      }
    });
  }
}

function serviceForClaims(
  dependencies: PrivateRunFileRouteDependencies,
  claims: PrivateRunFileGrantClaims,
  opaqueGrant: string,
): PrivateRunFilesService {
  return new PrivateRunFilesService({
    repository: dependencies.repository,
    blobs: dependencies.blobs,
    maxBytes: dependencies.maxBytes,
    authorization: {
      authorize: async ({ scope, authority, operation }) => {
        let current: PrivateRunFileGrantClaims;
        try {
          // A slow body or base64 decode can cross exp after the initial bearer
          // check. Reopen immediately before the service touches storage.
          current = await dependencies.grants.open(opaqueGrant);
        } catch {
          throw new PrivateRunFilesError("authorization_rejected");
        }
        if (!sameGrantClaims(current, claims) ||
          !sameScope(scope, current.scope) ||
          authority.runId !== claims.authority.runId ||
          authority.executionAuthorityEpoch !== claims.authority.executionAuthorityEpoch ||
          !constantTimeEqualsString(authority.leaseToken, current.authority.leaseToken) ||
          !current.operations.includes(operation as PrivateRunFileOperation)) {
          throw new PrivateRunFilesError("authorization_rejected");
        }
      },
    },
  });
}

function sameGrantClaims(left: PrivateRunFileGrantClaims, right: PrivateRunFileGrantClaims): boolean {
  return sameScope(left.scope, right.scope) &&
    left.authority.runId === right.authority.runId &&
    left.authority.executionAuthorityEpoch === right.authority.executionAuthorityEpoch &&
    constantTimeEqualsString(left.authority.leaseToken, right.authority.leaseToken) &&
    left.issuedAt === right.issuedAt && left.expiresAt === right.expiresAt &&
    left.operations.length === right.operations.length &&
    left.operations.every((operation, index) => operation === right.operations[index]);
}

function sameScope(left: PrivateRunFileGrantClaims["scope"], right: PrivateRunFileGrantClaims["scope"]): boolean {
  return left.workspaceId === right.workspaceId &&
    left.capsuleId === right.capsuleId &&
    left.environment === right.environment && left.slot === right.slot;
}

function publicReceipt(receipt: { version: number; digest: string; commitId: string; expectedVersion: number }) {
  return {
    version: receipt.version,
    digest: receipt.digest,
    commitId: receipt.commitId,
    expectedVersion: receipt.expectedVersion,
  };
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await request.body?.cancel().catch(() => {});
    invalid();
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_JSON_BYTES) {
    await request.body?.cancel().catch(() => {});
    throw new PrivateRunFilesError("too_large");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (!reader) invalid();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) throw new PrivateRunFilesError("too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(parsed)) invalid();
    return parsed;
  } catch {
    invalid();
  }
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length ||
    actual.some((field, index) => field !== [...expected].sort()[index])) invalid();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new PrivateRunFilesError("invalid_argument");
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.trim() !== value) invalid();
  return value;
}

function decodeBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string") invalid();
  if (value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new PrivateRunFilesError("too_large");
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) invalid();
  try {
    const binary = atob(value);
    if (binary.length > maxBytes) throw new PrivateRunFilesError("too_large");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64(bytes) !== value) invalid();
    return bytes;
  } catch (error) {
    if (error instanceof PrivateRunFilesError) throw error;
    invalid();
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
