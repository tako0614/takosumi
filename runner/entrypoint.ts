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
import {
  handleRunnerRequestWithDependencies,
  runnerMutationCustodyMode,
} from "./lib/http_server.ts";
import { port, RUN_ROOT, RUNNER_START_SERVER_ENV } from "./lib/constants.ts";
import { ensureCustodyDirectory } from "./lib/run_completion.ts";
import { acquireRunRootOwnership, type RunRootOwnership } from "./lib/run_root_ownership.ts";

// --- Public surface re-exports (unchanged from the pre-split entrypoint) ---
export { handleRunnerRequest } from "./lib/http_server.ts";
export { handleRunnerRequestWithDependencies } from "./lib/http_server.ts";
export { redactRunnerOutput } from "./lib/redaction.ts";
export {
  isSourceSyncRequest,
  parseSourceSyncSource,
  parseSourceCredentials,
  parseLsRemoteCommit,
  resolveHighestStableSemverTag,
  handleDepStateRestoreRequest,
} from "./lib/source_sync.ts";
export {
  assertSourceUrlPolicy,
  assertSafeArchiveObjectKey,
  assertSafeZstdTarArchive,
} from "./lib/policy.ts";
export {
  parseGeneratedRoot,
  parseSourceBuild,
  assertNoLegacyArtifactDispatch,
} from "./lib/parsing.ts";
export { runSourceBuild } from "./lib/source_build.ts";
export { commandContextFromRequest, buildPhaseEnv } from "./lib/credentials.ts";
export {
  assertRunnerPolicyForRequest,
  requiredProviderSourcesFromTerraformText,
  resourceChangesFromPlanJson,
  plannedOutputsFromPlanJson,
} from "./lib/providers.ts";
export { safeRunId } from "./lib/util.ts";
export type { CommandContext } from "./lib/types.ts";

// Only bind a port when run as the container entrypoint; importing this module
// (e.g. for a unit test of commandContextFromRequest) must not start a server.
/** Private composition: v2 is never selected by an HTTP request or a new env flag. */
export async function startRunnerHttpServer(options: {
  readonly hostname?: string;
  readonly port?: number;
  readonly localPreparationV2?: boolean;
} = {}): Promise<{ server: ReturnType<typeof Bun.serve>; close(): Promise<void> }> {
  const custodyMode = runnerMutationCustodyMode();
  if (options.localPreparationV2 && custodyMode !== "local-http") {
    throw new Error("local preparation requires local HTTP custody");
  }
  let owner: RunRootOwnership | undefined;
  if (custodyMode === "local-http" && options.localPreparationV2 === true) {
    // Only the private v2 candidate acquires lifetime ownership. The normal
    // local HTTP v1 boot retains its existing lazy run-root behavior.
    // Initialize only the root and custody directory before listen; no run
    // workspace writer starts here.
    await ensureCustodyDirectory(true);
    owner = await acquireRunRootOwnership(RUN_ROOT);
  }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: options.hostname ?? "0.0.0.0",
      port: options.port ?? port,
      fetch: (request) => handleRunnerRequestWithDependencies(request, {
        ...(custodyMode ? { mutationCustodyMode: custodyMode } : {}),
        localPreparationV2: options.localPreparationV2 === true,
        runRootOwnership: owner,
      }),
    });
  } catch (error) {
    await owner?.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    server,
    close: () => closePromise ??= (async () => {
      await server.stop();
      await owner?.close();
    })(),
  };
}

if (Bun.env[RUNNER_START_SERVER_ENV] === "1" || import.meta.main) {
  try {
    const running = await startRunnerHttpServer();
    console.log("Takosumi OpenTofu runner listening", {
      hostname: "0.0.0.0",
      port,
    });
    const onSignal = () => {
      void running.close().catch(() => {
        // Never print raw child, filesystem, source, or credential diagnostics.
        process.stderr.write("runner graceful shutdown failed\n");
        process.exitCode = 1;
      });
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  } catch {
    process.stderr.write("runner startup refused\n");
    process.exitCode = 1;
  }
}
