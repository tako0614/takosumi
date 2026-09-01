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

/**
 * Optional shared-bearer gate for the standalone (compose-network) runner.
 * The Cloudflare composition talks to the runner DO over an internal binding
 * and local-substrate keeps loopback wiring, so both leave the token unset;
 * the promoted self-host profile sets `TAKOSUMI_RUNNER_SHARED_TOKEN` on both
 * sides so a reachable runner port alone never accepts jobs. Health probes
 * stay open for container healthchecks.
 */
function authorizedRunnerFetch(sharedToken: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" || url.pathname === "/container/health") {
      return await handleRunnerRequest(request);
    }
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!timingSafeEquals(presented, sharedToken)) {
      return Response.json({ error: "unauthenticated" }, { status: 401 });
    }
    return await handleRunnerRequest(request);
  };
}

function timingSafeEquals(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  // Compare over a fixed-length digest-like fold so length differences do not
  // change the comparison time.
  // Compare over a FIXED span so the loop count never depends on either
  // input's length. The previous version iterated max(a,b) times, which leaked
  // the presented token's length through timing while claiming not to.
  const span = 64;
  let mismatch = a.length === b.length ? 0 : 1;
  for (let index = 0; index < span; index += 1) {
    mismatch |= (a[index % Math.max(a.length, 1)] ?? 0) ^
      (b[index % Math.max(b.length, 1)] ?? 0);
  }
  return mismatch === 0;
}

// Only bind a port when run as the container entrypoint; importing this module
// (e.g. for a unit test of commandContextFromRequest) must not start a server.
if (Bun.env[RUNNER_START_SERVER_ENV] === "1" || import.meta.main) {
  const sharedToken = Bun.env.TAKOSUMI_RUNNER_SHARED_TOKEN?.trim();
  console.log("Takosumi OpenTofu runner listening", {
    hostname: "0.0.0.0",
    port,
    authenticated: Boolean(sharedToken),
  });
  Bun.serve({
    hostname: "0.0.0.0",
    port,
    fetch: sharedToken
      ? authorizedRunnerFetch(sharedToken)
      : handleRunnerRequest,
  });
}
