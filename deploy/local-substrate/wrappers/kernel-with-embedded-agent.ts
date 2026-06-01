/**
 * Boots takosumi kernel with an embedded runtime-agent in one process.
 *
 * Differences from `takosumi-cli server`:
 * - Imports kernel from local /workspace source and native plugins from
 *   /plugins so the running bytes match the checked-out repositories under
 *   active development (cli pins JSR).
 * - Uses local-substrate-factories.buildLocalSubstrateRegistry instead of
 *   the upstream auto-detected registry, so public-DNS providers
 *   (route53 / cloud-dns / cloudflare-dns) are import-time denied — see
 *   /local-substrate-factories/local-substrate-factories.ts.
 *
 * Order matters: the embedded agent must be started before the kernel
 * module is imported, so LIFECYCLE_AGENT_URL_ENV is set when the kernel
 * reads its env at boot. Hence dynamic import of the kernel.
 */
import { serveRuntimeAgent } from "/workspace/src/runtime-agent/server.ts";
import { mkdir, writeFile } from "node:fs/promises";
import {
  LIFECYCLE_AGENT_TOKEN_ENV,
  LIFECYCLE_AGENT_URL_ENV,
} from "/workspace/src/contract/runtime-agent-lifecycle.ts";
import type { KernelPlugin } from "/workspace/src/contract/plugin.ts";
import { currentRuntime } from "/workspace/src/kernel/shared/runtime/index.ts";
import { createPaaSApp } from "/workspace/src/kernel/bootstrap.ts";
import {
  dockerPostgresPlugin,
  type SecretWriter,
} from "/plugins/packages/kind-docker-postgres/mod.ts";
import { filesystemObjectStorePlugin } from "/plugins/packages/kind-filesystem-object-store/mod.ts";
import type {
  CoreDnsLifecycleClient,
  CoreDnsRecordDescriptor,
} from "/plugins/packages/kind-coredns-gateway/mod.ts";
import { coreDnsGatewayPlugin } from "/plugins/packages/kind-coredns-gateway/mod.ts";
import { dockerComposeWebServicePlugin } from "/plugins/packages/kind-docker-compose-web-service/mod.ts";
import { buildLocalSubstrateRegistry } from "/local-substrate-factories/local-substrate-factories.ts";

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
    `(${registry.size()} connectors, public DNS providers denied at import time)`,
);

const created = await createPaaSApp({
  runtimeEnv: { ...process.env },
  plugins: localSubstrateInstallerPlugins({
    agentUrl: agent.url,
    token,
    routeProjectionFile,
    defaultGatewayHost: env.TAKOSUMI_LOCAL_SUBSTRATE_GATEWAY_HOST ??
      "takos.app.takosumi.test",
    ingressTarget: env.TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP ?? "127.0.0.1",
  }),
});
const app = created.app;

const runtime = currentRuntime();
const server = runtime.serveHttp(app.fetch, { port: kernelPort });
console.log(
  `[local-substrate-wrapper] kernel listening on http://0.0.0.0:${kernelPort}/`,
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

function localSubstrateInstallerPlugins(input: {
  readonly agentUrl: string;
  readonly token: string;
  readonly routeProjectionFile: string;
  readonly defaultGatewayHost: string;
  readonly ingressTarget: string;
}): readonly KernelPlugin[] {
  void input.agentUrl;
  void input.token;
  return [
    dockerPostgresPlugin({
      secretStore: createMemorySecretStore(),
      useInMemoryLifecycle: true,
    }),
    filesystemObjectStorePlugin({
      rootDir: "/var/lib/takosumi/objects",
      useInMemoryLifecycle: true,
    }),
    dockerComposeWebServicePlugin({
      useInMemoryLifecycle: true,
    }),
    coreDnsGatewayPlugin({
      defaultHost: input.defaultGatewayHost,
      ingressTarget: input.ingressTarget,
      lifecycle: createLocalSubstrateGatewayLifecycle(
        input.routeProjectionFile,
      ),
    }),
  ];
}

function createMemorySecretStore(): SecretWriter {
  const values = new Map<string, string>();
  return {
    putSecret(input: Parameters<SecretWriter["putSecret"]>[0]) {
      values.set(input.name, input.value);
      return Promise.resolve({
        name: input.name,
        version: String(values.size),
        createdAt: new Date().toISOString(),
        metadata: input.metadata ?? {},
      });
    },
  };
}

function createLocalSubstrateGatewayLifecycle(
  projectionFile: string,
): CoreDnsLifecycleClient {
  const records = new Map<string, CoreDnsRecordDescriptor>();
  let counter = 0;
  return {
    async createRecord(input) {
      const recordName = `local-substrate-gateway-${++counter}`;
      const desc: CoreDnsRecordDescriptor = {
        recordName,
        fqdn: input.fqdn,
        target: input.target,
        listener: input.listener,
        routes: input.routes,
        zoneFile: projectionFile,
      };
      records.set(recordName, desc);
      await writeGatewayProjection(projectionFile, [...records.values()]);
      return desc;
    },
    describeRecord(input) {
      return Promise.resolve(records.get(input.recordName));
    },
    async deleteRecord(input) {
      const deleted = records.delete(input.recordName);
      await writeGatewayProjection(projectionFile, [...records.values()]);
      return deleted;
    },
  };
}

async function writeGatewayProjection(
  file: string,
  records: readonly CoreDnsRecordDescriptor[],
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
