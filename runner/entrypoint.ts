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
import {
  acquireRunRootOwnership,
  adoptRunRootOwnershipFromStdin,
  assertRunRootOwnershipFor,
  type RunRootOwnership,
} from "./lib/run_root_ownership.ts";
import type { PreparationV2ChildSupervisor } from "./lib/preparation_v2_child_supervisor.ts";

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
  /** Private composition hook for the supervised inherited-OFD child only. */
  readonly runRootOwnership?: RunRootOwnership;
} = {}): Promise<{ server: ReturnType<typeof Bun.serve>; close(): Promise<void> }> {
  const custodyMode = runnerMutationCustodyMode();
  if (options.localPreparationV2 && custodyMode !== "local-http") {
    throw new Error("local preparation requires local HTTP custody");
  }
  if (options.runRootOwnership && options.localPreparationV2 !== true) {
    throw new Error("inherited ownership requires private local preparation");
  }
  let owner: RunRootOwnership | undefined;
  if (custodyMode === "local-http" && options.localPreparationV2 === true) {
    // Only the private v2 candidate acquires lifetime ownership. The normal
    // local HTTP v1 boot retains its existing lazy run-root behavior.
    // Initialize only the root and custody directory before listen; no run
    // workspace writer starts here.
    if (options.runRootOwnership) {
      assertRunRootOwnershipFor(options.runRootOwnership, RUN_ROOT);
      owner = options.runRootOwnership;
    } else {
      await ensureCustodyDirectory(true);
      owner = await acquireRunRootOwnership(RUN_ROOT);
    }
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

const privateEntrypointMode = import.meta.main ? Bun.argv[2] : undefined;
if (import.meta.main && privateEntrypointMode === "--local-preparation-v2-child") {
  await runInheritedPreparationV2Child();
} else if (
  import.meta.main && privateEntrypointMode === "--local-preparation-v2-supervisor"
) {
  await runPreparationV2Supervisor();
} else if (import.meta.main && privateEntrypointMode !== undefined) {
  process.stderr.write("runner startup refused\n");
  process.exitCode = 1;
} else if (Bun.env[RUNNER_START_SERVER_ENV] === "1" || import.meta.main) {
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

async function runInheritedPreparationV2Child(): Promise<void> {
  let owner: RunRootOwnership | undefined;
  try {
    if (runnerMutationCustodyMode() !== "local-http") throw new Error();
    owner = await adoptRunRootOwnershipFromStdin(RUN_ROOT);
    const running = await startRunnerHttpServer({
      localPreparationV2: true,
      runRootOwnership: owner,
    });
    owner = undefined;
    const onSignal = () => {
      void running.close().then(
        () => process.exit(0),
        () => {
          process.stderr.write("runner graceful shutdown failed\n");
          process.exit(1);
        },
      );
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  } catch {
    await owner?.close().catch(() => {});
    process.stderr.write("runner private startup refused\n");
    process.exitCode = 1;
  }
}

async function runPreparationV2Supervisor(): Promise<void> {
  if (runnerMutationCustodyMode() !== "local-http") {
    process.stderr.write("runner private startup refused\n");
    process.exitCode = 1;
    return;
  }
  let owner: RunRootOwnership | undefined;
  let supervisor: PreparationV2ChildSupervisor | undefined;
  let stopRequested = false;
  let runnerLaunchAttempted = false;
  let removeSignalHandlers = () => {};
  try {
    const { PreparationV2ChildSupervisor } = await import(
      "./lib/preparation_v2_child_supervisor.ts"
    );
    await ensureCustodyDirectory(true);
    owner = await acquireRunRootOwnership(RUN_ROOT);
    supervisor = new PreparationV2ChildSupervisor(RUN_ROOT, owner);
    const onSignal = () => {
      stopRequested = true;
      void signalOwnedRunner(supervisor);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    removeSignalHandlers = () => {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    };
    if (!stopRequested) {
      const env = Object.fromEntries(
        Object.entries(Bun.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      runnerLaunchAttempted = true;
      const result = await supervisor.runRunnerUntilDrained(
        process.execPath,
        ["--no-env-file", import.meta.path, "--local-preparation-v2-child"],
        { env, drainTimeoutMs: 30_000, retryIntervalMs: 250 },
      );
      if (result.exitCode !== 0 || result.signalCode !== null) process.exitCode = 1;
    }
    await supervisor.close();
    supervisor = undefined;
    await owner.close();
    owner = undefined;
    removeSignalHandlers();
  } catch {
    process.exitCode = 1;
    if (!runnerLaunchAttempted) {
      // No Runner child was launched, so an initial Busy/setup refusal has no
      // descendant custody to retain and must not strand a future successor.
      try {
        if (supervisor) await supervisor.close();
        supervisor = undefined;
        await owner?.close();
        owner = undefined;
        removeSignalHandlers();
        process.stderr.write("runner private startup unavailable\n");
        return;
      } catch {
        // If even pre-child cleanup is uncertain, preserve the owner below.
      }
    }
    process.stderr.write("runner child supervision failed; root remains owned\n");
    // An uncertain child tree must not be released by this process. Keep the
    // lease and subreaper alive; no successor starts from this private mode.
    await new Promise<void>(() => {
      setInterval(() => {}, 60_000);
    });
  }
}

async function signalOwnedRunner(
  supervisor: PreparationV2ChildSupervisor | undefined,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (supervisor && performance.now() < deadline) {
    if (supervisor.signalRunner("SIGTERM")) return;
    await Bun.sleep(10);
  }
}
