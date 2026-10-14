/** Separate entry bytes. The ordinary platform entry and its exports do not
 * activate this profile or expose these private storage read roles. */
import platformEntry, {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject as PlatformOpenTofuRunnerObject,
  TakosumiRuntimeBindingMaterializerEntrypoint,
} from "./entry-worker.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createStoredInventoryProducer } from "../../worker/src/artifact-storage-inventory.ts";
import type { StoredBucketRole } from "../../worker/src/stored-service-usage.ts";
import { composeStorageStagingEnv, readStorageRuntimeVersion, requireStorageStagingProfile, storageWorkspacesReader, type StorageStagingEnv } from "./storage-staging-profile.ts";
import type { PlatformExecutionContext } from "./worker.ts";

export { CoordinationObject, LocalSubstrateOpenTofuRunnerProxyObject, OpenTofuRunOwnerObject, TakosumiRuntimeBindingMaterializerEntrypoint };

/** The same local owner resolver is installed in the actual Container DO. */
export class OpenTofuRunnerObject extends PlatformOpenTofuRunnerObject {
  constructor(ctx: ConstructorParameters<typeof PlatformOpenTofuRunnerObject>[0], env: StorageStagingEnv) {
    requireStorageStagingProfile(env);
    super(ctx, composeStorageStagingEnv(env));
  }
}
export class PrivateStoredInventoryWorker extends WorkerEntrypoint<StorageStagingEnv> {
  fetch(): Response { return new Response(null, { status: 404 }); }
  readStoredInventoryPage(input: { readonly bucketRole: StoredBucketRole; readonly inventoryRef: string; readonly cursor: string | null }) {
    requireStorageStagingProfile(this.env);
    const env = composeStorageStagingEnv(this.env);
    return createStoredInventoryProducer({
      buckets: { state: env.R2_STATE, artifacts: env.R2_ARTIFACTS, source: env.R2_SOURCE, backups: env.R2_BACKUPS },
      fences: env.TAKOSUMI_STORED_INVENTORY_FENCES!, owners: env.TAKOSUMI_STORED_OBJECT_OWNERS!,
    }).readStoredInventoryPage(input);
  }
}
export class PrivateStorageWorkspaceWorker extends WorkerEntrypoint<StorageStagingEnv> {
  fetch(): Response { return new Response(null, { status: 404 }); }
  readStorageWorkspace(input: { readonly workspaceId: string }) { return storageWorkspacesReader(this.env).readStorageWorkspace(input); }
  listStorageWorkspacesPage(input: { readonly cursor?: string; readonly limit: number }) { return storageWorkspacesReader(this.env).listStorageWorkspacesPage(input); }
  readStorageRuntimeVersion() { return readStorageRuntimeVersion(this.env); }
}

export default {
  fetch(request: Request, env: StorageStagingEnv, context?: PlatformExecutionContext): Promise<Response> {
    requireStorageStagingProfile(env);
    return platformEntry.fetch(request, composeStorageStagingEnv(env), context);
  },
  scheduled(event: unknown, env: StorageStagingEnv, context?: PlatformExecutionContext): Promise<void> {
    requireStorageStagingProfile(env);
    return platformEntry.scheduled(event, composeStorageStagingEnv(env), context);
  },
};
