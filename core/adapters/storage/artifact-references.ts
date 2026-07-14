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
    }
  | {
      readonly kind: "raw_output";
      readonly workspaceId: string;
      readonly subject:
        | { readonly kind: "capsule"; readonly id: string }
        | { readonly kind: "resource"; readonly id: string };
      readonly runId: string;
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
 * values cross Core and runner contracts only as opaque `*Ref` strings. Current
 * allocations use canonical Workspace/Capsule/Resource vocabulary; historical
 * references already stored in immutable migration data remain opaque inputs.
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
        return `workspaces/${segment(input.workspaceId)}/${owner}/environments/${segment(
          input.environment,
        )}/state-versions/${generation}.tfstate.enc`;
      }
      case "raw_output": {
        const owner =
          input.subject.kind === "resource"
            ? `resources/${segment(input.subject.id)}`
            : `capsules/${segment(input.subject.id)}`;
        return `workspaces/${segment(input.workspaceId)}/${owner}/runs/${segment(
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
