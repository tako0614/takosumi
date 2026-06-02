/**
 * Boots the redesigned local-substrate `cloud` control plane: the single
 * composed app this distribution serves (account-plane + embedded service +
 * dashboard / OIDC / billing / install UI), mirroring production's one
 * `accounts.takosumi.com`.
 *
 * It reuses the published reference composer's `buildComposedServer`
 * (node-postgres profile: Postgres store + accounts handler + healthz/export
 * pre-handler + serve) and only supplies the substrate-specific overrides:
 *   - the CoreDNS gateway projection writer that hands routes to Caddy.
 *
 * Execution is EXTERNAL: `TAKOSUMI_AGENT_URL` + `TAKOSUMI_AGENT_TOKEN` (set in
 * env/cloud.env, pointing at the `agent` service) are read by the service's
 * bootstrap agent detection, so source / lifecycle / capability operations are
 * dispatched to the `agent` container. This process holds NO docker.sock and
 * never spawns subprocesses — that privilege lives only on the agent, which
 * mirrors production (a Workers control plane cannot embed a subprocess agent).
 *
 * Imports straddle three mounts:
 *   - /workspace        = takosumi (the composer; buildComposedServer)
 *   - /takosumi         = takosumi source (the dev-seam `@takosjp/takosumi`
 *                         target the node-postgres import map points at)
 * and run under the takosumi workspace config so the composer graph
 * resolves.
 */
import { buildComposedServer } from "/workspace/deploy/node-postgres/src/server.ts";
import { mkdir, writeFile } from "node:fs/promises";

interface GatewayProjectionRecord {
  readonly recordName?: unknown;
  readonly fqdn?: unknown;
  readonly listener?: unknown;
  readonly target?: unknown;
  readonly routes?: unknown;
}

const env = { ...process.env };

const routeProjectionFile = env.TAKOSUMI_LOCAL_SUBSTRATE_GATEWAY_ROUTES_FILE ??
  "/local-substrate-runtime/gateway-routes.json";
await writeGatewayProjection(routeProjectionFile, []);

if (!env.TAKOSUMI_AGENT_URL || !env.TAKOSUMI_AGENT_TOKEN) {
  console.warn(
    "[local-substrate-cloud] TAKOSUMI_AGENT_URL/TOKEN unset — the embedded " +
      "service will register no providers and applies will fail until the " +
      "external agent is configured.",
  );
}
console.log(
  `[local-substrate-cloud] composing control plane; execution dispatched to ` +
    `${env.TAKOSUMI_AGENT_URL ?? "(no agent)"}`,
);

// Blocks on serveOnAnyRuntime (port 8787 from config). The service's bootstrap
// agent detection reads TAKOSUMI_AGENT_URL/TOKEN from this process env.
await buildComposedServer({
  plugins: [],
});

async function writeGatewayProjection(
  file: string,
  records: readonly GatewayProjectionRecord[],
): Promise<void> {
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (dir.length > 0) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        records: records.map((record) => ({
          recordName: record.recordName,
          fqdn: record.fqdn,
          listener: record.listener,
          target: record.target,
          routes: record.routes,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
