/**
 * Source domain contract.
 *
 * A Source is a Workspace-scoped registration of a Git repository that Takosumi can
 * resolve to an immutable archive snapshot. Takosumi core is GitHub-agnostic: it
 * knows only a {@link GitAddress} (`{ url, ref, path, credentialId }`) and never
 * a forge-specific manifest. A repository may carry optional presentation or
 * install-UX proposals, but every accepted service-side concern is compiled
 * into DB config on the Source / Connection / InstallConfig records.
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

import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
import {
  parseRepositoryManifestText,
  TAKOSUMI_INSTALL_UX_MAX_MODULES,
  type RepositoryManifestDocument,
} from "./repository-manifest.ts";

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
 * Bounded observation of the optional repository-owned display presentation
 * document at `.well-known/tcs.json` from the same Git commit as a
 * {@link SourceSnapshot}. The selected OpenTofu module remains the executable
 * archive; this observation only keeps repository-root display metadata
 * immutable when the Source points at a nested module path. It never selects
 * that path or carries InstallConfig execution declarations.
 */
export type RepositoryInstallMetadataSnapshot =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly text: string }
  | {
      readonly status: "invalid";
      readonly reason: "not_regular_file" | "too_large";
    };

export type RepositoryManifestInvalidReason =
  | "not_regular_file"
  | "too_large"
  | "invalid_utf8"
  | "invalid_document";

/**
 * Durable observation of `.well-known/takosumi.json` from the same immutable
 * Git commit as the executable archive.
 *
 * The validated document is internal compiler input. HTTP projections must use
 * {@link publicRepositoryManifestObservation} so repository content is not
 * copied into SourceSnapshot list responses.
 */
export type RepositoryManifestSnapshot =
  | { readonly status: "absent" }
  | {
      readonly status: "present";
      readonly digest: string;
      readonly document: RepositoryManifestDocument;
    }
  | {
      readonly status: "invalid";
      readonly reason: RepositoryManifestInvalidReason;
      readonly digest?: string;
      /** Bounded parser diagnostic; never included in public projections. */
      readonly diagnostic?: string;
    };

/** Public-safe SourceSnapshot observation: status + digest, never document. */
export type PublicRepositoryManifestObservation =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly digest: string }
  | {
      readonly status: "invalid";
      readonly reason: RepositoryManifestInvalidReason;
      readonly digest?: string;
    };

export function publicRepositoryManifestObservation(
  snapshot: RepositoryManifestSnapshot,
): PublicRepositoryManifestObservation {
  if (snapshot.status === "present") {
    return { status: "present", digest: snapshot.digest };
  }
  if (snapshot.status === "invalid") {
    return {
      status: "invalid",
      reason: snapshot.reason,
      ...(snapshot.digest ? { digest: snapshot.digest } : {}),
    };
  }
  return { status: "absent" };
}

/** Strict parser for the untrusted runner-to-host SourceSnapshot seam. */
export function parseRepositoryManifestSnapshot(
  value: unknown,
): RepositoryManifestSnapshot | undefined {
  if (!plainRecord(value) || typeof value.status !== "string") {
    return undefined;
  }
  if (value.status === "absent") {
    return exactRecordKeys(value, ["status"]) ? { status: "absent" } : undefined;
  }
  if (value.status === "present") {
    if (
      !exactRecordKeys(value, ["status", "digest", "document"]) ||
      !sha256Digest(value.digest)
    ) {
      return undefined;
    }
    let text: string;
    try {
      text = JSON.stringify(value.document);
    } catch {
      return undefined;
    }
    const parsed = parseRepositoryManifestText(text);
    return parsed.ok
      ? { status: "present", digest: value.digest, document: parsed.document }
      : undefined;
  }
  if (value.status !== "invalid") return undefined;
  if (
    !exactRecordKeys(value, ["status", "reason", "digest", "diagnostic"]) ||
    typeof value.reason !== "string" ||
    ![
      "not_regular_file",
      "too_large",
      "invalid_utf8",
      "invalid_document",
    ].includes(value.reason)
  ) {
    return undefined;
  }
  if (value.digest !== undefined && !sha256Digest(value.digest)) {
    return undefined;
  }
  if (
    value.diagnostic !== undefined &&
    (typeof value.diagnostic !== "string" ||
      value.diagnostic.length < 1 ||
      value.diagnostic.length > 1_024 ||
      /[\0\r\n]/u.test(value.diagnostic))
  ) {
    return undefined;
  }
  return {
    status: "invalid",
    reason: value.reason as RepositoryManifestInvalidReason,
    ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
    ...(typeof value.diagnostic === "string"
      ? { diagnostic: value.diagnostic }
      : {}),
  };
}

function plainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecordKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function sha256Digest(value: unknown): value is string {
  return (
    typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)
  );
}

/**
 * Immutable archive snapshot of a Capsule pinned to a content digest.
 *
 * A snapshot is produced only by a `source_sync` run for a registered
 * {@link Source}. `sourceId` is therefore required and is the sole source
 * authority. The checked-out bytes may be copied to object storage for
 * immutable runner transport, but that archive is not an alternate Source.
 *
 * `archiveRef` is an opaque host-allocated reference for the bytes. A later git
 * SourceSnapshot for the same resolved commit may deliberately reuse an earlier
 * snapshot's reference; consumers must pass it back to the configured storage
 * adapter and never reconstruct it from snapshot identity.
 */
export interface SourceSnapshot {
  readonly id: string;
  readonly origin: "git";
  /** Owning Workspace, derived from the registered Source. */
  readonly workspaceId: string;
  /** Registered Git Source that produced this snapshot. */
  readonly sourceId: string;
  readonly url: string;
  readonly ref: string;
  readonly resolvedCommit: string;
  readonly path: string;
  readonly archiveRef: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
  /**
   * Repository-root metadata observed during Git source sync. Missing only on
   * snapshots created before this invariant was introduced; such snapshots are
   * not reused by a new source sync.
   */
  readonly repositoryInstallMetadata?: RepositoryInstallMetadataSnapshot;
  /**
   * Optional only for snapshots persisted before repository-manifest
   * observation was introduced. Every new source sync records absent, present,
   * or invalid; old snapshots are not eligible for archive reuse.
   */
  readonly repositoryManifest?: RepositoryManifestSnapshot;
  readonly fetchedByRunId: string;
  readonly fetchedAt: string;
}

export type PublicSourceSnapshot = Omit<SourceSnapshot, "repositoryManifest"> & {
  readonly repositoryManifest?: PublicRepositoryManifestObservation;
};

/** Remove validated repository content before serializing a snapshot to HTTP. */
export function toPublicSourceSnapshot(
  snapshot: SourceSnapshot,
): PublicSourceSnapshot {
  if (!snapshot.repositoryManifest) return snapshot;
  return {
    ...snapshot,
    repositoryManifest: publicRepositoryManifestObservation(
      snapshot.repositoryManifest,
    ),
  };
}

/**
 * Bounded public projection of the installable module directories declared by
 * one immutable repository manifest. The manifest document itself (including
 * inputs, provider requirements, and policy proposals) never crosses this
 * seam. `absent` and `invalid` deliberately carry no module candidates so an
 * untrusted or missing manifest cannot grant module-path authority.
 */
export interface SourceSnapshotInstallModule {
  readonly path: string;
  readonly default?: boolean;
}

export type SourceSnapshotInstallModulesResponse =
  | {
      readonly status: "absent";
      readonly sourceSnapshotId: string;
      readonly modules: readonly [];
    }
  | {
      readonly status: "invalid";
      readonly sourceSnapshotId: string;
      readonly manifestDigest?: string;
      readonly modules: readonly [];
    }
  | {
      readonly status: "ready";
      readonly sourceSnapshotId: string;
      readonly manifestDigest: string;
      readonly defaultModule?: string;
      readonly modules: readonly SourceSnapshotInstallModule[];
    };

/**
 * Project only validated, immutable `install.modules` own keys for a
 * SourceSnapshot. Sorting uses code-point comparison so every client receives
 * the same order regardless of locale. This is intentionally a projection
 * helper rather than a generic manifest serializer.
 */
export function sourceSnapshotInstallModulesProjection(
  snapshot: SourceSnapshot,
): SourceSnapshotInstallModulesResponse {
  const sourceSnapshotId = snapshot.id;
  const observation = snapshot.repositoryManifest;
  if (!observation || observation.status === "absent") {
    return { status: "absent", sourceSnapshotId, modules: [] };
  }
  if (observation.status === "invalid") {
    return {
      status: "invalid",
      sourceSnapshotId,
      ...(sha256Digest(observation.digest)
        ? { manifestDigest: observation.digest }
        : {}),
      modules: [],
    };
  }

  if (!sha256Digest(observation.digest)) {
    return {
      status: "invalid",
      sourceSnapshotId,
      modules: [],
    };
  }

  // `RepositoryManifestSnapshot` is produced by the strict manifest parser,
  // but keep this boundary defensive for old/hand-seeded durable rows. A
  // malformed present observation is invalid rather than a source of paths.
  const install = observation.document?.install;
  const modules = plainRecord(install) ? install.modules : undefined;
  if (
    !plainRecord(install) ||
    !plainRecord(modules) ||
    Object.keys(modules).length < 1 ||
    Object.keys(modules).length > TAKOSUMI_INSTALL_UX_MAX_MODULES
  ) {
    return {
      status: "invalid",
      sourceSnapshotId,
      manifestDigest: observation.digest,
      modules: [],
    };
  }
  const paths = Object.keys(modules);
  if (
    paths.some(
      (path) =>
        !isProjectionModulePath(path) ||
        !isModuleDirectoryPath(path) ||
        !plainRecord(modules[path]),
    )
  ) {
    return {
      status: "invalid",
      sourceSnapshotId,
      manifestDigest: observation.digest,
      modules: [],
    };
  }
  paths.sort(compareModulePath);
  const hasDefaultModule = Object.prototype.hasOwnProperty.call(
    install,
    "defaultModule",
  );
  const rawDefaultModule = hasDefaultModule
    ? install.defaultModule
    : undefined;
  if (hasDefaultModule && typeof rawDefaultModule !== "string") {
    return {
      status: "invalid",
      sourceSnapshotId,
      manifestDigest: observation.digest,
      modules: [],
    };
  }
  const defaultModule =
    typeof rawDefaultModule === "string" ? rawDefaultModule : undefined;
  if (
    defaultModule !== undefined &&
    (!isProjectionModulePath(defaultModule) ||
      !isModuleDirectoryPath(defaultModule) ||
      !Object.prototype.hasOwnProperty.call(modules, defaultModule))
  ) {
    return {
      status: "invalid",
      sourceSnapshotId,
      manifestDigest: observation.digest,
      modules: [],
    };
  }
  return {
    status: "ready",
    sourceSnapshotId,
    manifestDigest: observation.digest,
    ...(defaultModule !== undefined ? { defaultModule } : {}),
    modules: paths.map((path) =>
      path === defaultModule ? { path, default: true } : { path },
    ),
  };
}

function compareModulePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keep this projection defensive even when a hand-seeded durable row bypasses
 * the repository-manifest parser. The parser uses the same canonical spelling
 * for module keys; aliases such as `./deploy/app` must never become choices. */
function isProjectionModulePath(value: string): boolean {
  if (
    !value ||
    value.trim() !== value ||
    value.length > 1_024 ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  if (value === ".") return true;
  return !value
    .split("/")
    .some((segment) => !segment || segment === "." || segment === "..");
}

/** A manifest module is a directory choice, never an individual OpenTofu file. */
function isModuleDirectoryPath(value: string): boolean {
  return !/(?:\.tf|\.tofu)(?:\.json)?$/iu.test(value);
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
  readonly sourceId: string;
  /** The {@link GitAddress} this run resolved (path included). */
  readonly url: string;
  readonly ref: string;
  readonly path: string;
  /** Host-allocated opaque reference the runner publishes the archive to. */
  readonly archiveRef: string;
  /**
   * Why this sync was requested. `observe` is the default for webhook and
   * scheduled reconciliation. `manual_plan` refreshes an immutable snapshot
   * for an explicit user-reviewed plan and must not independently start the
   * Capsule auto-update flow. Missing pre-v1 values mean `observe`.
   */
  readonly intent?: SourceSyncIntent;
  readonly status: SourceSyncRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  /**
   * Liveness marker refreshed while the run executes (epoch millis). Mirrors the
   * plan/apply Run heartbeat used by the RunOwner idempotency guard.
   */
  readonly heartbeatAt?: number;
  readonly finishedAt?: string;
  /** Resolution result, present on success. */
  readonly resolvedCommit?: string;
  readonly archiveDigest?: string;
  readonly archiveSizeBytes?: number;
  readonly snapshotId?: string;
  /**
   * Public-safe runner phase timings. These are operational metadata only:
   * phase names and durations, never source contents or credential values.
   */
  readonly phaseTimings?: readonly SourceSyncPhaseTiming[];
  /** Stable machine-readable terminal reason; never inferred from `error`. */
  readonly errorCode?: string;
  readonly error?: string;
}

export type SourceSyncRunStatus = "queued" | "running" | "succeeded" | "failed";

export type SourceSyncIntent = "observe" | "manual_plan";

/**
 * Narrow request for an explicit Source sync. `expectedRef` is optional for
 * scheduler/webhook observations, but a manual plan may supply an immutable
 * commit so the control plane can reject a raced Source update before it
 * creates or reuses a run.
 */
export interface CreateSourceSyncRequest {
  readonly intent?: SourceSyncIntent;
  readonly expectedRef?: string;
  /**
   * Server-owned revision coordinator pin. Unlike `expectedRef`, this does not
   * rewrite or reinterpret the Source default; it creates one manual-plan sync
   * for the exact requested Git address. Public Source-sync handlers do not
   * forward these fields from caller JSON.
   */
  readonly coordinator?: {
    readonly ref: string;
    readonly path: string;
    /** Deterministic identities used to recover a committed lost acknowledgement. */
    readonly runId: string;
    readonly snapshotId: string;
  };
}

export interface SourceSyncPhaseTiming {
  readonly phase: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

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
  "source_git_https_token" | "source_git_ssh_key";

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
export const SOURCE_SNAPSHOT_FILE_PATH = (
  sourceId: string,
  sourceSnapshotId: string,
): string =>
  `${INTERNAL_V1_PREFIX}/sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(sourceSnapshotId)}/file`;
export const SOURCE_SNAPSHOT_INSTALL_MODULES_PATH = (
  sourceId: string,
  sourceSnapshotId: string,
): string =>
  `${INTERNAL_V1_PREFIX}/sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(sourceSnapshotId)}/install-modules`;
export const WORKSPACE_STABLE_SOURCE_TAG_PATH = (workspaceId: string): string =>
  `${INTERNAL_V1_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/source-ref-resolutions/stable-semver`;
export const SOURCE_COMPATIBILITY_CHECK_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/sources/${encodeURIComponent(id)}/compatibility-check`;
export const COMPATIBILITY_REPORT_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/compatibility-reports/${encodeURIComponent(id)}`;

/** Webhook route on the PLATFORM worker surface (not the deploy-control /api). */
export const SOURCE_HOOK_PATH = (id: string): string =>
  `/hooks/sources/${encodeURIComponent(id)}`;

export interface CreateSourceRequest {
  readonly workspaceId: string;
  readonly name: string;
  readonly url: string;
  /** Defaults to Git's symbolic `HEAD` when omitted. */
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

export interface StableSourceTagResolutionRequest {
  readonly url: string;
}

export interface StableSourceTagResolutionResponse {
  readonly tag: string;
  readonly commit: string;
}

export interface SourceSnapshotFileResponse {
  readonly sourceSnapshotId: string;
  readonly path: string;
  readonly text: string;
  /** SHA-256 of the exact UTF-8 bytes read inside the Runner boundary. */
  readonly digest: string;
  readonly sizeBytes: number;
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
