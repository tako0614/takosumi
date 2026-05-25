/**
 * Boots takosumi kernel with an embedded runtime-agent in one process.
 *
 * Differences from `takosumi-cli server`:
 * - Imports kernel from local /workspace source so the running bytes match
 *   the takosumi/ submodule under active development (cli pins JSR).
 * - Uses local-substrate-factories.buildLocalSubstrateRegistry instead of
 *   the upstream auto-detected registry, so public-DNS providers
 *   (route53 / cloud-dns / cloudflare-dns) are import-time denied — see
 *   /local-substrate-factories/local-substrate-factories.ts.
 *
 * Order matters: the embedded agent must be started before the kernel
 * module is imported, so LIFECYCLE_AGENT_URL_ENV is set when the kernel
 * reads its env at boot. Hence dynamic import of the kernel.
 */
import { serveRuntimeAgent } from "/workspace/packages/runtime-agent/src/server.ts";
import {
  LIFECYCLE_AGENT_TOKEN_ENV,
  LIFECYCLE_AGENT_URL_ENV,
} from "/workspace/packages/contract/src/runtime-agent-lifecycle.ts";
import type { KernelPlugin } from "/workspace/packages/contract/src/plugin.ts";
import type {
  ProviderPlugin,
} from "/workspace/packages/contract/src/provider-plugin.ts";
import {
  kernelPluginFromProviderPlugin,
} from "/workspace/packages/contract/src/kernel-plugin-adapter.ts";
import { currentRuntime } from "/workspace/packages/kernel/src/shared/runtime/index.ts";
import { createPaaSApp } from "/workspace/packages/kernel/src/bootstrap.ts";
import {
  TAKOSUMI_REFERENCE_KIND_ALIASES,
  TAKOSUMI_REFERENCE_KIND_URIS,
} from "/workspace/packages/plugins/src/kinds/mod.ts";
import {
  createTakosumiProductionProviders,
} from "/workspace/packages/plugins/src/shape-providers/factories.ts";
import type {
  CoreDnsLifecycleClient,
  CoreDnsRecordDescriptor,
} from "/workspace/packages/plugins/src/shape-providers/gateway/coredns-local.ts";
import {
  selfhostCoreDnsGatewayProvider,
} from "/workspace/packages/selfhost-providers/src/gateway-selfhost-coredns.ts";
import { buildLocalSubstrateRegistry } from "/local-substrate-factories/local-substrate-factories.ts";

const agentPort = Number(Deno.env.get("TAKOSUMI_AGENT_PORT") ?? "8789");
const kernelPort = Number(Deno.env.get("PORT") ?? "8788");

const env = Deno.env.toObject();
const registry = buildLocalSubstrateRegistry(env);
const token = env[LIFECYCLE_AGENT_TOKEN_ENV] ?? randomToken();

const agent = serveRuntimeAgent({
  registry,
  token,
  port: agentPort,
  hostname: "127.0.0.1",
});

Deno.env.set(LIFECYCLE_AGENT_URL_ENV, agent.url);
Deno.env.set(LIFECYCLE_AGENT_TOKEN_ENV, token);

const routeProjectionFile = env.TAKOSUMI_LOCAL_SUBSTRATE_GATEWAY_ROUTES_FILE ??
  "/local-substrate-runtime/gateway-routes.json";
await writeGatewayProjection(routeProjectionFile, []);

console.log(
  `[local-substrate-wrapper] embedded runtime-agent at ${agent.url} ` +
    `(${registry.size()} connectors, public DNS providers denied at import time)`,
);

const created = await createPaaSApp({
  runtimeEnv: Deno.env.toObject(),
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
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
    Deno.exit(0);
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
  const providers: readonly ProviderPlugin[] =
    createTakosumiProductionProviders({
      agentUrl: input.agentUrl,
      token: input.token,
      enableAws: false,
      enableGcp: false,
      enableCloudflare: false,
      enableAzure: false,
      enableKubernetes: false,
      enableDenoDeploy: false,
      enableSelfhost: true,
    });
  const byId: Map<string, ProviderPlugin> = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  return [
    providerKernelPlugin(
      byId,
      "@takos/selfhost-postgres",
      TAKOSUMI_REFERENCE_KIND_URIS.postgres,
    ),
    providerKernelPlugin(
      byId,
      "@takos/selfhost-filesystem",
      TAKOSUMI_REFERENCE_KIND_URIS["object-store"],
    ),
    providerKernelPlugin(
      byId,
      "@takos/selfhost-docker-compose",
      TAKOSUMI_REFERENCE_KIND_URIS["web-service"],
    ),
    selfhostCoreDnsGatewayProvider({
      defaultHost: input.defaultGatewayHost,
      ingressTarget: input.ingressTarget,
      lifecycle: createLocalSubstrateGatewayLifecycle(
        input.routeProjectionFile,
      ),
    }),
  ];
}

function providerKernelPlugin(
  byId: ReadonlyMap<string, ProviderPlugin>,
  providerId: string,
  kindUri: string,
): KernelPlugin {
  const provider = byId.get(providerId);
  if (!provider) {
    throw new Error(`local-substrate provider missing: ${providerId}`);
  }
  return kernelPluginFromProviderPlugin({
    provider,
    kindUri,
    capabilities: provider.capabilities,
  });
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
    await Deno.mkdir(dir, { recursive: true });
  }
  await Deno.writeTextFile(
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
  );
}
