/**
 * Deploy contract (`POST /api/v1/deploy`).
 *
 * The `takosumi deploy` (`wrangler deploy`-style) entry point. Given an
 * already-ingested upload or prepared-artifact {@link SourceSnapshot} (see
 * `SPACE_UPLOADS_PATH` / `SPACE_ARTIFACT_SNAPSHOTS_PATH`), the control plane
 * locates or creates the target Installation `@space/name`, synthesizes a
 * default InstallConfig when one is not supplied, and starts the deploy pipeline
 * (compatibility_check -> plan -> [approve -> apply]) against that snapshot. The
 * CLI then polls the returned plan Run and, on success, reads the OutputSnapshot.
 *
 * This is the one thing the dashboard cannot do: deploy the operator's local
 * working directory. The heavy work (normalize / gate / plan / apply) still runs
 * server-side inside the Runner Container with vault-minted, per-phase
 * credentials; the deploy request never carries credential material.
 */

import type {
  OutputAllowlistEntry,
  PublicInstallation,
} from "./installations.ts";
import type { JsonValue } from "./types.ts";
import type { InstallationProviderConnectionBindings } from "./connections.ts";
import type { PublicRun, Run } from "./runs.ts";
import { API_V1_PREFIX } from "./api-surface.ts";

/** Edge-public deploy path used by dashboard/API clients and the CLI. */
export const DEPLOY_PATH = `${API_V1_PREFIX}/deploy` as const;

/**
 * Body of `POST {@link DEPLOY_PATH}`.
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
  readonly spaceId: string;
  readonly name: string;
  /** Defaults to `"production"` when omitted. */
  readonly environment?: string;
  readonly snapshotId: string;
  readonly modulePath?: string;
  readonly runnerId?: string;
  readonly vars?: Readonly<Record<string, JsonValue>>;
  readonly outputAllowlist?: Readonly<Record<string, OutputAllowlistEntry>>;
  readonly providerConnections?: InstallationProviderConnectionBindings;
  readonly planOnly?: boolean;
  readonly autoApprove?: boolean;
}

/**
 * Response of `POST {@link DEPLOY_PATH}`: the resolved Installation and the
 * plan Run the deploy started. Older responses may include `applyRun` when a
 * host explicitly chains the reviewed apply server-side; current public clients
 * should treat `planRun ?? run` as the authoritative follow-up Run.
 */
export interface DeployResponse {
  readonly installation: PublicInstallation;
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
  /** `true` when this `deploy` call created the Installation. */
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
