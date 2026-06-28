/**
 * Source domain contract.
 *
 * A Source is a Workspace-scoped registration of a Git repository that Takosumi can
 * resolve to an immutable archive snapshot. Takosumi core is GitHub-agnostic: it
 * knows only a {@link GitAddress} (`{ url, ref, path, credentialId }`) and never
 * a forge-specific manifest. There is no custom manifest in user repos; every
 * service-side concern is DB config on the Source / Connection / InstallConfig records.
 *
 * Resolution never happens from the trusted Worker: registration validates shape
 * + URL policy and stores the Source `active`; the actual `git ls-remote` /
 * archive fetch runs in the untrusted Runner Container via a `source_sync` run.
 *
 * Security invariants enforced elsewhere but recorded here for the type seam:
 *   - The source phase mints ONLY git-kind credentials (never provider creds).
 *   - The public Source/SourceSnapshot types NEVER carry secret values; the hook
 *     secret is stored hashed and returned exactly once at creation.
 */

import { API_V1_PREFIX, INTERNAL_V1_PREFIX } from "./api-surface.ts";

/**
 * GitHub-agnostic Git coordinate. The only repository identity Takosumi core
 * understands. `credentialId` references a `source_git_*` Connection (none for a
 * public repo). `path` is the Capsule path within the repo (defaults to `"."`).
 */
export interface GitAddress {
  readonly url: string;
  readonly ref: string;
  readonly path: string;
  readonly credentialId?: string;
}

export type SourceStatus = "active" | "disabled" | "error";

/**
 * Public Source record. NEVER carries the hook secret or any
 * credential value. `defaultRef` / `defaultPath` seed the {@link GitAddress}
 * used by source-sync and Capsule planning when the request does not
 * override them.
 */
export interface Source {
  readonly id: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef: string;
  /** Capsule path within the repo. Defaults to `"."`. */
  readonly defaultPath: string;
  /** References a `source_git_*` Connection. Absent for a public repo. */
  readonly authConnectionId?: string;
  readonly status: SourceStatus;
  /**
   * Enables operator-scheduled polling of the default Git ref. Webhooks can
   * still trigger source_sync independently; this flag is the polling opt-in.
   */
  readonly autoSync: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * How a {@link SourceSnapshot} archive came to exist.
 *
 *   - `git`    — fetched from a registered {@link Source} by a `source_sync`
 *                run in the Runner Container (the historical default).
 *   - `upload` — retired public upload, retained for internal/operator
 *                compatibility with existing source-less Capsules. This is not
 *                the standard app-install product path.
 *   - `artifact` — legacy/operator HTTPS ingest of a prepared Capsule source
 *                  archive with digest verification. Despite the wire name, it
 *                  is not a deployable app artifact contract.
 */
export type SourceSnapshotOrigin = "git" | "upload" | "artifact";

/**
 * Immutable archive snapshot of a Capsule pinned to a content digest.
 *
 * For `origin: "git"` it is produced by a `source_sync` run in the Runner
 * Container (the worker only records the result) and `sourceId` references the
 * registered {@link Source}. For `origin: "upload"` it was produced by the
 * retired public upload flow or the internal/operator compatibility seam:
 * `sourceId` is absent and `url`/`ref`/`resolvedCommit` carry self-describing
 * upload identity (`url` under the Takosumi upload namespace, `ref = "upload"`,
 * `resolvedCommit = archiveDigest`) so existing readers that treat these as
 * descriptive strings keep working unchanged. For `origin: "artifact"` the
 * snapshot was fetched from a supplied HTTPS prepared source archive URL;
 * `ref = "artifact"` and `resolvedCommit = archiveDigest`.
 *
 * `archiveObjectKey` is the canonical R2_SOURCE pointer for the bytes. New git
 * syncs normally write to
 * `spaces/{workspaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst`,
 * uploads normally write to `spaces/{workspaceId}/uploads/{snapshotId}/source.tar.zst`,
 * and legacy externally prepared source archives normally write to
 * `spaces/{workspaceId}/artifact-snapshots/{snapshotId}/source.tar.zst`.
 * A later git SourceSnapshot for the same resolved commit may deliberately
 * point at an earlier snapshot's object key to reuse the immutable archive
 * bytes; consumers must trust `archiveObjectKey` rather than reconstructing it
 * from this snapshot's id.
 */
export interface SourceSnapshot {
  readonly id: string;
  readonly origin: SourceSnapshotOrigin;
  /** Owning Workspace. Always present (derived from the Source for `git`). */
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId: string;
  /** Registered Source. Present for `git`, absent for `upload`. */
  readonly sourceId?: string;
  readonly url: string;
  readonly ref: string;
  readonly resolvedCommit: string;
  readonly path: string;
  readonly archiveObjectKey: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  readonly fetchedByRunId: string;
  readonly fetchedAt: string;
}

/**
 * SourceSyncRun ledger record. The lighter run kind that reuses the run
 * status/heartbeat lifecycle: `queued` -> `running` -> terminal, with the
 * resolution result fields filled on success. Never projected with credentials.
 */
export interface SourceSyncRun {
  readonly id: string;
  readonly kind: "source_sync";
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId: string;
  readonly sourceId: string;
  /** The {@link GitAddress} this run resolved (path included). */
  readonly url: string;
  readonly ref: string;
  readonly path: string;
  /** Precomputed archive object key the runner uploads the archive to. */
  readonly archiveObjectKey: string;
  readonly status: SourceSyncRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  /**
   * Liveness marker refreshed while the run executes (epoch millis). Mirrors the
   * plan/apply Run heartbeat used by the queue-consumer idempotency guard.
   */
  readonly heartbeatAt?: number;
  readonly finishedAt?: string;
  /** Resolution result, present on success. */
  readonly resolvedCommit?: string;
  readonly archiveDigest?: string;
  readonly archiveSizeBytes?: number;
  readonly snapshotId?: string;
  readonly error?: string;
}

export type SourceSyncRunStatus = "queued" | "running" | "succeeded" | "failed";

// ---------------------------------------------------------------------------
// Source connection kinds for Git credentials.
// ---------------------------------------------------------------------------

/**
 * Git credential connection kinds. These are distinct from Provider Connections
 * and their internal provider resolver bindings:
 * the Vault mints them ONLY for the `source` phase and NEVER for plan/apply/
 * destroy. The `*_https_token` kind carries `{ GIT_HTTPS_TOKEN }` (optional
 * `username` in scope); the `*_ssh_key` kind carries `{ GIT_SSH_PRIVATE_KEY }`
 * and REQUIRES `scope.knownHostsEntry` (StrictHostKeyChecking=yes always).
 */
export type SourceGitConnectionKind =
  | "source_git_https_token"
  | "source_git_ssh_key";

export const SOURCE_GIT_CONNECTION_KINDS: readonly SourceGitConnectionKind[] = [
  "source_git_https_token",
  "source_git_ssh_key",
] as const;

/** Env name for the HTTPS token git credential value. */
export const GIT_HTTPS_TOKEN_ENV = "GIT_HTTPS_TOKEN" as const;
/** Env name for the SSH private key git credential value. */
export const GIT_SSH_PRIVATE_KEY_ENV = "GIT_SSH_PRIVATE_KEY" as const;

// ---------------------------------------------------------------------------
// Per-phase credential mint.
// ---------------------------------------------------------------------------

/**
 * The phase a credential mint is requested for. The Vault enforces:
 *   - `source`  -> ONLY git-kind connections (env + files form).
 *   - `build`   -> ALWAYS empty (error if anything is requested).
 *   - `plan` / `apply` / `destroy` -> ONLY provider resolver bindings; git excluded.
 */
export type MintPhase = "source" | "build" | "plan" | "apply" | "destroy";

export const MINT_PHASES: readonly MintPhase[] = [
  "source",
  "build",
  "plan",
  "apply",
  "destroy",
] as const;

/**
 * A file the Vault mints for a phase (for example a git askpass script, an SSH
 * key file, or a provider credential JSON file). `content` is secret material
 * and must never be logged. `mode` is the POSIX file mode the runner should
 * chmod the file to (for example `0o600`).
 */
export interface MintedFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
  /**
   * Optional env name that should receive the materialized absolute file path
   * during tofu phases. Source-phase git files leave this unset and are wired by
   * the runner's git helpers instead.
   */
  readonly envName?: string;
}

/**
 * Vault mint result. `env` carries credential env vars (provider creds for the
 * tofu phases; git creds for the source phase). `files` carries credential
 * files to materialize only inside the runner sandbox (source git helper files
 * or provider credential files). Both are secret material and must never be
 * logged or persisted to the public ledger.
 */
export interface MintResponse {
  readonly env: Readonly<Record<string, string>>;
  readonly files?: readonly MintedFile[];
}

// ---------------------------------------------------------------------------
// INTERNAL deploy-control seam paths (`/internal/v1`, reached in-process).
// ---------------------------------------------------------------------------

export const SOURCES_PATH = `${INTERNAL_V1_PREFIX}/sources` as const;
export const SOURCE_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/sources/${encodeURIComponent(id)}`;
export const SOURCE_SYNC_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/sources/${encodeURIComponent(id)}/sync`;
export const SOURCE_SNAPSHOTS_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/sources/${encodeURIComponent(id)}/snapshots`;
export const SOURCE_COMPATIBILITY_CHECK_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/sources/${encodeURIComponent(id)}/compatibility-check`;
export const COMPATIBILITY_REPORT_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/compatibility-reports/${encodeURIComponent(id)}`;

/** Webhook route on the PLATFORM worker surface (not the deploy-control /api). */
export const SOURCE_HOOK_PATH = (id: string): string =>
  `/hooks/sources/${encodeURIComponent(id)}`;

/**
 * Retired public direct-upload ingest path. The public accounts handler returns
 * `410 gone`; upload ingest remains available only on the internal/operator
 * compatibility seam.
 *
 * @deprecated Use a Git URL Source and Capsule plan/apply.
 */
export const SPACE_UPLOADS_PATH = (workspaceId: string): string =>
  `${API_V1_PREFIX}/spaces/${encodeURIComponent(workspaceId)}/uploads`;

/** INTERNAL upload ingest seam path (`/internal/v1`, reached in-process). */
export const INTERNAL_SPACE_UPLOADS_PATH = (workspaceId: string): string =>
  `${INTERNAL_V1_PREFIX}/spaces/${encodeURIComponent(workspaceId)}/uploads`;

/**
 * Retired public ingest for a digest-pinned prepared Capsule source archive.
 * The public accounts handler returns `410 gone`; prepared-source ingest remains
 * available only on the internal/operator compatibility seam.
 *
 * Legacy/operator ingest body is JSON containing an HTTPS `url` plus the
 * expected `sha256:` digest; Takosumi fetches the archive, verifies the digest,
 * stores it as a SourceSnapshot archive, and records `origin = "artifact"`.
 * This is not a deployable app artifact fetch path.
 *
 * @deprecated Use a Git URL Source and Capsule plan/apply.
 */
export const SPACE_ARTIFACT_SNAPSHOTS_PATH = (workspaceId: string): string =>
  `${API_V1_PREFIX}/spaces/${encodeURIComponent(workspaceId)}/artifact-snapshots`;

/** INTERNAL artifact ingest seam path (`/internal/v1`, reached in-process). */
export const INTERNAL_SPACE_ARTIFACT_SNAPSHOTS_PATH = (
  workspaceId: string,
): string =>
  `${INTERNAL_V1_PREFIX}/spaces/${encodeURIComponent(
    workspaceId,
  )}/artifact-snapshots`;

export interface CreateSourceRequest {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly name: string;
  readonly url: string;
  /** Defaults to `"main"` when omitted. */
  readonly defaultRef?: string;
  /** Defaults to `"."` when omitted. */
  readonly defaultPath?: string;
  readonly authConnectionId?: string;
  /** Enables operator-scheduled Git-ref polling for automatic Source updates. */
  readonly autoSync?: boolean;
}

/**
 * Source create response. The `hookSecret` is the per-source webhook bearer,
 * returned EXACTLY ONCE here and stored only as a hash on the Source record.
 */
export interface CreateSourceResponse {
  readonly source: Source;
  readonly hookSecret: string;
}

export interface SourceResponse {
  readonly source: Source;
}

export interface ListSourcesResponse {
  readonly sources: readonly Source[];
  /**
   * Opaque keyset cursor for the next page when the listing was capped (spec §30
   * pagination). Absent on the last page. Additive: readers that ignore it are
   * unaffected.
   */
  readonly nextCursor?: string;
}

export interface PatchSourceRequest {
  readonly name?: string;
  readonly defaultRef?: string;
  readonly defaultPath?: string;
  readonly authConnectionId?: string | null;
  readonly status?: SourceStatus;
  readonly autoSync?: boolean;
}

export interface CreateSourceSyncResponse {
  readonly run: SourceSyncRun;
}

export interface ListSourceSnapshotsResponse {
  readonly snapshots: readonly SourceSnapshot[];
  /**
   * Opaque keyset cursor for the next page when the listing was capped (spec §30
   * pagination; keyset column is `fetchedAt`). Absent on the last page.
   * Additive: readers that ignore it are unaffected.
   */
  readonly nextCursor?: string;
}

/**
 * Optional metadata accepted alongside an upload. `path` is the Capsule path
 * within the uploaded tree (defaults to `"."`). The archive bytes themselves
 * are the request body; values here are advisory descriptors only.
 */
export interface UploadSnapshotRequest {
  readonly path?: string;
}

/** Response of `POST {@link SPACE_UPLOADS_PATH}`: the recorded upload snapshot. */
export interface UploadSnapshotResponse {
  readonly snapshot: SourceSnapshot;
}

export type ArtifactSnapshotFormat = "tar.zst";

/**
 * Metadata for legacy digest-pinned prepared source archive ingest. `url` must
 * be an HTTPS source archive URL with no embedded credentials. `digest` must be
 * the expected SHA-256 digest (`sha256:<64 lowercase hex>` accepted
 * case-insensitively).
 */
export interface ArtifactSnapshotRequest {
  readonly url: string;
  readonly digest: string;
  readonly format?: ArtifactSnapshotFormat;
  readonly path?: string;
}

/** Response of `POST {@link SPACE_ARTIFACT_SNAPSHOTS_PATH}`. */
export interface ArtifactSnapshotResponse {
  readonly snapshot: SourceSnapshot;
}
