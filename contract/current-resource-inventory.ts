/**
 * The OSS-owned, value-free inventory recorded by the current Capsule apply
 * lineage. This is deliberately a projection of reviewed OpenTofu plan data,
 * not a live provider read or Resource Shape mutation surface.
 */

export const CAPSULE_CURRENT_RESOURCE_INVENTORY_KIND =
  "takosumi.capsule-current-resource-inventory@v1" as const;

export type CapsuleCurrentResourceInventoryResource = {
  readonly address: string;
  readonly type: string;
  /** Explicit provider source from OpenTofu, when the plan recorded one. */
  readonly providerSource?: string;
};

export type CapsuleCurrentResourceInventory = {
  readonly kind: typeof CAPSULE_CURRENT_RESOURCE_INVENTORY_KIND;
  readonly capsuleId: string;
  readonly workspaceId: string;
  readonly environment: string;
  readonly stateVersionId: string;
  readonly generation: number;
  readonly applyRunId: string;
  readonly planRunId: string;
  readonly recordedAt: string;
} &
  (
    | {
        /** The current plan recorded a complete, value-free inventory. */
        readonly availability: "recorded";
        readonly resources: readonly CapsuleCurrentResourceInventoryResource[];
      }
    | {
        /** Legacy plans have no persisted resource-change projection. */
        readonly availability: "legacy_unavailable";
      }
  );

export interface CapsuleCurrentResourceInventoryResponse {
  readonly inventory: CapsuleCurrentResourceInventory;
}
