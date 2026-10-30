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
      /**
       * The Capsule that owns this Source and its trusted root. An `apps/`
       * root places the archive under it; a legacy root, or no owner (a
       * Workspace Source), keeps the Workspace layout. See
       * {@link ArtifactOwnerRoot}.
       */
      readonly owner?: ArtifactOwnerRoot;
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
       * Trusted Capsule root from `getCapsuleStorageRoot`: the persisted
       * `storage_root`, or for a row without one the legacy root derived from
       * the Capsule's frozen `scopeRef`. Core always passes it for a Capsule,
       * and Capsule allocations follow it. Only when it is omitted does the
       * allocator build the legacy root from `workspaceId`, which is right
       * only while that still equals the Capsule's scopeRef.
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
      /** The Capsule this backup belongs to and its trusted root; see the Source archive. */
      readonly owner?: ArtifactOwnerRoot;
    };

/**
 * A Capsule and its trusted artifact root: the persisted `storage_root` from
 * `getCapsuleStorageRoot`, or `apps/{id}` for an install reservation whose
 * Capsule is created later with exactly that root. Only an `apps/` root moves
 * a Source archive or backup out of the Workspace layout; a legacy root keeps
 * the key the Capsule has always used, byte for byte.
 */
export interface ArtifactOwnerRoot {
  readonly capsuleId: string;
  readonly storageRoot: string;
}

export interface ArtifactReferenceAllocator {
  allocate(input: ArtifactReferenceAllocation): string | Promise<string>;
}

/**
 * Reference allocator for object-key-backed hosts.
 *
 * These layouts are deliberately isolated in the storage adapter. The returned
 * values cross Core and runner contracts only as opaque `*Ref` strings. Capsule
 * allocations follow the persisted root ({@link capsuleArtifactRoot}), whether
 * it is an `apps/` root or a legacy Workspace-prefixed one. A Source archive
 * or backup of a Capsule with an `apps/` root goes under that root
 * (`apps/{cap}/sources/…`, `apps/{cap}/backups/…`); one of a legacy Capsule,
 * or with no Capsule, keeps its Workspace prefix. Resource coordinates retain
 * their Workspace prefix (Core allocates none). Historical references already
 * stored in immutable migration data remain opaque inputs.
 *
 * Source archives move only with `appSourceArchiveRoots`: the Runner image
 * validates the archive key it writes, and an image built before it accepted
 * `apps/` refuses that key, so the operator turns this on once the configured
 * image accepts it (`TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS`). Backups are written
 * by the Worker itself and always follow the owner.
 */
export class ObjectKeyArtifactReferenceAllocator implements ArtifactReferenceAllocator {
  readonly #appSourceArchiveRoots: boolean;

  constructor(options: { readonly appSourceArchiveRoots?: boolean } = {}) {
    this.#appSourceArchiveRoots = options.appSourceArchiveRoots === true;
  }

  allocate(input: ArtifactReferenceAllocation): string {
    switch (input.kind) {
      case "source_archive": {
        const owner = this.#appSourceArchiveRoots ? input.owner : undefined;
        return `${sourceArchiveRoot(input.workspaceId, input.sourceId, owner)}/snapshots/${segment(
          input.snapshotId,
        )}/source.tar.zst`;
      }
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
 * path: it must end in this Capsule's own segment, and no segment may be
 * empty or dots only (`.`, `..`), which a filesystem-backed store would
 * resolve as a path step.
 */
export function capsuleArtifactRoot(
  scopeRef: string,
  capsuleId: string,
  persistedRoot?: string,
): string {
  const capsuleSegment = segment(capsuleId);
  if (persistedRoot === undefined) {
    const scopeSegment = segment(scopeRef);
    if (!keySegment(scopeSegment) || !keySegment(capsuleSegment)) {
      throw new Error("Capsule artifact root is not canonical");
    }
    return `workspaces/${scopeSegment}/capsules/${capsuleSegment}`;
  }
  if (keySegment(capsuleSegment)) {
    if (persistedRoot === `apps/${capsuleSegment}` && capsuleId === capsuleSegment) {
      return persistedRoot;
    }
    const legacy = LEGACY_CAPSULE_ROOT.exec(persistedRoot);
    if (legacy && legacy[2] === capsuleSegment && keySegment(legacy[1]!)) {
      return persistedRoot;
    }
  }
  throw new Error("persisted Capsule storageRoot is not canonical");
}

const LEGACY_CAPSULE_ROOT =
  /^workspaces\/([a-zA-Z0-9._-]+)\/capsules\/([a-zA-Z0-9._-]+)$/u;

/** A non-empty object-key segment that is not a dot-only path step. */
function keySegment(value: string): boolean {
  return value.length > 0 && !/^\.+$/u.test(value);
}

/**
 * The owner's `apps/{cap}` root, or undefined when the owner keeps the
 * Workspace layout (no owner, or a legacy root). A root that is not this
 * Capsule's canonical root is refused, exactly as for state allocation.
 */
function ownerAppRoot(owner: ArtifactOwnerRoot | undefined): string | undefined {
  if (owner === undefined) return undefined;
  const root = capsuleArtifactRoot("", owner.capsuleId, owner.storageRoot);
  return root.startsWith("apps/") ? root : undefined;
}

/**
 * The prefix a backup goes under: the owner's `apps/` root; for a legacy
 * owner the Workspace segment of its frozen root (the Workspace id it was
 * written under, never the live one); else the allocation's Workspace.
 */
function backupScopeRoot(input: {
  readonly workspaceId: string;
  readonly owner?: ArtifactOwnerRoot;
}): string {
  if (input.owner === undefined) return `workspaces/${segment(input.workspaceId)}`;
  const root = capsuleArtifactRoot("", input.owner.capsuleId, input.owner.storageRoot);
  if (root.startsWith("apps/")) return root;
  return `workspaces/${LEGACY_CAPSULE_ROOT.exec(root)![1]!}`;
}

function sourceArchiveRoot(
  workspaceId: string,
  sourceId: string,
  owner: ArtifactOwnerRoot | undefined,
): string {
  const appRoot = ownerAppRoot(owner);
  return `${appRoot ?? `workspaces/${segment(workspaceId)}`}/sources/${segment(sourceId)}`;
}

/**
 * `TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS`: `enabled` allocates an app-owned
 * Source's new archives under its Capsule's `apps/` root; absent or `disabled`
 * keeps the Workspace layout. Any other value is refused at startup.
 */
export function appSourceArchiveRootsFromEnv(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "disabled") return false;
  if (value === "enabled") return true;
  throw new Error("TAKOSUMI_APP_SOURCE_ARCHIVE_ROOTS must be enabled or disabled");
}

/**
 * The prefixes under which a Source's archives can have been allocated, in
 * ascending key order: `apps/{owner}/sources/{src}/snapshots/` for an
 * app-owned Source, then the Workspace one every Source has had. A Source's
 * deletion custody covers exactly these prefixes. Because `apps/` sorts before
 * `workspaces/`, one ascending cursor walks both in turn.
 */
export function sourceArchiveCustodyPrefixes(source: {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerCapsuleId?: string;
}): readonly string[] {
  const legacy = `workspaces/${segment(source.workspaceId)}/sources/${segment(source.id)}/snapshots/`;
  const owner = source.ownerCapsuleId;
  if (owner === undefined || segment(owner) !== owner || !keySegment(owner)) return [legacy];
  return [`apps/${owner}/sources/${segment(source.id)}/snapshots/`, legacy];
}

/**
 * The snapshot segment of `{prefix}{snapshot}/source.tar.zst` under one of a
 * Source's custody prefixes, or undefined when the ref lies outside them.
 */
export function sourceArchiveSnapshotSegment(
  ref: string,
  prefixes: readonly string[],
): string | undefined {
  for (const prefix of prefixes) {
    if (!ref.startsWith(prefix)) continue;
    const suffix = ref.slice(prefix.length);
    const snapshotId = suffix.split("/")[0]!;
    if (/^[A-Za-z0-9._-]+$/u.test(snapshotId) && keySegment(snapshotId) &&
      suffix === `${snapshotId}/source.tar.zst`) return snapshotId;
  }
  return undefined;
}

function backupRef(
  input: {
    readonly workspaceId: string;
    readonly backupId: string;
    readonly owner?: ArtifactOwnerRoot;
  },
  name: string,
): string {
  return `${backupScopeRoot(input)}/backups/${segment(input.backupId)}/${name}`;
}

function segment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_");
}
