/**
 * One-time operator backfill (TASK-0118 9.1): record `createdUnder:
 * "operator"` on the Capsule-owned Interfaces that the legacy Output
 * migration created before writes were recorded.
 *
 * Such an Interface is identified only by the migration's own durable
 * evidence: an `interface.output_convention_migrated` Activity event on the
 * Capsule lists its id in `metadata.interfaceIds` and the digest of its spec
 * at migration time in `metadata.interfaceSpecDigests`. A listed Interface is
 * marked only when it is still Capsule-owned by that Capsule in that
 * partition, carries no `createdUnder` and no `materializedFrom` (blueprint
 * Interfaces are already the app's own), and its spec still has a recorded
 * digest — an Interface changed since the migration stays for the owner's
 * review. Without this, owners would see those Interfaces in `needsReview`
 * and the app's Workspace-free token would not count them.
 *
 * The plan is read-only and digest-confirmed; apply re-plans, refuses a
 * different digest, and compare-and-sets each exact reviewed row, so a
 * second run finds nothing to do. It only writes `metadata.createdUnder`.
 */
import type { Interface } from "takosumi-contract";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import type { InterfaceStore } from "./stores.ts";

export const LEGACY_OUTPUT_MIGRATION_EVIDENCE_ACTION = "interface.output_convention_migrated";

export interface LegacyOutputProvenanceContext {
  readonly control: Pick<OpenTofuControlStore, "listCapsules" | "listActivityEventsForTargetPage">;
  readonly interfaces: Pick<InterfaceStore, "get" | "compareAndSet">;
}

export interface LegacyOutputProvenanceMark {
  readonly interfaceId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly evidenceEventId: string;
  readonly generation: number;
  readonly resolvedRevision: number;
  /** Digest of the exact reviewed row; apply writes only that row. */
  readonly recordDigest: string;
}

export type LegacyOutputProvenanceSkipReason =
  | "missing"
  | "not_capsule_owned_here"
  | "materialized"
  | "already_recorded"
  | "spec_changed";

export interface LegacyOutputProvenancePlan {
  readonly marks: readonly LegacyOutputProvenanceMark[];
  readonly skipped: readonly {
    readonly interfaceId: string;
    readonly evidenceEventId: string;
    readonly reason: LegacyOutputProvenanceSkipReason;
  }[];
  readonly digest: string;
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

/** Dry-run: reads Capsules, their migration evidence and the listed Interfaces. */
export async function planLegacyOutputInterfaceProvenance(
  context: LegacyOutputProvenanceContext,
): Promise<LegacyOutputProvenancePlan> {
  const marks = new Map<string, LegacyOutputProvenanceMark>();
  const skipped = new Map<string, LegacyOutputProvenancePlan["skipped"][number]>();
  const capsules = [...await context.control.listCapsules()].sort((a, b) => a.id.localeCompare(b.id));
  for (const capsule of capsules) {
    let cursor: string | undefined;
    do {
      const page = await context.control.listActivityEventsForTargetPage(
        capsule.workspaceId,
        "capsule",
        capsule.id,
        { limit: 100, ...(cursor ? { cursor } : {}) },
      );
      for (const event of page.items) {
        if (event.action !== LEGACY_OUTPUT_MIGRATION_EVIDENCE_ACTION) continue;
        if (event.workspaceId !== capsule.workspaceId || event.targetId !== capsule.id) continue;
        const specDigests = new Set(strings(event.metadata.interfaceSpecDigests));
        for (const interfaceId of strings(event.metadata.interfaceIds)) {
          if (marks.has(interfaceId) || skipped.has(interfaceId)) continue;
          const skip = (reason: LegacyOutputProvenanceSkipReason) =>
            skipped.set(interfaceId, { interfaceId, evidenceEventId: event.id, reason });
          const iface = await context.interfaces.get(interfaceId);
          if (!iface) { skip("missing"); continue; }
          if (
            iface.metadata.workspaceId !== capsule.workspaceId ||
            iface.metadata.ownerRef.kind !== "Capsule" ||
            iface.metadata.ownerRef.id !== capsule.id
          ) { skip("not_capsule_owned_here"); continue; }
          if (iface.metadata.materializedFrom !== undefined) { skip("materialized"); continue; }
          if (iface.metadata.createdUnder !== undefined) { skip("already_recorded"); continue; }
          if (!specDigests.has(await stableJsonDigest(iface.spec))) { skip("spec_changed"); continue; }
          marks.set(interfaceId, {
            interfaceId,
            workspaceId: capsule.workspaceId,
            capsuleId: capsule.id,
            evidenceEventId: event.id,
            generation: iface.metadata.generation,
            resolvedRevision: iface.status.resolvedRevision,
            recordDigest: await stableJsonDigest(iface),
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  const plan = {
    marks: [...marks.values()].sort((a, b) => a.interfaceId.localeCompare(b.interfaceId)),
    skipped: [...skipped.values()].sort((a, b) => a.interfaceId.localeCompare(b.interfaceId)),
  };
  return { ...plan, digest: await stableJsonDigest(plan) };
}

/** Apply the reviewed plan: refuses another digest; idempotent. */
export async function applyLegacyOutputInterfaceProvenance(
  context: LegacyOutputProvenanceContext,
  expectedDigest: string,
): Promise<{ readonly applied: number }> {
  const plan = await planLegacyOutputInterfaceProvenance(context);
  if (plan.digest !== expectedDigest) {
    throw new Error("Legacy Output Interface provenance changed since the reviewed dry-run; generate a new plan");
  }
  let applied = 0;
  for (const mark of plan.marks) {
    const current = await context.interfaces.get(mark.interfaceId);
    if (
      !current ||
      current.metadata.createdUnder !== undefined ||
      (await stableJsonDigest(current)) !== mark.recordDigest
    ) {
      throw new Error(`Interface ${mark.interfaceId} changed since the reviewed dry-run; generate a new plan`);
    }
    const next: Interface = { ...current, metadata: { ...current.metadata, createdUnder: "operator" } };
    const wrote = await context.interfaces.compareAndSet(next, {
      generation: mark.generation,
      resolvedRevision: mark.resolvedRevision,
      record: current,
    });
    if (!wrote) throw new Error(`Interface ${mark.interfaceId} changed concurrently; generate a new plan`);
    applied++;
  }
  return { applied };
}
