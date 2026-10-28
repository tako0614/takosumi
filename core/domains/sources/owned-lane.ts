import type { Capsule } from "takosumi-contract/capsules";
import type { OpenTofuControlStore, StoredSource } from "../deploy-control/store.ts";
import { getCapsuleAdoptedSourceSnapshot } from "../deploy-control/capsule_source_revision.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

/** Converge from applied provenance, fencing both the Source and its owner. */
export async function convergeOwnedSourceLane(
  store: OpenTofuControlStore,
  sourceId: string,
  now: () => Date = () => new Date(),
): Promise<StoredSource | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const source = await store.getSource(sourceId);
    if (!source || source.status !== "active" || !source.ownerCapsuleId) return source;
    const capsule = await store.getCapsule(source.ownerCapsuleId);
    if (!capsule || capsule.status === "destroyed") return source;
    assertOwner(source, capsule);
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

function assertOwner(source: StoredSource, capsule: Capsule): void {
  if (capsule.id !== source.ownerCapsuleId || capsule.sourceId !== source.id ||
    capsule.workspaceId !== source.workspaceId) {
    throw new OpenTofuControllerError("failed_precondition", "Source owner does not match its app.", {
      reason: "source_owned_by_another_app",
    });
  }
}
