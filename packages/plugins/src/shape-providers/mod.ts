/**
 * Shape-provider package entry point.
 *
 * The production-grade plugin set is built by
 * `createTakosumiProductionProviders` — every plugin posts lifecycle
 * envelopes to a runtime-agent (see `_runtime_agent_lifecycle.ts`). The
 * in-memory variant lives here too for templates and end-to-end tests
 * that want a self-contained workflow without spinning up an agent.
 */

import { registerProvider } from "takosumi-contract";
import type { ProviderPlugin } from "takosumi-contract";
import {
  createAwsS3ObjectStoreProvider,
  InMemoryAwsS3Lifecycle,
} from "./object-store/aws-s3.ts";
import {
  createCloudflareR2ObjectStoreProvider,
  InMemoryCloudflareR2Lifecycle,
} from "./object-store/cloudflare-r2.ts";
import {
  createFilesystemObjectStoreProvider,
  InMemoryFilesystemLifecycle,
} from "./object-store/filesystem.ts";
import {
  createGcsObjectStoreProvider,
  InMemoryGcsLifecycle,
} from "./object-store/gcp-gcs.ts";
import {
  createMinioObjectStoreProvider,
  InMemoryMinioLifecycle,
} from "./object-store/minio.ts";
import {
  createDockerComposeWebServiceProvider,
  InMemoryDockerComposeLifecycle,
} from "./web-service/docker-compose.ts";
import {
  createAwsFargateWebServiceProvider,
  InMemoryAwsFargateLifecycle,
} from "./web-service/aws-fargate.ts";
import {
  createCloudRunWebServiceProvider,
  InMemoryCloudRunLifecycle,
} from "./web-service/cloud-run.ts";
import {
  createCloudflareContainerWebServiceProvider,
  InMemoryCloudflareContainerLifecycle,
} from "./web-service/cloudflare-container.ts";
import {
  createK3sDeploymentWebServiceProvider,
  InMemoryK3sDeploymentLifecycle,
} from "./web-service/k3s-deployment.ts";
import {
  createSystemdUnitWebServiceProvider,
  InMemorySystemdUnitLifecycle,
} from "./web-service/systemd-unit.ts";
import {
  createLocalDockerPostgresProvider,
  InMemoryLocalDockerPostgresLifecycle,
} from "./database-postgres/local-docker.ts";
import {
  createAwsRdsProvider,
  InMemoryAwsRdsLifecycle,
} from "./database-postgres/aws-rds.ts";
import {
  createCloudSqlProvider,
  InMemoryCloudSqlLifecycle,
} from "./database-postgres/cloud-sql.ts";
import {
  createCloudflareDnsProvider,
  InMemoryCloudflareDnsLifecycle,
} from "./custom-domain/cloudflare-dns.ts";
import {
  createRoute53Provider,
  InMemoryRoute53Lifecycle,
} from "./custom-domain/route53.ts";
import {
  createCloudDnsProvider,
  InMemoryCloudDnsLifecycle,
} from "./custom-domain/cloud-dns.ts";
import {
  createCoreDnsLocalProvider,
  InMemoryCoreDnsLifecycle,
} from "./custom-domain/coredns-local.ts";
import {
  createCloudflareWorkersProvider,
  InMemoryCloudflareWorkersLifecycle,
} from "./worker/cloudflare-workers.ts";
import {
  createDenoDeployProvider,
  InMemoryDenoDeployLifecycle,
} from "./worker/deno-deploy.ts";

export {
  createTakosumiProductionProviders,
  RuntimeAgentLifecycle,
} from "./factories.ts";
export type {
  RuntimeAgentClientOptions,
  TakosumiProductionProviderOptions,
} from "./factories.ts";
export {
  registerBundledArtifactKinds,
  TAKOSUMI_BUNDLED_ARTIFACT_KINDS,
} from "./_artifact_kinds_bundled.ts";

/**
 * Erases provider-plugin generics for storage in the generic registry.
 *
 * Plugin factories return `ProviderPlugin<SpecificSpec, SpecificOutputs>`,
 * but the registry stores plugins keyed by `implements.id` and only ever
 * dispatches each plugin with specs of its declared shape kind — so the
 * widening to bare `ProviderPlugin` is safe at runtime. Centralizing the
 * cast here keeps individual call sites readable.
 */
function asGenericProvider<S, O, C extends string>(
  plugin: ProviderPlugin<S, O, C>,
): ProviderPlugin {
  return plugin as ProviderPlugin;
}

/**
 * Build the full set of in-memory shape-provider plugins. Used by tests and
 * by the CLI's local-runner mode where deploys execute in-process without
 * cloud credentials.
 */
export function createInMemoryTakosumiProviders(): readonly ProviderPlugin[] {
  return [
    asGenericProvider(createAwsS3ObjectStoreProvider({
      lifecycle: new InMemoryAwsS3Lifecycle(),
    })),
    asGenericProvider(createCloudflareR2ObjectStoreProvider({
      lifecycle: new InMemoryCloudflareR2Lifecycle("test-account"),
      accountId: "test-account",
    })),
    asGenericProvider(createFilesystemObjectStoreProvider({
      lifecycle: new InMemoryFilesystemLifecycle("/var/lib/takos/object-store"),
      rootDir: "/var/lib/takos/object-store",
    })),
    asGenericProvider(createGcsObjectStoreProvider({
      lifecycle: new InMemoryGcsLifecycle("test-project"),
      project: "test-project",
    })),
    asGenericProvider(createMinioObjectStoreProvider({
      lifecycle: new InMemoryMinioLifecycle("http://minio.local:9000"),
      endpoint: "http://minio.local:9000",
    })),
    asGenericProvider(createDockerComposeWebServiceProvider({
      lifecycle: new InMemoryDockerComposeLifecycle(),
    })),
    asGenericProvider(createAwsFargateWebServiceProvider({
      lifecycle: new InMemoryAwsFargateLifecycle("takos-cluster", "us-east-1"),
      clusterName: "takos-cluster",
      region: "us-east-1",
    })),
    asGenericProvider(createCloudRunWebServiceProvider({
      lifecycle: new InMemoryCloudRunLifecycle("test-project", "us-central1"),
      project: "test-project",
      region: "us-central1",
    })),
    asGenericProvider(createCloudflareContainerWebServiceProvider({
      lifecycle: new InMemoryCloudflareContainerLifecycle("test-account"),
      accountId: "test-account",
    })),
    asGenericProvider(createK3sDeploymentWebServiceProvider({
      lifecycle: new InMemoryK3sDeploymentLifecycle(),
      namespace: "takos",
    })),
    asGenericProvider(createSystemdUnitWebServiceProvider({
      lifecycle: new InMemorySystemdUnitLifecycle(),
    })),
    asGenericProvider(createLocalDockerPostgresProvider({
      lifecycle: new InMemoryLocalDockerPostgresLifecycle(),
    })),
    asGenericProvider(createAwsRdsProvider({
      lifecycle: new InMemoryAwsRdsLifecycle("us-east-1"),
    })),
    asGenericProvider(createCloudSqlProvider({
      lifecycle: new InMemoryCloudSqlLifecycle(
        "test-project",
        "us-central1",
      ),
      project: "test-project",
      region: "us-central1",
    })),
    asGenericProvider(createCloudflareDnsProvider({
      lifecycle: new InMemoryCloudflareDnsLifecycle("test-zone"),
      zoneId: "test-zone",
      accountId: "test-account",
    })),
    asGenericProvider(createRoute53Provider({
      lifecycle: new InMemoryRoute53Lifecycle("Z123"),
      hostedZoneId: "Z123",
    })),
    asGenericProvider(createCloudDnsProvider({
      lifecycle: new InMemoryCloudDnsLifecycle("test-project", "test-zone"),
      project: "test-project",
      zoneName: "test-zone",
    })),
    asGenericProvider(createCoreDnsLocalProvider({
      lifecycle: new InMemoryCoreDnsLifecycle("/etc/coredns/Corefile"),
      zoneFile: "/etc/coredns/Corefile",
    })),
    asGenericProvider(createCloudflareWorkersProvider({
      lifecycle: new InMemoryCloudflareWorkersLifecycle("test-account"),
      accountId: "test-account",
    })),
    asGenericProvider(createDenoDeployProvider({
      lifecycle: new InMemoryDenoDeployLifecycle("test-org"),
      organizationId: "test-org",
    })),
  ];
}

export function registerInMemoryTakosumiProviders(): readonly ProviderPlugin[] {
  const providers = createInMemoryTakosumiProviders();
  for (const provider of providers) {
    registerProvider(provider);
  }
  return providers;
}
