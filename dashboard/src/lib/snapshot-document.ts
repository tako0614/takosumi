/**
 * Read one repository-owned document out of a pinned Git SourceSnapshot.
 *
 * Two screens need this — the composition manifest picker and the
 * CapsuleSourceOptions picker — and each had grown its own copy of the same
 * five steps (pin a ref, register a Source, sync it, wait for the snapshot,
 * read the file). The copies had already drifted: only one of them pinned an
 * absent ref to the newest stable SemVer tag, and only one of them checked
 * that the snapshot it got back was the commit it asked for.
 *
 * Presentation stays with the callers; this owns the fetch and the two
 * provenance guarantees.
 */
import { t } from "../i18n/index.ts";
import {
  createSource,
  extractRunId,
  resolveStableSourceTag,
  syncSource,
  waitForLatestSourceSnapshot,
} from "./control-api.ts";

export interface SnapshotDocumentRequest<T> {
  readonly workspaceId: string;
  /** Prefix for the throwaway Source record's name. */
  readonly namePrefix: string;
  readonly git: string;
  /** Absent = pin the newest stable SemVer tag to its immutable commit. */
  readonly ref?: string | undefined;
  /** Path of the document inside the snapshot. */
  readonly path: string;
  readonly read: (
    sourceId: string,
    snapshotId: string,
    path: string,
  ) => Promise<T>;
}

export interface SnapshotDocumentResult<T> {
  readonly file: T;
  /** The immutable commit the bytes actually came from. */
  readonly commit: string;
  /** Set when the ref was derived rather than given. */
  readonly resolvedTag?: string;
}

export async function readSnapshotDocument<T>(
  request: SnapshotDocumentRequest<T>,
): Promise<SnapshotDocumentResult<T>> {
  const resolved = request.ref
    ? undefined
    : await resolveStableSourceTag(request.workspaceId, request.git);
  const exactRef = request.ref ?? resolved!.commit;
  const created = await createSource({
    workspaceId: request.workspaceId,
    name: `${request.namePrefix}-${crypto.randomUUID().slice(0, 8)}`,
    url: request.git,
    defaultRef: exactRef,
    defaultPath: ".",
    autoSync: false,
  });
  const sync = await syncSource(created.source.id);
  const snapshot = await waitForLatestSourceSnapshot(created.source.id, {
    runId: extractRunId(sync),
  });
  // A tag can move between resolution and sync; the bytes shown must be the
  // commit that was pinned, or nothing is shown at all.
  if (resolved && snapshot.resolvedCommit !== resolved.commit) {
    throw t("new.error.sourceRevisionMismatch");
  }
  const file = await request.read(created.source.id, snapshot.id, request.path);
  return {
    file,
    commit: snapshot.resolvedCommit,
    ...(resolved ? { resolvedTag: resolved.tag } : {}),
  };
}
