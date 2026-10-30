/**
 * Host-owned allocation port for durable artifact references.
 *
 * Core requests a reference for a logical artifact and treats the returned
 * string as opaque. It must never reconstruct a bucket name, object key, URL,
 * or storage scheme from the request fields. Storage adapters are free to map
 * the opaque reference to an R2 key, filesystem path, database row, remote
 * object id, or another durable coordinate.
 */
export type ArtifactReferenceAllocation =
  | {
      readonly kind: "source_archive";
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly snapshotId: string;
    }
  | {
      readonly kind: "state";
      readonly workspaceId: string;
      readonly subject:
        | { readonly kind: "capsule"; readonly id: string }
        | { readonly kind: "resource"; readonly id: string };
      readonly environment: string;
      readonly generation: number;
      /**
       * Trusted persisted Capsule root (`getCapsuleStorageRoot`). Capsule
       * allocations follow it, never the live Workspace id; absent only for a
       * pre-v77 Capsule, whose legacy root then uses `workspaceId`.
       */
      readonly storageRoot?: string;
    }
  | {
      readonly kind: "raw_output";
      readonly workspaceId: string;
      readonly subject:
        | { readonly kind: "capsule"; readonly id: string }
        | { readonly kind: "resource"; readonly id: string };
      readonly runId: string;
      /** Trusted persisted Capsule root; see the `state` allocation. */
      readonly storageRoot?: string;
    }
  | {
      readonly kind:
        | "backup_control"
        | "backup_state"
        | "backup_artifacts_manifest"
        | "backup_service_data";
      readonly workspaceId: string;
      readonly backupId: string;
    };

export interface ArtifactReferenceAllocator {
  allocate(input: ArtifactReferenceAllocation): string | Promise<string>;
}

/**
 * Reference allocator for object-key-backed hosts.
 *
 * These layouts are deliberately isolated in the storage adapter. The returned
 * values cross Core and runner contracts only as opaque `*Ref` strings. Capsule
 * allocations follow the persisted root ({@link capsuleArtifactRoot}), whether
 * it is an `apps/` root or a legacy Workspace-prefixed one; Resource
 * coordinates retain their Workspace prefix. Historical references already
 * stored in immutable migration data remain opaque inputs.
 */
export class ObjectKeyArtifactReferenceAllocator implements ArtifactReferenceAllocator {
  allocate(input: ArtifactReferenceAllocation): string {
    switch (input.kind) {
      case "source_archive":
        return `workspaces/${segment(input.workspaceId)}/sources/${segment(
          input.sourceId,
        )}/snapshots/${segment(input.snapshotId)}/source.tar.zst`;
      case "state": {
        const generation = String(input.generation).padStart(8, "0");
        const owner =
          input.subject.kind === "resource"
            ? `resources/${segment(input.subject.id)}`
            : `capsules/${segment(input.subject.id)}`;
        const root = input.subject.kind === "capsule"
          ? capsuleArtifactRoot(input.workspaceId, input.subject.id, input.storageRoot)
          : `workspaces/${segment(input.workspaceId)}/${owner}`;
        return `${root}/environments/${segment(
          input.environment,
        )}/state-versions/${generation}.tfstate.enc`;
      }
      case "raw_output": {
        const owner =
          input.subject.kind === "resource"
            ? `resources/${segment(input.subject.id)}`
            : `capsules/${segment(input.subject.id)}`;
        const root = input.subject.kind === "capsule"
          ? capsuleArtifactRoot(input.workspaceId, input.subject.id, input.storageRoot)
          : `workspaces/${segment(input.workspaceId)}/${owner}`;
        return `${root}/runs/${segment(
          input.runId,
        )}/outputs.raw.json.enc`;
      }
      case "backup_control":
        return backupRef(input, "control.json.zst.enc");
      case "backup_state":
        return backupRef(input, "state.tar.zst.enc");
      case "backup_artifacts_manifest":
        return backupRef(input, "artifacts.manifest.json");
      case "backup_service_data":
        return backupRef(input, "service-data.tar.zst.enc");
    }
  }
}

/**
 * A Capsule's artifact root.
 *
 * The persisted root (`capsules.storage_root`) is the authority: `apps/{cap}`
 * for a Capsule created after ownership expansion, or the legacy
 * `workspaces/{ws}/capsules/{cap}` root the ownership backfill froze. The
 * legacy Workspace segment is history: it is returned as stored and never
 * rebuilt from, or compared with, a live Workspace id, so moving or removing
 * Workspace cannot move an artifact key. Only a row with no persisted root
 * (before the v77 column existed) derives the legacy root, from the Capsule's
 * frozen `scopeRef` (`capsuleScopeRef`), which is the Workspace id that root
 * was written under.
 *
 * A persisted root is still an exact Capsule identity, never a free-form R2
 * path: it must end in this Capsule's own segment.
 */
export function capsuleArtifactRoot(
  scopeRef: string,
  capsuleId: string,
  persistedRoot?: string,
): string {
  const capsuleSegment = segment(capsuleId);
  if (persistedRoot === undefined) {
    return `workspaces/${segment(scopeRef)}/capsules/${capsuleSegment}`;
  }
  if (persistedRoot === `apps/${capsuleSegment}` && capsuleId === capsuleSegment) {
    return persistedRoot;
  }
  const legacy = LEGACY_CAPSULE_ROOT.exec(persistedRoot);
  if (legacy && legacy[2] === capsuleSegment && !/^\.+$/u.test(legacy[1]!)) {
    return persistedRoot;
  }
  throw new Error("persisted Capsule storageRoot is not canonical");
}

const LEGACY_CAPSULE_ROOT =
  /^workspaces\/([a-zA-Z0-9._-]+)\/capsules\/([a-zA-Z0-9._-]+)$/u;

function backupRef(
  input: { readonly workspaceId: string; readonly backupId: string },
  name: string,
): string {
  return `workspaces/${segment(input.workspaceId)}/backups/${segment(
    input.backupId,
  )}/${name}`;
}

function segment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_");
}
