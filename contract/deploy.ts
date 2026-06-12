/**
 * Deploy contract (`POST /api/deploy`).
 *
 * The `takosumi deploy` (`wrangler deploy`-style) entry point. Given an
 * already-ingested upload {@link SourceSnapshot} (see `SPACE_UPLOADS_PATH`), the
 * control plane locates or creates the target Installation `@space/name`,
 * synthesizes a default InstallConfig when one is not supplied, and starts the
 * deploy pipeline (compatibility_check -> plan -> [approve -> apply]) against
 * that snapshot. The CLI then polls the returned plan Run and, on success,
 * reads the OutputSnapshot.
 *
 * This is the one thing the dashboard cannot do: deploy the operator's local
 * working directory. The heavy work (normalize / gate / plan / apply) still runs
 * server-side inside the Runner Container with vault-minted, per-phase
 * credentials; the deploy request never carries credential material.
 */

import type { PublicInstallation } from "./installations.ts";
import type { Run } from "./runs.ts";
import { INTERNAL_V1_PREFIX } from "./api-surface.ts";

/** INTERNAL deploy-control seam path (`/internal/v1`, reached in-process). */
export const DEPLOY_PATH = `${INTERNAL_V1_PREFIX}/deploy` as const;

/**
 * Body of `POST {@link DEPLOY_PATH}`.
 *
 * `snapshotId` is an upload-origin {@link SourceSnapshot} previously created via
 * `SPACE_UPLOADS_PATH`. `vars` becomes the InstallConfig variable mapping
 * (string values only; secret material never travels here — providers are bound
 * through Connections). `planOnly` stops after the plan Run; `autoApprove`
 * approves and applies the plan without a manual approval gate.
 */
export interface DeployRequest {
  readonly spaceId: string;
  readonly name: string;
  /** Defaults to `"production"` when omitted. */
  readonly environment?: string;
  readonly snapshotId: string;
  readonly vars?: Readonly<Record<string, string>>;
  readonly planOnly?: boolean;
  readonly autoApprove?: boolean;
}

/**
 * Response of `POST {@link DEPLOY_PATH}`: the resolved Installation and the
 * plan Run the deploy started. When `autoApprove` is set the apply Run is
 * chained server-side; the CLI follows it from `run` via the run/logs routes.
 */
export interface DeployResponse {
  readonly installation: PublicInstallation;
  readonly installConfigId: string;
  readonly run: Run;
  /** Set when the deploy was issued as an ordered RunGroup. */
  readonly runGroupId?: string;
  /** `true` when this `deploy` call created the Installation. */
  readonly created: boolean;
}
