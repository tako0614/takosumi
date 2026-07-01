// runner/entrypoint.ts
//
// OpenTofu runner container HTTP server — composition/server shell.
//
// The runner implementation was split (P3 god-file split) into cohesive
// modules under runner/lib/. This file is the stable entry point: it owns the
// container server bootstrap and RE-EXPORTS the public surface that external
// importers depend on (the worker DO, deploy/node-postgres local runner, and
// the runner/worker test suites). The runner image COPYs runner/lib/ alongside
// this file (see runner/Dockerfile) so the relative imports resolve at runtime.
import { handleRunnerRequest } from "./lib/http_server.ts";
import { port, RUNNER_START_SERVER_ENV } from "./lib/constants.ts";

// --- Public surface re-exports (unchanged from the pre-split entrypoint) ---
export { handleRunnerRequest } from "./lib/http_server.ts";
export { redactRunnerOutput } from "./lib/redaction.ts";
export {
  isSourceSyncRequest,
  parseSourceSyncSource,
  parseSourceCredentials,
  parseLsRemoteCommit,
  resolveSourceCommit,
  shallowCloneAtCommit,
  handleDepStateRestoreRequest,
} from "./lib/source_sync.ts";
export {
  assertSourceUrlPolicy,
  assertSafeArchiveObjectKey,
  assertSafeZstdTarArchive,
} from "./lib/policy.ts";
export {
  parseGeneratedRoot,
  assertNoLegacyArtifactDispatch,
} from "./lib/parsing.ts";
export { commandContextFromRequest, buildPhaseEnv } from "./lib/credentials.ts";
export {
  assertRunnerPolicyForRequest,
  requiredProviderSourcesFromTerraformText,
  resourceChangesFromPlanJson,
} from "./lib/providers.ts";
export { safeRunId } from "./lib/util.ts";
export type { CommandContext } from "./lib/types.ts";

// Only bind a port when run as the container entrypoint; importing this module
// (e.g. for a unit test of commandContextFromRequest) must not start a server.
if (Bun.env[RUNNER_START_SERVER_ENV] === "1" || import.meta.main) {
  console.log("Takosumi OpenTofu runner listening", {
    hostname: "0.0.0.0",
    port,
  });
  Bun.serve({ hostname: "0.0.0.0", port, fetch: handleRunnerRequest });
}
