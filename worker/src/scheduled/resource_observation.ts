/**
 * Bounded scheduled Resource Shape observation.
 *
 * Candidate selection is a durable global lease over the canonical Resource
 * rows. The sweep never creates a second lifecycle ledger and never applies or
 * refreshes desired state: it invokes the Resource Shape service's read-only
 * observe path, which records a first-class drift-check Run and CAS-fences the
 * resulting conditions against concurrent apply/delete work.
 */

import type { ActorContext } from "takosumi-contract";
import type {
  ResourceObservationClaimInput,
  ResourceShapeRecord,
  ResourceShapeRecordId,
} from "../../../core/domains/resource-shape/mod.ts";

export const RESOURCE_OBSERVATION_DEFAULT_LIMIT = 8;
export const RESOURCE_OBSERVATION_DEFAULT_CONCURRENCY = 4;
export const RESOURCE_OBSERVATION_DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
export const RESOURCE_OBSERVATION_DEFAULT_LEASE_MS = 15 * 60 * 1000;

/** Narrow facade supplied by the composition root. */
export interface ResourceObservationOperations {
  claimCandidate(
    input: ResourceObservationClaimInput,
  ): Promise<ResourceShapeRecord | undefined>;
  /** Returns true only when the canonical observe operation succeeds. */
  observe(resource: ResourceShapeRecord, actor: ActorContext): Promise<boolean>;
  finishClaim(
    resourceId: ResourceShapeRecordId,
    leaseId: string,
    attemptedAt: string,
  ): Promise<boolean>;
}

export interface ResourceObservationSweepOptions {
  /** Maximum Resources claimed in one cron tick. */
  readonly limit?: number;
  /** Maximum observations running at once. */
  readonly concurrency?: number;
  /** Minimum cadence between completed attempts for one Resource. */
  readonly intervalMs?: number;
  /** Time after which another isolate may reclaim an abandoned claim. */
  readonly leaseMs?: number;
  /** Test seam; production uses the current wall clock. */
  readonly now?: () => Date;
  /** Test seam; production uses a cryptographically random lease token. */
  readonly createLeaseId?: () => string;
}

export interface ResourceObservationSweepResult {
  readonly claimed: number;
  readonly observed: number;
  readonly failed: number;
  readonly leaseLost: number;
  readonly claimErrors: number;
}

const EMPTY_RESULT: ResourceObservationSweepResult = {
  claimed: 0,
  observed: 0,
  failed: 0,
  leaseLost: 0,
  claimErrors: 0,
};

/**
 * Observes globally due Resources with just-in-time claims. Each worker claims
 * only when it has capacity, so a queued item cannot age through the lease
 * while waiting behind an earlier slow backend. Per-Resource failures are
 * isolated and every completed attempt releases only its exact lease token.
 */
export async function resourceObservationSweep(
  operations: ResourceObservationOperations,
  options: ResourceObservationSweepOptions = {},
): Promise<ResourceObservationSweepResult> {
  const limit = explicitPositiveInteger(
    options.limit,
    RESOURCE_OBSERVATION_DEFAULT_LIMIT,
  );
  if (limit === 0) return EMPTY_RESULT;
  const concurrency = Math.min(
    limit,
    explicitPositiveInteger(
      options.concurrency,
      RESOURCE_OBSERVATION_DEFAULT_CONCURRENCY,
    ),
  );
  const intervalMs = positiveDuration(
    options.intervalMs,
    RESOURCE_OBSERVATION_DEFAULT_INTERVAL_MS,
  );
  const leaseMs = positiveDuration(
    options.leaseMs,
    RESOURCE_OBSERVATION_DEFAULT_LEASE_MS,
  );
  const now = options.now ?? (() => new Date());
  const createLeaseId =
    options.createLeaseId ??
    (() => `resource-observation:${crypto.randomUUID()}`);

  let slotsClaimed = 0;
  let claimed = 0;
  let observed = 0;
  let failed = 0;
  let leaseLost = 0;
  let claimErrors = 0;

  const worker = async (): Promise<void> => {
    while (slotsClaimed < limit) {
      // JavaScript executes this increment synchronously before the first await,
      // so workers cannot consume the same bounded slot.
      slotsClaimed += 1;
      const claimTime = validDate(now());
      const leaseId = createLeaseId();
      let resource: ResourceShapeRecord | undefined;
      try {
        resource = await operations.claimCandidate({
          leaseId,
          claimedAt: claimTime.toISOString(),
          dueBefore: new Date(claimTime.getTime() - intervalMs).toISOString(),
          staleClaimBefore: new Date(
            claimTime.getTime() - leaseMs,
          ).toISOString(),
        });
      } catch {
        claimErrors += 1;
        return;
      }
      if (!resource) return;
      claimed += 1;

      const actor: ActorContext = {
        actorAccountId: "takosumi-resource-observer",
        roles: ["system"],
        requestId: leaseId,
        principalKind: "system",
      };
      try {
        // Keep the Resource's declared scope identity intact. The canonical
        // service and adapter own execution mapping; this scheduler invents no
        // separate ownership projection.
        if (await operations.observe(resource, actor)) observed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      } finally {
        try {
          const finished = await operations.finishClaim(
            resource.id,
            leaseId,
            validDate(now()).toISOString(),
          );
          if (!finished) leaseLost += 1;
        } catch {
          leaseLost += 1;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { claimed, observed, failed, leaseLost, claimErrors };
}

function explicitPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Resource observation clock returned an invalid Date");
  }
  return value;
}
