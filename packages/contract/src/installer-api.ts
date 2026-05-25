/**
 * Installer API — Takosumi's public source-to-deployment API.
 *
 * 5 endpoints, 3 public concepts (AppSpec / Installation / Deployment).
 *
 *   POST /v1/installations/dry-run
 *   POST /v1/installations
 *   POST /v1/installations/{id}/deployments/dry-run
 *   POST /v1/installations/{id}/deployments
 *   POST /v1/installations/{id}/rollback
 *
 * No persisted plan entity — dry-run
 * results are returned in the response and never persisted as entities.
 */

import type { AppSpec } from "./app-spec.ts";
import type { JsonValue } from "./types.ts";

export const INSTALLATIONS_PATH = "/v1/installations" as const;
export const INSTALLATIONS_DRY_RUN_PATH = "/v1/installations/dry-run" as const;
export const INSTALLATION_DEPLOYMENTS_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/deployments`;
export const INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/deployments/dry-run`;
export const INSTALLATION_ROLLBACK_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/rollback`;

// ──────────────────────────────────────────────
// Source descriptors
// ──────────────────────────────────────────────

export type RemoteSourceKind = "git" | "prepared";
export type SourceKind = RemoteSourceKind | "local";

export interface GitSourceInput {
  readonly kind: "git";
  readonly url: string;
  readonly ref: string;
  readonly commit?: never;
  readonly digest?: never;
}

export interface PreparedSourceInput {
  readonly kind: "prepared";
  readonly url: string;
  /**
   * Digest of the prepared source archive payload bytes.
   *
   * Prepared sources are immutable source snapshots produced by an
   * operator-owned build/preparation service. The kernel verifies this digest
   * before reading `.takosumi.yml`.
   */
  readonly digest: string;
  readonly ref?: never;
  readonly commit?: never;
}

export interface LocalSourceInput {
  readonly kind: "local";
  /** Kernel-local source root path for dev / operator-local profiles. */
  readonly url: string;
  readonly ref?: never;
  readonly commit?: never;
  readonly digest?: never;
}

export type Source = GitSourceInput | PreparedSourceInput | LocalSourceInput;

export interface GitSourcePin {
  readonly manifestDigest: string;
  readonly commit: string;
  readonly sourceDigest?: never;
}

export interface PreparedSourcePin {
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly commit?: never;
}

export interface LocalSourcePin {
  readonly manifestDigest: string;
  readonly commit?: never;
  readonly sourceDigest?: never;
}

export type SourcePin = GitSourcePin | PreparedSourcePin | LocalSourcePin;

export interface CurrentDeploymentGuard {
  readonly currentDeploymentId: string | null;
}

export type DeploymentExpectedGuard = SourcePin & CurrentDeploymentGuard;

// ──────────────────────────────────────────────
// Dry-run (new install)
// ──────────────────────────────────────────────

export interface InstallationDryRunRequest {
  readonly spaceId: string;
  readonly source: Source;
}

export type ChangeOp = "create" | "update" | "delete" | "noop";

export interface ChangeEntry {
  readonly op: ChangeOp;
  readonly component: string;
  readonly kind: string;
  readonly reason?: string;
}

export interface DryRunResponse<TExpected extends SourcePin = SourcePin> {
  readonly source: SourceSummary;
  readonly manifestDigest: string;
  readonly appSpec: AppSpec;
  readonly changes: readonly ChangeEntry[];
  readonly expected: TExpected;
}

export type InstallationDryRunResponse = DryRunResponse<SourcePin>;

export interface SourceSummary {
  readonly kind: SourceKind;
  readonly url?: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly digest?: string;
}

// ──────────────────────────────────────────────
// Apply (new install)
// ──────────────────────────────────────────────

export interface InstallationApplyRequest {
  readonly spaceId: string;
  readonly source: Source;
  readonly expected?: SourcePin;
}

export interface InstallationApplyResponse {
  readonly installation: Installation;
  readonly deployment: Deployment;
}

// ──────────────────────────────────────────────
// Deployment (upgrade)
// ──────────────────────────────────────────────

export interface DeploymentDryRunRequest {
  readonly source?: Source;
}

export type DeploymentDryRunResponse = DryRunResponse<DeploymentExpectedGuard>;

export interface DeploymentApplyRequest {
  readonly source?: Source;
  readonly expected?: DeploymentExpectedGuard;
}

export interface DeploymentApplyResponse {
  readonly deployment: Deployment;
}

// ──────────────────────────────────────────────
// Rollback
// ──────────────────────────────────────────────

export interface RollbackRequest {
  readonly deploymentId: string;
}

export interface RollbackResponse {
  readonly installation: Installation;
  readonly deployment: Deployment;
  readonly rollback: RollbackMetadata;
}

export interface RollbackMetadata {
  readonly rolledBackFrom: string | null;
  readonly rolledBackTo: string;
}

// ──────────────────────────────────────────────
// Entities (3 public)
// ──────────────────────────────────────────────

export type InstallationStatus =
  | "installing"
  | "ready"
  | "failed"
  | "suspended";

export interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly currentDeploymentId: string | null;
  readonly status: InstallationStatus;
  readonly createdAt: number;
}

export type DeploymentStatus =
  | "running"
  | "succeeded"
  | "failed";

export interface Deployment {
  readonly id: string;
  readonly installationId: string;
  readonly source: SourceSummary;
  readonly manifestDigest: string;
  readonly status: DeploymentStatus;
  readonly outputs: DeploymentOutputs;
  readonly createdAt: number;
}

export interface DeploymentOutputs {
  readonly components?: Readonly<
    Record<string, Readonly<Record<string, DeploymentPublicationOutput>>>
  >;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export type DeploymentPublicationOutput = Readonly<Record<string, JsonValue>>;

// ──────────────────────────────────────────────
// Error envelope
// ──────────────────────────────────────────────

export type InstallerErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "failed_precondition"
  | "resource_exhausted"
  | "not_implemented"
  | "internal_error";

export interface InstallerErrorEnvelope {
  readonly error: {
    readonly code: InstallerErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}
