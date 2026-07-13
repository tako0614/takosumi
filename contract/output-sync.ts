/**
 * Takosumi Output Sync extension contract.
 *
 * This is deliberately not part of OpenTofu's Output semantics. OpenTofu owns
 * the apply/state/output snapshot; Output Sync adds a Workspace-wide read model
 * and reconciliation policy on top of those immutable Output records.
 */

import { API_V1_PREFIX } from "./api-surface.ts";
import type { JsonValue } from "./types.ts";
import type { RunGroupWithRuns } from "./runs.ts";

export const TAKOSUMI_OUTPUT_SYNC_CAPABILITY =
  "takosumi.output-sync.v1" as const;

export const WORKSPACE_OUTPUT_SYNC_PATH = (workspaceId: string): string =>
  `${API_V1_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/output-sync`;

export const WORKSPACE_OUTPUT_SYNC_SNAPSHOT_PATH = (
  workspaceId: string,
): string => `${WORKSPACE_OUTPUT_SYNC_PATH(workspaceId)}/snapshot`;

export const WORKSPACE_OUTPUT_SYNC_RECONCILE_PATH = (
  workspaceId: string,
): string => `${WORKSPACE_OUTPUT_SYNC_PATH(workspaceId)}/reconcile`;

export interface WorkspaceOutputSyncState {
  readonly workspaceId: string;
  /** Enabled by default; a Workspace may explicitly disable the extension. */
  readonly enabled: boolean;
  /** Monotonic revision bumped when the Workspace's current Output set changes. */
  readonly outputRevision: number;
  /** Latest revision for which Workspace reconciliation reached a terminal state. */
  readonly reconciledRevision: number;
  /** The one active reconciliation group, when a reconcile is in flight. */
  readonly activeRunGroupId?: string;
  /** Consecutive follow-up passes used to stop non-converging output loops. */
  readonly consecutivePasses: number;
  readonly updatedAt: string;
}

export interface WorkspaceOutputSyncSettings {
  readonly enabled: boolean;
}

export interface PatchWorkspaceOutputSyncRequest {
  readonly enabled: boolean;
}

export interface WorkspaceOutputSyncStatusResponse {
  readonly capability: typeof TAKOSUMI_OUTPUT_SYNC_CAPABILITY;
  readonly state: WorkspaceOutputSyncState;
}

export interface WorkspaceOutputSyncSnapshotEntry {
  readonly capsuleId: string;
  readonly capsuleStatus: string;
  readonly outputId: string;
  readonly stateGeneration: number;
  readonly outputDigest: string;
  readonly publicOutputs: Readonly<Record<string, JsonValue>>;
  readonly workspaceOutputs: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
}

export interface WorkspaceOutputSyncSnapshot {
  readonly workspaceId: string;
  readonly revision: number;
  readonly outputs: readonly WorkspaceOutputSyncSnapshotEntry[];
}

export interface WorkspaceOutputSyncSnapshotResponse {
  readonly snapshot: WorkspaceOutputSyncSnapshot;
}

export interface WorkspaceOutputSyncReconcileResponse {
  readonly capability: typeof TAKOSUMI_OUTPUT_SYNC_CAPABILITY;
  /** The durable staged RunGroup, or no group when this revision is current. */
  readonly reconciliation?: RunGroupWithRuns;
  readonly state: WorkspaceOutputSyncState;
}
