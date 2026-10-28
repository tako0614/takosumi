import type { Capsule } from "takosumi-contract/capsules";
import type { OpenTofuControlStore, StoredSource } from "../deploy-control/store.ts";
import { getCapsuleAdoptedSourceSnapshot } from "../deploy-control/capsule_source_revision.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { MAX_SOURCE_RECONCILIATION_CAPSULES } from "../deploy-control/source_sync_settlement.ts";

/** Converge from applied provenance, fencing both the Source and its owner. */
export async function convergeOwnedSourceLane(
  store: OpenTofuControlStore,
  sourceId: string,
  now: () => Date = () => new Date(),
): Promise<StoredSource | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const source = await store.getSource(sourceId);
    if (!source || source.status !== "active") return source;
    const capsule = source.ownerCapsuleId
      ? await store.getCapsule(source.ownerCapsuleId)
      : await soleLiveReferencingCapsule(store, source);
    if (!capsule || !isLiveSourceLaneCapsule(capsule)) return source;
    assertOwner(source, capsule, source.ownerCapsuleId !== undefined);
    const adopted = await getCapsuleAdoptedSourceSnapshot(store, capsule);
    if (!adopted || (source.defaultRef === adopted.ref && source.defaultPath === adopted.path)) return source;
    const result = await store.writeSourceConfiguration({
      source: { ...source, defaultRef: adopted.ref, defaultPath: adopted.path, updatedAt: now().toISOString() },
      expectedSource: source,
      expectedOwnerCapsule: capsule,
    });
    if (result.status !== "conflict") return result.source;
  }
  throw new OpenTofuControllerError("failed_precondition", "The app changed while converging its Git lane.", {
    reason: "source_lane_conflict",
  });
}

async function soleLiveReferencingCapsule(
  store: OpenTofuControlStore,
  source: StoredSource,
): Promise<Capsule | undefined> {
  const capsules = await store.listCapsulesForSource(source.workspaceId, source.id);
  if (capsules.length > MAX_SOURCE_RECONCILIATION_CAPSULES) {
    throw new OpenTofuControllerError("resource_exhausted",
      `Source reconciliation exceeds ${MAX_SOURCE_RECONCILIATION_CAPSULES} Capsules`,
      { reason: "source_reconciliation_capsule_limit" });
  }
  const live = capsules.filter((capsule) => capsule.status !== "destroyed");
  if (live.length > 1) return undefined;
  return live[0];
}

export function isLiveSourceLaneCapsule(capsule: Capsule): boolean {
  return capsule.status !== "destroyed" && capsule.status !== "disabled" && capsule.status !== "uninstalled";
}

function assertOwner(source: StoredSource, capsule: Capsule, owned: boolean): void {
  if ((owned && capsule.id !== source.ownerCapsuleId) || capsule.sourceId !== source.id ||
    capsule.workspaceId !== source.workspaceId) {
    throw new OpenTofuControllerError("failed_precondition", "Source owner does not match its app.", {
      reason: "source_owned_by_another_app",
    });
  }
}
