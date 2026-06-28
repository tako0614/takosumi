/**
 * Capsule lifecycle routes — thin composition barrel.
 *
 * The former ~3900-LOC god-file was decomposed (pure moves) into focused
 * sibling modules, each owning one handler family plus its family-local
 * helpers:
 *
 *   - installation-create-import-routes.ts  — create
 *   - installation-status-routes.ts         — status / uninstall / revision
 *   - installation-plan-materialize-routes.ts — plan / materialize / usage
 *   - installation-export-routes.ts         — export request / poll / download
 *
 * Cross-family helpers (deploy-control projections, activated-HTTP-domain
 * projections, shared service-binding / service-grant parsers, revision digests)
 * live in installation-lifecycle-shared.ts; the hash-chained ledger-event
 * append helper is re-exported through installation-ledger-events.ts. This
 * module is the stable lifecycle route entrypoint.
 */
export { handleCreateAppCapsule } from "./installation-create-import-routes.ts";
export {
  handleUninstallAppCapsule,
  handleUpdateAppCapsuleRevision,
  handleUpdateAppCapsuleStatus,
} from "./installation-status-routes.ts";
export {
  handlePlanAppCapsuleDeployment,
  handleReportCapsuleBillingUsage,
  handleRequestAppCapsuleMaterialize,
} from "./installation-plan-materialize-routes.ts";
export {
  handleDownloadAppCapsuleExport,
  handleGetAppCapsuleExportOperation,
  handleRequestAppCapsuleExport,
} from "./installation-export-routes.ts";
