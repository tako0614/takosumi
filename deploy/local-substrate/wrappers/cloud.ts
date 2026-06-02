/**
 * Boots the redesigned local-substrate `cloud` control plane: the single
 * composed app this distribution serves (account-plane + embedded service +
 * dashboard / OIDC / billing / install UI), mirroring production's one
 * `accounts.takosumi.com`.
 *
 * It reuses the published reference composer's `buildComposedServer`
 * (node-postgres profile: Postgres store + accounts handler + healthz/export
 * pre-handler + serve) and only supplies the substrate-specific overrides:
 *   - the local backend adapter plugins (docker-postgres /
 *     filesystem-object-store / docker-compose-web-service / coredns-gateway)
 *     for source fixtures (in-memory lifecycle; the real source / capability
 *     execution is dispatched to the external `agent`);
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
 *                         target the node-postgres import map points at, and
 *                         the TakosumiPlugin contract type)
 *   - /plugins          = takosumi-plugins (the native kind plugins)
 * and run under the takosumi workspace config so the composer graph
 * resolves; the kind-plugin specifier scopes are supplied by that config.
 */
import { buildComposedServer } from "/workspace/deploy/node-postgres/src/server.ts";
import { mkdir, writeFile } from "node:fs/promises";
import type { TakosumiPlugin } from "/takosumi/src/contract/plugin.ts";
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

type ServerOverrides = NonNullable<Parameters<typeof buildComposedServer>[0]>;

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
  // Cross-mount TakosumiPlugin type identity (takosumi-plugins' contract dep vs
  // the composer's @takosjp/takosumi contract) differs structurally-equal but
  // nominally; bridge with a cast at the boundary.
  plugins: localSubstrateInstallerPlugins({
    routeProjectionFile,
    defaultGatewayHost: env.TAKOSUMI_LOCAL_SUBSTRATE_GATEWAY_HOST ??
      "takos.app.takosumi.test",
    ingressTarget: env.TAKOSUMI_LOCAL_SUBSTRATE_INGRESS_IP ?? "127.0.0.1",
  }) as unknown as ServerOverrides["plugins"],
});

function localSubstrateInstallerPlugins(input: {
  readonly routeProjectionFile: string;
  readonly defaultGatewayHost: string;
  readonly ingressTarget: string;
}): readonly TakosumiPlugin[] {
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
