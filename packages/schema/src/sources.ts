/**
 * Source domain contract (Core Specification §6 / §7 / §8).
 *
 * A Source is a Space-scoped registration of a Git repository that Takosumi can
 * resolve to an immutable archive snapshot. Takosumi core is GitHub-agnostic: it
 * knows only a {@link GitAddress} (`{ url, ref, path, credentialId }`) and never
 * a forge-specific manifest. There is no custom manifest in user repos; every
 * service-side concern is DB config on the Source / Connection records.
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

/**
 * GitHub-agnostic Git coordinate. The only repository identity Takosumi core
 * understands. `credentialId` references a `source_git_*` Connection (none for a
 * public repo). `path` is the module path within the repo (defaults to `"."`).
 */
export interface GitAddress {
  readonly url: string;
  readonly ref: string;
  readonly path: string;
  readonly credentialId?: string;
}

export type SourceStatus = "active" | "disabled" | "error";

/**
 * Public Source record (spec §6.1). NEVER carries the hook secret or any
 * credential value. `defaultRef` / `defaultPath` seed the {@link GitAddress} used
 * when an Environment does not override them.
 */
export interface Source {
  readonly id: string;
  readonly spaceId: string;
  readonly name: string;
  readonly url: string;
  readonly defaultRef: string;
  /** Module path within the repo. Defaults to `"."`. */
  readonly defaultPath: string;
  /** References a `source_git_*` Connection. Absent for a public repo. */
  readonly authConnectionId?: string;
  readonly status: SourceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Immutable archive snapshot of a Source at a resolved commit (spec §6.2).
 * Produced by a `source_sync` run in the Runner Container; the worker only
 * records the result. The archive bytes live in R2_SOURCE under
 * `spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst`.
 */
export interface SourceSnapshot {
  readonly id: string;
  readonly sourceId: string;
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
   * PlanRun/ApplyRun heartbeat used by the queue-consumer idempotency guard.
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

export type SourceSyncRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

// ---------------------------------------------------------------------------
// Source connection kinds (spec §8 git credential kinds)
// ---------------------------------------------------------------------------

/**
 * Git credential connection kinds. These are distinct from provider connections:
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
// Per-phase credential mint (spec §8.3 / §8.4)
// ---------------------------------------------------------------------------

/**
 * The phase a credential mint is requested for. The Vault enforces:
 *   - `source`  -> ONLY git-kind connections (env + files form).
 *   - `build`   -> ALWAYS empty (error if anything is requested).
 *   - `plan` / `apply` / `destroy` -> ONLY provider connections; git excluded.
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
 * A file the Vault mints for a phase (e.g. the git askpass script or the SSH key
 * file). `content` is secret material and must never be logged. `mode` is the
 * POSIX file mode the runner should chmod the file to (e.g. `0o600`).
 */
export interface MintedFile {
  readonly path: string;
  readonly mode: number;
  readonly content: string;
}

/**
 * Vault mint result. `env` carries credential env vars (provider creds for the
 * tofu phases; git creds for the source phase). `files` carries the materialized
 * credential files for the source phase (askpass script / ssh key). Both are
 * secret material — never logged or persisted to the public ledger.
 */
export interface MintResponse {
  readonly env: Readonly<Record<string, string>>;
  readonly files?: readonly MintedFile[];
}

// ---------------------------------------------------------------------------
// Public API paths (spec §30 — `/api`, no version prefix).
// ---------------------------------------------------------------------------

export const SOURCES_PATH = "/api/sources" as const;
export const SOURCE_PATH = (id: string): string =>
  `/api/sources/${encodeURIComponent(id)}`;
export const SOURCE_SYNC_PATH = (id: string): string =>
  `/api/sources/${encodeURIComponent(id)}/sync`;
export const SOURCE_SNAPSHOTS_PATH = (id: string): string =>
  `/api/sources/${encodeURIComponent(id)}/snapshots`;

/** Webhook route on the PLATFORM worker surface (not the deploy-control /api). */
export const SOURCE_HOOK_PATH = (id: string): string =>
  `/hooks/sources/${encodeURIComponent(id)}`;

export interface CreateSourceRequest {
  readonly spaceId: string;
  readonly name: string;
  readonly url: string;
  /** Defaults to `"main"` when omitted. */
  readonly defaultRef?: string;
  /** Defaults to `"."` when omitted. */
  readonly defaultPath?: string;
  readonly authConnectionId?: string;
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
}

export interface PatchSourceRequest {
  readonly name?: string;
  readonly defaultRef?: string;
  readonly defaultPath?: string;
  readonly authConnectionId?: string | null;
  readonly status?: SourceStatus;
}

export interface CreateSourceSyncResponse {
  readonly run: SourceSyncRun;
}

export interface ListSourceSnapshotsResponse {
  readonly snapshots: readonly SourceSnapshot[];
}
