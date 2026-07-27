/**
 * Read-only compatibility for immutable source archives written before the
 * Workspace/Capsule storage-key migration. New allocation and source-sync
 * reuse must continue to require the current `workspaces/` layout; this helper
 * is called only while restoring a digest-pinned persisted SourceSnapshot.
 */
const LEGACY_SOURCE_ARCHIVE =
  /^spaces\/space_[0-9A-Za-z]{8,64}\/sources\/src_[0-9A-Za-z]{8,64}\/snapshots\/snap_[0-9A-Za-z]{8,64}\/source\.tar\.zst$/u;
const LEGACY_UPLOAD_ARCHIVE =
  /^spaces\/space_[0-9A-Za-z]{8,64}\/uploads\/snap_[0-9A-Za-z]{8,64}\/source\.tar\.zst$/u;

export function isLegacySourceArchiveRestoreRef(ref: string): boolean {
  return LEGACY_SOURCE_ARCHIVE.test(ref) || LEGACY_UPLOAD_ARCHIVE.test(ref);
}
