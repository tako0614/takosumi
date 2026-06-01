/**
 * Installer API - Takosumi v1 manifestless source-to-deployment API.
 *
 * Public concepts are Source, Installation, Deployment, and PlatformService.
 * Dry-run returns an InstallPlan snapshot for review. The plan is not a
 * persisted public entity; apply stores the reviewed snapshot on Deployment.
 */

import type { JsonValue } from "./types.ts";

export const INSTALLATIONS_PATH = "/v1/installations" as const;
export const INSTALLATIONS_DRY_RUN_PATH = "/v1/installations/dry-run" as const;
export const INSTALLATION_DEPLOYMENTS_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/deployments`;
export const INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/deployments/dry-run`;
export const INSTALLATION_ROLLBACK_PATH = (id: string): string =>
  `/v1/installations/${encodeURIComponent(id)}/rollback`;

// Source descriptors

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
  /** Digest of the prepared source archive payload bytes. */
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
  readonly commit: string;
  readonly planSnapshotDigest: string;
  readonly sourceDigest?: string;
  readonly artifactDigest?: string;
}

export interface PreparedSourcePin {
  readonly sourceDigest: string;
  readonly planSnapshotDigest: string;
  readonly commit?: never;
  readonly artifactDigest?: string;
}

export interface LocalSourcePin {
  readonly planSnapshotDigest: string;
  readonly commit?: never;
  readonly sourceDigest?: never;
  readonly artifactDigest?: string;
}

export type SourcePin = GitSourcePin | PreparedSourcePin | LocalSourcePin;

export interface CurrentDeploymentGuard {
  readonly currentDeploymentId: string | null;
}

export type DeploymentExpectedGuard = SourcePin & CurrentDeploymentGuard;

// Manifestless planning

export interface SourceSummary {
  readonly kind: SourceKind;
  readonly url?: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly digest?: string;
  readonly sourceDigest?: string;
}

export interface RepoMetadata {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly repositoryUrl?: string;
}

export interface BindingSelection {
  readonly name: string;
  readonly servicePath?: string;
  readonly serviceKind?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly many?: boolean;
  readonly required?: boolean;
  readonly inject?: JsonValue;
}

export type DeploymentOutputMaterial = Readonly<Record<string, JsonValue>>;

export interface PlatformService {
  readonly path?: string;
  readonly kind: string;
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly material?: DeploymentOutputMaterial;
}

export interface ResolvedBinding {
  readonly name: string;
  readonly selection: BindingSelection;
  readonly services: readonly PlatformService[];
}

export interface PublicationPlan {
  readonly name: string;
  readonly kind: string;
  readonly path?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export type ChangeOp = "create" | "update" | "delete" | "noop";

export type ChangeSubjectKind =
  | "source"
  | "binding"
  | "publication"
  | "deployment";

export interface ChangeEntry {
  readonly op: ChangeOp;
  readonly subject: string;
  readonly kind: ChangeSubjectKind;
  readonly reason?: string;
}

export interface InstallPlan {
  readonly source: SourceSummary;
  readonly repo: RepoMetadata;
  readonly selectedProfile?: string;
  readonly requestedBindings: readonly BindingSelection[];
  readonly resolvedBindings: readonly ResolvedBinding[];
  readonly publications: readonly PublicationPlan[];
  readonly changes: readonly ChangeEntry[];
  readonly warnings: readonly string[];
}

// Dry-run / apply requests

export interface InstallationDryRunRequest {
  readonly spaceId: string;
  readonly source: Source;
  readonly profile?: string;
  readonly bindings?: readonly BindingSelection[];
}

export interface DryRunResponse<TExpected extends SourcePin = SourcePin> {
  readonly source: SourceSummary;
  readonly installPlan: InstallPlan;
  readonly planSnapshotDigest: string;
  readonly changes: readonly ChangeEntry[];
  readonly expected: TExpected;
}

export type InstallationDryRunResponse = DryRunResponse<SourcePin>;

export interface InstallationApplyRequest {
  readonly spaceId: string;
  readonly source: Source;
  readonly profile?: string;
  readonly bindings?: readonly BindingSelection[];
  readonly expected?: SourcePin;
}

export interface InstallationApplyResponse {
  readonly installation: Installation;
  readonly deployment: Deployment;
}

export interface DeploymentDryRunRequest {
  readonly source?: Source;
  readonly profile?: string;
  readonly bindings?: readonly BindingSelection[];
}

export type DeploymentDryRunResponse = DryRunResponse<DeploymentExpectedGuard>;

export interface DeploymentApplyRequest {
  readonly source?: Source;
  readonly profile?: string;
  readonly bindings?: readonly BindingSelection[];
  readonly expected?: DeploymentExpectedGuard;
}

export interface DeploymentApplyResponse {
  readonly deployment: Deployment;
}

// Rollback

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
  readonly scope: RollbackScope;
}

export interface RollbackScope {
  readonly pointer: "reverted";
  readonly resourceMaterialization: "not-reapplied";
  readonly workloadState: "not-reverted";
}

// Entities

export type InstallationStatus =
  | "installing"
  | "ready"
  | "failed"
  | "suspended";

export interface Installation {
  readonly id: string;
  readonly spaceId: string;
  /** Stable repo-derived identity, not Takosumi-specific source metadata. */
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
  readonly sourceDigest?: string;
  readonly artifactDigest?: string;
  readonly planSnapshotDigest: string;
  readonly planSnapshot: InstallPlan;
  readonly bindingsSnapshot: readonly ResolvedBinding[];
  readonly status: DeploymentStatus;
  readonly outputs: DeploymentOutputs;
  readonly createdAt: number;
}

export interface DeploymentOutputs {
  readonly public?: Readonly<Record<string, DeploymentOutputMaterial>>;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export type DeploymentServicePathExposure = PublicationPlan & Readonly<{
  readonly material: DeploymentOutputMaterial;
}>;

// Error envelope

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
