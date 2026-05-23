/**
 * Installer API — Takosumi's public HTTP surface.
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

export type SourceKind = "git" | "local" | "prepared";

export interface Source {
  readonly kind: SourceKind;
  readonly url?: string;
  readonly ref?: string;
  readonly commit?: string;
  /**
   * Digest of the source payload when `kind: "prepared"`.
   *
   * Prepared sources are immutable source snapshots (typically tar archives)
   * produced by an operator-owned build/preparation service. The kernel
   * verifies this digest before reading `.takosumi.yml`.
   */
  readonly digest?: string;
}

export interface SourcePin {
  readonly commit?: string;
  readonly manifestDigest: string;
  readonly sourceDigest?: string;
}

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

export interface EstimatedCost {
  readonly currency: string;
  readonly monthly: number;
}

export interface InstallationDryRunResponse {
  readonly source: SourceSummary;
  readonly manifestDigest: string;
  readonly appSpec: AppSpec;
  readonly changes: readonly ChangeEntry[];
  readonly estimatedCost?: EstimatedCost;
  readonly expected: SourcePin;
}

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

export type DeploymentDryRunResponse = InstallationDryRunResponse;

export interface DeploymentApplyRequest {
  readonly source?: Source;
  readonly expected?: SourcePin;
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
  readonly deployment: Deployment;
}

// ──────────────────────────────────────────────
// Entities (3 public)
// ──────────────────────────────────────────────

export type InstallationStatus =
  | "running"
  | "failed"
  | "suspended"
  | "deleted";

export interface Installation {
  readonly id: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly currentDeploymentId: string | null;
  readonly status: InstallationStatus;
  readonly createdAt: number;
}

export type DeploymentStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "rolled_back";

export interface Deployment {
  readonly id: string;
  readonly installationId: string;
  readonly source: SourceSummary;
  readonly manifestDigest: string;
  readonly status: DeploymentStatus;
  readonly outputs: DeploymentOutputs;
  readonly rolledBackFrom?: string;
  readonly rolledBackTo?: string;
  readonly createdAt: number;
}

export interface DeploymentOutputs {
  readonly components?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly [key: string]: unknown;
}

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
