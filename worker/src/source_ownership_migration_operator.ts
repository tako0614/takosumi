/** Protected, operator-invoked Source ownership repair. Never scheduled. */
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import { constantTimeEqualsString } from "../../core/shared/constant_time.ts";
import { sha256HexOfStringAsync } from "../../core/shared/runtime/hash.ts";
import { migrateSourceOwnership, prepareSourceOwnershipMigration, sourceOwnershipMigrationPlanDigest, type SourceOwnershipMigrationArchiveCopier,
  type SourceOwnershipMigrationResult, type SourceOwnershipMigrationStore } from "../../core/domains/sources/ownership-migration.ts";
import { CloudflareD1OpenTofuControlStore } from "./d1_opentofu_store.ts";
import type { CloudflareWorkerEnv, R2Bucket, R2ObjectBody } from "./bindings.ts";
import { storedServiceCompositionFromEnv } from "./stored-service-usage.ts";

export const SOURCE_OWNERSHIP_MIGRATION_PATH = "/internal/platform/source-ownership-migration";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_COPY_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_COPY_BATCH_ITEMS = 16;
const allocator = new ObjectKeyArtifactReferenceAllocator();

export interface SourceOwnershipMigrationOperatorDependencies {
  readonly store?: SourceOwnershipMigrationStore;
  readonly copier?: SourceOwnershipMigrationArchiveCopier;
  readonly now?: () => Date;
}

export async function handleSourceOwnershipMigrationOperatorRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  dependencies: SourceOwnershipMigrationOperatorDependencies = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== SOURCE_OWNERSHIP_MIGRATION_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET, POST" } });
  }
  const token = env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
  if (!token) return Response.json({ error: "not_found" }, { status: 404 });
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!bearer || !constantTimeEqualsString(bearer, token)) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!env.TAKOSUMI_CONTROL_DB) return Response.json({ error: "control_db_unavailable" }, { status: 503 });
  const store = dependencies.store ?? new CloudflareD1OpenTofuControlStore(env.TAKOSUMI_CONTROL_DB, {
    // Operator migration is DDL-free even in an OSS bootstrap composition.
    schemaMode: "predeployed",
  });
  const copier = dependencies.copier ?? (env.R2_SOURCE ? new R2SourceOwnershipArchiveCopier(env.R2_SOURCE) : undefined);
  const dryRunCopier: SourceOwnershipMigrationArchiveCopier = copier ?? {
    copyVerified: async () => { throw new Error("source_archive_store_unavailable"); },
  };
  try {
    if (request.method === "GET") {
      if ([...url.searchParams.keys()].some((key) => key !== "sourceId")) {
        return Response.json({ error: "invalid_query" }, { status: 400 });
      }
      const rawSourceId = url.searchParams.get("sourceId");
      if (rawSourceId !== null && !/^[A-Za-z][A-Za-z0-9_-]{2,127}$/.test(rawSourceId)) {
        return Response.json({ error: "invalid_source_id" }, { status: 400 });
      }
      const sourceId = rawSourceId ?? undefined;
      const preparedAt = (dependencies.now ?? (() => new Date()))().toISOString();
      const results = await migrateSourceOwnership(store, allocator, dryRunCopier, { sourceId, now: preparedAt });
      const reportDigest = await digestReport(preparedAt, results);
      return Response.json({ kind: "takosumi.source-ownership-migration.dry-run@v1", preparedAt, reportDigest, results },
        { headers: { "cache-control": "no-store" } });
    }
    if (url.search) return Response.json({ error: "invalid_query" }, { status: 400 });
    const body = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const values = body as Record<string, unknown>;
    if (Object.keys(values).some((key) => !["preparedAt", "reportDigest", "sourceId", "copyCursor", "copyReceipt"].includes(key)) ||
      typeof values.sourceId !== "string" || !values.sourceId.trim() ||
      !/^[A-Za-z][A-Za-z0-9_-]{2,127}$/.test(values.sourceId) ||
      typeof values.preparedAt !== "string" || !Number.isFinite(Date.parse(values.preparedAt)) ||
      new Date(values.preparedAt).toISOString() !== values.preparedAt ||
      typeof values.reportDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(values.reportDigest)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const sourceId = values.sourceId;
    const copyCursor = values.copyCursor === undefined ? 0 : values.copyCursor;
    if (!Number.isSafeInteger(copyCursor) || (copyCursor as number) < 0 ||
      (copyCursor === 0 && values.copyReceipt !== undefined) ||
      ((copyCursor as number) > 0 && (typeof values.copyReceipt !== "string" || !/^[0-9a-f]{64}$/.test(values.copyReceipt)))) {
      return Response.json({ error: "invalid_copy_cursor" }, { status: 400 });
    }
    const before = await migrateSourceOwnership(store, allocator, dryRunCopier, { sourceId, now: values.preparedAt });
    if (await digestReport(values.preparedAt, before) !== values.reportDigest) {
      return Response.json({ error: "dry_run_changed", results: before }, { status: 409,
        headers: { "cache-control": "no-store" } });
    }
    const observed = before[0];
    if (!observed) throw new Error("source_ownership_migration_missing_inventory");
    if (observed.status === "blocked" || observed.status === "unchanged") {
      return Response.json({ kind: "takosumi.source-ownership-migration.apply@v1", results: before },
        { status: observed.status === "blocked" ? 409 : 200, headers: { "cache-control": "no-store" } });
    }
    const group = await store.readGroup(sourceId);
    if (!group) throw new Error(`source_ownership_migration_missing_source:${sourceId}`);
    const mutation = await prepareSourceOwnershipMigration(group, allocator, values.preparedAt);
    if (!mutation) throw new Error("source_ownership_migration_missing_mutation");
    if (await sourceOwnershipMigrationPlanDigest(mutation) !== observed.planDigest) {
      return Response.json({ error: "dry_run_changed" }, { status: 409,
        headers: { "cache-control": "no-store" } });
    }
    // Metadata-only backfill/retire does not need object copy custody.
    if (mutation.archiveCopies.length > 0) {
      try {
        if (storedServiceCompositionFromEnv(env)) {
          return Response.json({ error: "source_archive_custody_unavailable" },
            { status: 503, headers: { "cache-control": "no-store" } });
        }
      } catch {
        return Response.json({ error: "source_archive_custody_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } });
      }
      if (!copier) return Response.json({ error: "source_archive_store_unavailable" }, { status: 503 });
    }
    if (copyCursor as number > mutation.archiveCopies.length) {
      return Response.json({ error: "invalid_copy_cursor" }, { status: 400 });
    }
    if ((copyCursor as number) > 0 &&
      !constantTimeEqualsString(values.copyReceipt as string,
        await signCopyReceipt(token, sourceId, values.preparedAt, values.reportDigest, copyCursor as number))) {
      return Response.json({ error: "invalid_copy_receipt" }, { status: 409 });
    }
    let cursor = copyCursor as number;
    let batchBytes = 0;
    while (cursor < mutation.archiveCopies.length && cursor - (copyCursor as number) < MAX_COPY_BATCH_ITEMS) {
      const copy = mutation.archiveCopies[cursor]!;
      if (cursor > (copyCursor as number) && batchBytes + copy.sizeBytes > MAX_COPY_BATCH_BYTES) break;
      try {
        await dryRunCopier.copyVerified(copy);
      } catch (error) {
        const reason = error instanceof Error && error.message.startsWith("source_archive_missing")
          ? "source_archive_missing" : "archive_copy_failed";
        return Response.json({ kind: "takosumi.source-ownership-migration.apply@v1",
          results: [{ ...observed, status: "blocked", inventory: { ...observed.inventory, action: "blocked", reason } }] },
          { status: 409, headers: { "cache-control": "no-store" } });
      }
      batchBytes += copy.sizeBytes;
      cursor++;
    }
    if (cursor < mutation.archiveCopies.length) {
      return Response.json({ kind: "takosumi.source-ownership-migration.copy-pending@v1",
        sourceId, preparedAt: values.preparedAt, reportDigest: values.reportDigest,
        nextCopyCursor: cursor, copyReceipt: await signCopyReceipt(token, sourceId,
          values.preparedAt, values.reportDigest, cursor),
        copiesCompleted: cursor, copiesTotal: mutation.archiveCopies.length,
        bytesCopiedThisRequest: batchBytes }, { status: 202, headers: { "cache-control": "no-store" } });
    }
    const commit = await store.commitGroup(mutation);
    return Response.json({ kind: "takosumi.source-ownership-migration.apply@v1",
      results: [{ ...observed, status: commit }] },
      { status: commit === "conflict" ? 409 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    // Raw diagnostics are intentionally not returned over HTTP. The operator
    // sees a stable failure code and can inspect the Worker log for the error.
    console.error("source ownership migration failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "source_ownership_migration_failed" }, { status: 500,
      headers: { "cache-control": "no-store" } });
  }
}

async function digestReport(preparedAt: string, results: readonly SourceOwnershipMigrationResult[]): Promise<string> {
  return `sha256:${await sha256HexOfStringAsync(JSON.stringify({ preparedAt, results }))}`;
}

async function signCopyReceipt(token: string, sourceId: string, preparedAt: string,
  reportDigest: string, cursor: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const material = JSON.stringify({ sourceId, preparedAt, reportDigest, cursor });
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** R2 object-key custody used only after a reviewed operator POST. */
export class R2SourceOwnershipArchiveCopier implements SourceOwnershipMigrationArchiveCopier {
  constructor(private readonly bucket: R2Bucket) {}

  async copyVerified(input: { readonly from: string; readonly to: string;
    readonly digest: string; readonly sizeBytes: number }): Promise<void> {
    if (!safeArchiveKey(input.from) || !safeArchiveKey(input.to) ||
      !/^sha256:[0-9a-f]{64}$/.test(input.digest) ||
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("invalid_source_archive_copy");
    }
    const existing = await this.bucket.get(input.to);
    if (existing) {
      await verifyObject(existing, input.digest, input.sizeBytes);
      return;
    }
    // Finish copying before readback, so the fallback byte buffer can be
    // released. Native R2 passes its body stream through without buffering.
    const result = await this.copyOriginal(input);
    if (!result) {
      const raced = await this.bucket.get(input.to);
      if (!raced) throw new Error(`source_archive_copy_lost:${input.to}`);
      await verifyObject(raced, input.digest, input.sizeBytes);
      return;
    }
    if (result.size !== input.sizeBytes) throw new Error(`source_archive_copy_size_mismatch:${input.to}`);
    const stored = await this.bucket.get(input.to);
    if (!stored) throw new Error(`source_archive_copy_readback_missing:${input.to}`);
    await verifyObject(stored, input.digest, input.sizeBytes);
  }

  private async copyOriginal(input: { readonly from: string; readonly to: string;
    readonly digest: string; readonly sizeBytes: number }) {
    const original = await this.bucket.get(input.from);
    if (!original) throw new Error("source_archive_missing");
    if (original.size !== input.sizeBytes) throw new Error("source_archive_size_mismatch");
    const value = original.body ?? await verifyObject(original, input.digest, input.sizeBytes);
    return await this.bucket.put(input.to, value, {
      sha256: input.digest.slice("sha256:".length),
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/zstd" },
      customMetadata: { "takosumi-digest": input.digest, "takosumi-migration": "source-split-v1" },
    });
  }

}

function safeArchiveKey(value: string): boolean {
  return /^workspaces\/[A-Za-z0-9_-]+\/sources\/[A-Za-z0-9_-]+\/snapshots\/[A-Za-z0-9_-]+\/source\.tar\.zst$/.test(value);
}

async function verifyObject(object: R2ObjectBody, digest: string, sizeBytes: number): Promise<Uint8Array> {
  if (object.size !== sizeBytes || object.size > MAX_ARCHIVE_BYTES) throw new Error("source_archive_size_mismatch");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const observed = await crypto.subtle.digest("SHA-256", bytes);
  const observedHex = Array.from(new Uint8Array(observed), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (`sha256:${observedHex}` !== digest) throw new Error("source_archive_digest_mismatch");
  return bytes;
}
