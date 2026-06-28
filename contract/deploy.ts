/**
 * Retired public deploy contract (`POST /api/v1/deploy`).
 *
 * The public handler now returns `410 gone`. New clients should register a Git
 * URL Source, create a Capsule, and run plan/apply against the Git-pinned
 * SourceSnapshot. Upload/prepared-source deploy survives only as an internal
 * operator compatibility seam under `/internal/v1`.
 */

import type {
  OutputAllowlistEntry,
  PublicCapsule,
} from "./installations.ts";
import type { JsonValue } from "./types.ts";
import type { CapsuleProviderConnectionBindings } from "./connections.ts";
import type { PublicRun, Run } from "./runs.ts";
import { API_V1_PREFIX } from "./api-surface.ts";

/**
 * Retired edge-public deploy path. The handler returns `410 gone`; do not use
 * this for new dashboard/API/CLI clients.
 *
 * @deprecated Use Git URL Source/Capsule plan/apply routes.
 */
export const DEPLOY_PATH = `${API_V1_PREFIX}/deploy` as const;

/**
 * Legacy body of retired `POST {@link DEPLOY_PATH}`.
 *
 * `snapshotId` is an upload- or artifact-origin {@link SourceSnapshot}
 * previously created via `SPACE_UPLOADS_PATH` or
 * `SPACE_ARTIFACT_SNAPSHOTS_PATH`. `vars` becomes the InstallConfig variable
 * mapping (JSON values only; secret material never travels here — providers are
 * bound through Provider Connections). `outputAllowlist` is an explicit,
 * service-side projection contract for non-secret OpenTofu outputs; omitted
 * means no public outputs are projected. `providerConnections` binds required
 * OpenTofu providers to public Provider Connection identifiers before planning;
 * it never carries credential values.
 * `planOnly` stops after the plan Run. `autoApprove` is accepted for
 * compatibility with older CLI callers, but public clients should follow the
 * returned plan Run and call the reviewed apply route when the plan is ready.
 * `runnerId` is an optional public runner selection hint. The control plane
 * maps it to operator runner policy internally and still validates provider
 * allowlists, source policy, and credential binding before any OpenTofu
 * execution starts.
 * `modulePath` selects the OpenTofu/Terraform module path inside the uploaded
 * SourceSnapshot archive. It must be a safe relative path.
 */
export interface DeployRequest {
  readonly workspaceId?: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly name: string;
  /** Defaults to `"production"` when omitted. */
  readonly environment?: string;
  readonly snapshotId: string;
  readonly modulePath?: string;
  readonly runnerId?: string;
  readonly vars?: Readonly<Record<string, JsonValue>>;
  readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly providerConnections?: CapsuleProviderConnectionBindings;
  readonly planOnly?: boolean;
  readonly autoApprove?: boolean;
}

/**
 * Legacy response of retired `POST {@link DEPLOY_PATH}`: the resolved Capsule and the
 * plan Run the deploy started. Older responses may include `applyRun` when a
 * host explicitly chains the reviewed apply server-side; current public clients
 * should treat `planRun ?? run` as the authoritative follow-up Run.
 */
export interface DeployResponse {
  readonly capsule?: PublicCapsule;
  /** @deprecated Use capsule. */
  readonly installation: PublicCapsule;
  readonly installConfigId: string;
  /** Plan Run started by this deploy. Kept as `run` for older callers. */
  readonly run: Run;
  readonly planRun?: Run;
  readonly applyRun?: Run;
  readonly status?:
    | "planned"
    | "applying"
    | "applied"
    | "waiting_approval"
    | "failed";
  /** Set when the deploy was issued as an ordered RunGroup. */
  readonly runGroupId?: string;
  /** `true` when this `deploy` call created the Capsule. */
  readonly created: boolean;
}

export type PublicDeployResponse = Omit<
  DeployResponse,
  "run" | "planRun" | "applyRun"
> & {
  readonly run: PublicRun;
  readonly planRun?: PublicRun;
  readonly applyRun?: PublicRun;
};
