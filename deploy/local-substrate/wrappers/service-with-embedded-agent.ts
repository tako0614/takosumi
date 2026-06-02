/**
 * Boots takosumi service with an embedded runtime-agent in one process.
 *
 * Differences from `takosumi-cli server`:
 * - Imports service from local /workspace source so the running bytes match
 *   the checked-out Takosumi repository under active development.
 * - Uses local-substrate-factories.buildLocalSubstrateRegistry instead of
 *   provider package discovery. The default local registry is empty; operators
 *   own OpenTofu/provider materialization wiring.
 *
 * Order matters: the embedded agent must be started before the service
 * module is imported, so LIFECYCLE_AGENT_URL_ENV is set when the service
 * reads its env at boot. Hence dynamic import of the service.
 */
import { serveRuntimeAgent } from "/workspace/src/runtime-agent/server.ts";
import { mkdir, writeFile } from "node:fs/promises";
import {
  LIFECYCLE_AGENT_TOKEN_ENV,
  LIFECYCLE_AGENT_URL_ENV,
} from "/workspace/src/contract/runtime-agent-lifecycle.ts";
import { currentRuntime } from "/workspace/src/service/shared/runtime/index.ts";
import { createTakosumiService } from "/workspace/src/service/bootstrap.ts";
import { buildLocalSubstrateRegistry } from "/local-substrate-factories/local-substrate-factories.ts";

interface GatewayProjectionRecord {
  readonly recordName?: unknown;
  readonly fqdn?: unknown;
  readonly listener?: unknown;
  readonly target?: unknown;
  readonly routes?: unknown;
}

const agentPort = Number(process.env.TAKOSUMI_AGENT_PORT ?? "8789");
const kernelPort = Number(process.env.PORT ?? "8788");

const env = { ...process.env };
const registry = buildLocalSubstrateRegistry(env);
const token = env[LIFECYCLE_AGENT_TOKEN_ENV] ?? randomToken();

const agent = serveRuntimeAgent({
  registry,
  token,
  port: agentPort,
  hostname: "127.0.0.1",
});

process.env[LIFECYCLE_AGENT_URL_ENV] = agent.url;
process.env[LIFECYCLE_AGENT_TOKEN_ENV] = token;

const routeProjectionFile = env.TAKOSUMI_LOCAL_SUBSTRATE_GATEWAY_ROUTES_FILE ??
  "/local-substrate-runtime/gateway-routes.json";
await writeGatewayProjection(routeProjectionFile, []);

console.log(
  `[local-substrate-wrapper] embedded runtime-agent at ${agent.url} ` +
    `(${registry.size()} runtime handlers)`,
);

const created = await createTakosumiService({
  runtimeEnv: { ...process.env },
  implementations: [],
});
const app = created.app;

const runtime = currentRuntime();
const server = runtime.serveHttp(app.fetch, { port: kernelPort });
console.log(
  `[local-substrate-wrapper] service listening on http://0.0.0.0:${kernelPort}/`,
);

const shutdown = (signal: string) => {
  console.log(`[local-substrate-wrapper] received ${signal}, draining...`);
  Promise.allSettled([agent.shutdown(), server.shutdown()]).finally(() => {
    process.exit(0);
  });
};
runtime.onSignal("SIGINT", () => shutdown("SIGINT"));
runtime.onSignal("SIGTERM", () => shutdown("SIGTERM"));

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

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
