/** Explicit operator composition for the complete staging physical stores.
 * Selection is not qualification: Hosted's published source/fence capabilities
 * still refuse missing, expired or unqualified physical graph evidence. */
import type { CloudflareWorkerEnv } from "./worker.ts";
import { createStoredObjectOwnerResolver } from "../../worker/src/stored-object-owner-resolver.ts";
import { storedDigest, StoredServiceUsageError } from "../../worker/src/stored-service-usage.ts";
import { WorkspacesService } from "../../core/domains/workspaces/mod.ts";
import { createCloudflareD1OpenTofuControlStore } from "../../worker/src/d1_opentofu_store.ts";
import { decodeCursor } from "takosumi-contract/pagination";
import { OpenTofuControllerError } from "../../core/domains/deploy-control/errors.ts";

export const OSS_STORAGE_STAGING_PROFILE = "stored-service-staging-v1";
export interface StorageStagingEnv extends CloudflareWorkerEnv {
  readonly TAKOSUMI_OSS_STORAGE_PROFILE?: string;
  readonly TAKOSUMI_STORED_INVENTORY_FENCES?: import("../../worker/src/artifact-storage-inventory.ts").StoredInventoryFencePort;
  readonly TAKOSUMI_VERSION_METADATA?: { readonly id?: unknown };
  readonly TAKOSUMI_STORAGE_PRIVATE_RUN_FILE_PREFIX?: string;
  readonly TAKOSUMI_STORED_ORIGINAL_OWNERS?: import("../../worker/src/stored-object-owner-resolver.ts").StoredOriginalObjectOwnerPort;
}

const composed = new WeakMap<StorageStagingEnv, StorageStagingEnv>();
export function composeStorageStagingEnv(env: StorageStagingEnv): StorageStagingEnv {
  if (env.TAKOSUMI_OSS_STORAGE_PROFILE === undefined) return env;
  if (env.TAKOSUMI_OSS_STORAGE_PROFILE !== OSS_STORAGE_STAGING_PROFILE || env.TAKOSUMI_ENVIRONMENT !== "staging" || env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE !== "predeployed" || !nativeVersion(env) || !env.TAKOSUMI_CONTROL_DB || !env.R2_STATE || !env.R2_ARTIFACTS || !env.R2_SOURCE || !env.R2_BACKUPS || !env.TAKOSUMI_STORED_SERVICE_USAGE || !env.TAKOSUMI_STORED_INVENTORY_FENCES || !env.TAKOSUMI_STORED_ORIGINAL_OWNERS || env.TAKOSUMI_STORED_OBJECT_OWNERS || env.TAKOSUMI_ARTIFACT_STORAGE_USAGE) throw new StoredServiceUsageError();
  const existing = composed.get(env);
  if (existing) return existing;
  const result: StorageStagingEnv = {
    ...env,
    TAKOSUMI_STORED_OBJECT_OWNERS: createStoredObjectOwnerResolver({
      database: env.TAKOSUMI_CONTROL_DB,
      buckets: { state: env.R2_STATE, artifacts: env.R2_ARTIFACTS, source: env.R2_SOURCE, backups: env.R2_BACKUPS },
      privateRunFilePrefix: env.TAKOSUMI_STORAGE_PRIVATE_RUN_FILE_PREFIX,
      originalOwners: env.TAKOSUMI_STORED_ORIGINAL_OWNERS,
      sources: env.TAKOSUMI_STORED_SERVICE_USAGE,
    }),
  };
  composed.set(env, result);
  return result;
}

/** Only this native version_metadata binding is runtime identity evidence. */
export async function readStorageRuntimeVersion(env: Pick<StorageStagingEnv, "TAKOSUMI_VERSION_METADATA">): Promise<{ readonly versionIdSha256: string } | null> {
  const version = nativeVersion(env);
  return version === null ? null : { versionIdSha256: await storedDigest(version) };
}
function nativeVersion(env: Pick<StorageStagingEnv, "TAKOSUMI_VERSION_METADATA">): string | null {
  const id = env.TAKOSUMI_VERSION_METADATA?.id;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id) ? id : null;
}

/** Narrow read facade over the actual WorkspacesService. Constructing this
 * service performs no schema bootstrap, membership repair or identity write. */
export function storageWorkspacesReader(env: StorageStagingEnv) {
  requireProfile(env);
  const workspaces = new WorkspacesService({
    store: createCloudflareD1OpenTofuControlStore(env.TAKOSUMI_CONTROL_DB, { schemaMode: "predeployed" }),
  });
  return {
    async readStorageWorkspace(input: { readonly workspaceId: string }): Promise<{ readonly workspaceId: string } | null> {
      if (!input || !validId(input.workspaceId)) throw new StoredServiceUsageError();
      try {
        const workspace = await workspaces.getWorkspace(input.workspaceId);
        if (workspace.id !== input.workspaceId) throw new StoredServiceUsageError();
        return { workspaceId: workspace.id };
      } catch (error) {
        if (error instanceof OpenTofuControllerError && error.code === "not_found") return null;
        throw new StoredServiceUsageError();
      }
    },
    async listStorageWorkspacesPage(input: { readonly cursor?: string; readonly limit: number }): Promise<{ readonly items: readonly { readonly workspaceId: string }[]; readonly nextCursor: string | null }> {
      if (!input || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64 || input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096 || !decodeCursor(input.cursor))) throw new StoredServiceUsageError();
      const page = await workspaces.listWorkspacesPage({ limit: input.limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
      if (page.items.length > input.limit || page.items.some(workspace => !validId(workspace.id)) || page.nextCursor !== undefined && (page.nextCursor === input.cursor || !decodeCursor(page.nextCursor))) throw new StoredServiceUsageError();
      return { items: page.items.map(workspace => ({ workspaceId: workspace.id })), nextCursor: page.nextCursor ?? null };
    },
  };
}
export function requireStorageStagingProfile(env: StorageStagingEnv): void { requireProfile(env); }
function requireProfile(env: StorageStagingEnv): void {
  if (env.TAKOSUMI_OSS_STORAGE_PROFILE !== OSS_STORAGE_STAGING_PROFILE) throw new StoredServiceUsageError();
  composeStorageStagingEnv(env);
}
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value); }
