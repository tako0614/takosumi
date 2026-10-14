import { WorkerEntrypoint } from "cloudflare:workers";
import type { R2Bucket } from "./bindings.ts";
import { createStoredInventoryProducer, type StoredInventoryFencePort } from "./artifact-storage-inventory.ts";
import type { StoredBucketRole, StoredObjectOwnerPort } from "./stored-service-usage.ts";

export interface StoredInventoryWorkerEnv {
  readonly R2_STATE?: R2Bucket;
  readonly R2_ARTIFACTS?: R2Bucket;
  readonly R2_SOURCE?: R2Bucket;
  readonly R2_BACKUPS?: R2Bucket;
  readonly TAKOSUMI_STORED_INVENTORY_FENCES: StoredInventoryFencePort;
  readonly TAKOSUMI_STORED_OBJECT_OWNERS: StoredObjectOwnerPort;
}
/** Dormant owner-composed inventory role. No public or catalog-admin route. */
export class PrivateStoredInventoryWorker extends WorkerEntrypoint<StoredInventoryWorkerEnv> {
  fetch(): Response { return new Response(null, { status: 404 }); }
  readStoredInventoryPage(input: { readonly bucketRole: StoredBucketRole; readonly inventoryRef: string; readonly cursor: string | null }) {
    return createStoredInventoryProducer({
      buckets: { state: this.env.R2_STATE, artifacts: this.env.R2_ARTIFACTS, source: this.env.R2_SOURCE, backups: this.env.R2_BACKUPS },
      fences: this.env.TAKOSUMI_STORED_INVENTORY_FENCES,
      owners: this.env.TAKOSUMI_STORED_OBJECT_OWNERS,
    }).readStoredInventoryPage(input);
  }
}
