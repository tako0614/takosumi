/** Native R2 inventory producer. A private owner catalog freezes every writer
 * before this scans the complete physical bucket. A page count never proves EOF.
 */
import type { R2Bucket } from "./bindings.ts";
import {
  storedDigest, storedNativeVersion, storedObjectReference, storedServiceCall,
  StoredServiceUsageError, type StoredBucketRole, type StoredObjectOwnerPort,
} from "./stored-service-usage.ts";

export interface StoredInventoryFence {
  readonly sourceRef: string;
  readonly inventoryRef: string;
  readonly bucketRole: StoredBucketRole;
  readonly qualificationDigest: string;
  readonly fenceDigest: string;
  readonly phase: "inventory";
  readonly cursor: string | null;
}
export interface StoredInventoryFencePort {
  readStoredInventoryFence(input: { readonly bucketRole: StoredBucketRole; readonly inventoryRef: string }): Promise<StoredInventoryFence | null>;
}
export interface StoredInventoryPage {
  readonly sourceRef: string;
  readonly inventoryRef: string;
  readonly bucketRole: StoredBucketRole;
  readonly qualificationDigest: string;
  readonly fenceDigest: string;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly pageDigest: string;
  readonly objects: readonly { readonly objectRef: string; readonly workspaceId: string; readonly bytes: string; readonly versionDigest: string }[];
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PAGE_SIZE = 64;
function sameFence(left: StoredInventoryFence, right: StoredInventoryFence | null): boolean {
  return right !== null && left.sourceRef === right.sourceRef && left.inventoryRef === right.inventoryRef && left.bucketRole === right.bucketRole && left.qualificationDigest === right.qualificationDigest && left.fenceDigest === right.fenceDigest && left.phase === right.phase && left.cursor === right.cursor;
}
export function createStoredInventoryProducer(options: {
  readonly buckets: Readonly<Record<StoredBucketRole, R2Bucket | undefined>>;
  readonly fences: StoredInventoryFencePort;
  readonly owners: StoredObjectOwnerPort;
}) {
  return {
    async readStoredInventoryPage(input: { readonly bucketRole: StoredBucketRole; readonly inventoryRef: string; readonly cursor: string | null }): Promise<StoredInventoryPage> {
      if (!["state", "artifacts", "source", "backups"].includes(input.bucketRole) || typeof input.inventoryRef !== "string" || !ID.test(input.inventoryRef) || (input.cursor !== null && (typeof input.cursor !== "string" || input.cursor.length > 4096))) throw new StoredServiceUsageError();
      const bucket = options.buckets[input.bucketRole];
      if (!bucket) throw new StoredServiceUsageError();
      const fence = await storedServiceCall(() => options.fences.readStoredInventoryFence(input));
      if (!fence || fence.phase !== "inventory" || fence.bucketRole !== input.bucketRole || fence.inventoryRef !== input.inventoryRef || fence.cursor !== input.cursor || !ID.test(fence.sourceRef) || !DIGEST.test(fence.qualificationDigest) || !DIGEST.test(fence.fenceDigest)) throw new StoredServiceUsageError();
      const page = await storedServiceCall(() => bucket.list({ limit: PAGE_SIZE, ...(input.cursor === null ? {} : { cursor: input.cursor }), include: ["httpMetadata", "customMetadata"] }));
      if (!page || !Array.isArray(page.objects) || page.objects.length > PAGE_SIZE || typeof page.truncated !== "boolean" || (page.truncated && (typeof page.cursor !== "string" || !page.cursor || page.cursor === input.cursor))) throw new StoredServiceUsageError();
      const objects: StoredInventoryPage["objects"][number][] = [];
      const seen = new Set<string>();
      for (const object of page.objects) {
        const owner = await storedServiceCall(() => options.owners.resolveStoredObjectOwner({ bucketRole: input.bucketRole, key: object.key }));
        if (!owner || typeof owner.workspaceId !== "string" || !ID.test(owner.workspaceId)) throw new StoredServiceUsageError();
        const objectRef = await storedObjectReference(input.bucketRole, object.key, fence.sourceRef);
        if (seen.has(objectRef)) throw new StoredServiceUsageError();
        seen.add(objectRef);
        objects.push({ objectRef, workspaceId: owner.workspaceId, bytes: String(object.size), versionDigest: await storedNativeVersion(object) });
      }
      const nextCursor = page.truncated ? page.cursor! : null;
      const evidence = { sourceRef: fence.sourceRef, inventoryRef: input.inventoryRef, bucketRole: input.bucketRole, qualificationDigest: fence.qualificationDigest, fenceDigest: fence.fenceDigest, cursor: input.cursor, nextCursor, objects };
      if (!sameFence(fence, await storedServiceCall(() => options.fences.readStoredInventoryFence(input)))) throw new StoredServiceUsageError();
      return { ...evidence, pageDigest: await storedDigest(JSON.stringify(["takosumi.stored-service.inventory-page.v1", evidence])) };
    },
  };
}
