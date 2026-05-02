import { registerProvider } from "takosumi-contract";
import type { ProviderPlugin } from "takosumi-contract";
import {
  type AwsS3ObjectStoreProviderOptions,
  createAwsS3ObjectStoreProvider,
  InMemoryAwsS3Lifecycle,
} from "./object-store/aws-s3.ts";
import {
  type CloudflareR2ObjectStoreProviderOptions,
  createCloudflareR2ObjectStoreProvider,
  InMemoryCloudflareR2Lifecycle,
} from "./object-store/cloudflare-r2.ts";
import {
  createFilesystemObjectStoreProvider,
  type FilesystemObjectStoreProviderOptions,
  InMemoryFilesystemLifecycle,
} from "./object-store/filesystem.ts";
import {
  createGcsObjectStoreProvider,
  type GcsProviderOptions,
  InMemoryGcsLifecycle,
} from "./object-store/gcp-gcs.ts";
import {
  createMinioObjectStoreProvider,
  InMemoryMinioLifecycle,
  type MinioProviderOptions,
} from "./object-store/minio.ts";
import {
  createDockerComposeWebServiceProvider,
  type DockerComposeWebServiceProviderOptions,
  InMemoryDockerComposeLifecycle,
} from "./web-service/docker-compose.ts";
import {
  type AwsFargateWebServiceProviderOptions,
  createAwsFargateWebServiceProvider,
  InMemoryAwsFargateLifecycle,
} from "./web-service/aws-fargate.ts";
import {
  type CloudRunWebServiceProviderOptions,
  createCloudRunWebServiceProvider,
  InMemoryCloudRunLifecycle,
} from "./web-service/cloud-run.ts";
import {
  type CloudflareContainerProviderOptions,
  createCloudflareContainerWebServiceProvider,
  InMemoryCloudflareContainerLifecycle,
} from "./web-service/cloudflare-container.ts";
import {
  createK3sDeploymentWebServiceProvider,
  InMemoryK3sDeploymentLifecycle,
  type K3sDeploymentProviderOptions,
} from "./web-service/k3s-deployment.ts";
import {
  createSystemdUnitWebServiceProvider,
  InMemorySystemdUnitLifecycle,
  type SystemdUnitProviderOptions,
} from "./web-service/systemd-unit.ts";
import {
  createLocalDockerPostgresProvider,
  InMemoryLocalDockerPostgresLifecycle,
  type LocalDockerPostgresProviderOptions,
} from "./database-postgres/local-docker.ts";
import {
  type AwsRdsProviderOptions,
  createAwsRdsProvider,
  InMemoryAwsRdsLifecycle,
} from "./database-postgres/aws-rds.ts";
import {
  type CloudSqlProviderOptions,
  createCloudSqlProvider,
  InMemoryCloudSqlLifecycle,
} from "./database-postgres/cloud-sql.ts";
import {
  type CloudflareDnsProviderOptions,
  createCloudflareDnsProvider,
  InMemoryCloudflareDnsLifecycle,
} from "./custom-domain/cloudflare-dns.ts";
import {
  createRoute53Provider,
  InMemoryRoute53Lifecycle,
  type Route53ProviderOptions,
} from "./custom-domain/route53.ts";
import {
  type CloudDnsProviderOptions,
  createCloudDnsProvider,
  InMemoryCloudDnsLifecycle,
} from "./custom-domain/cloud-dns.ts";
import {
  type CoreDnsLocalProviderOptions,
  createCoreDnsLocalProvider,
  InMemoryCoreDnsLifecycle,
} from "./custom-domain/coredns-local.ts";

export {
  createAwsFargateWebServiceProvider,
  createAwsRdsProvider,
  createAwsS3ObjectStoreProvider,
  createCloudDnsProvider,
  createCloudflareContainerWebServiceProvider,
  createCloudflareDnsProvider,
  createCloudflareR2ObjectStoreProvider,
  createCloudRunWebServiceProvider,
  createCloudSqlProvider,
  createCoreDnsLocalProvider,
  createDockerComposeWebServiceProvider,
  createFilesystemObjectStoreProvider,
  createGcsObjectStoreProvider,
  createK3sDeploymentWebServiceProvider,
  createLocalDockerPostgresProvider,
  createMinioObjectStoreProvider,
  createRoute53Provider,
  createSystemdUnitWebServiceProvider,
  InMemoryAwsFargateLifecycle,
  InMemoryAwsRdsLifecycle,
  InMemoryAwsS3Lifecycle,
  InMemoryCloudDnsLifecycle,
  InMemoryCloudflareContainerLifecycle,
  InMemoryCloudflareDnsLifecycle,
  InMemoryCloudflareR2Lifecycle,
  InMemoryCloudRunLifecycle,
  InMemoryCloudSqlLifecycle,
  InMemoryCoreDnsLifecycle,
  InMemoryDockerComposeLifecycle,
  InMemoryFilesystemLifecycle,
  InMemoryGcsLifecycle,
  InMemoryK3sDeploymentLifecycle,
  InMemoryLocalDockerPostgresLifecycle,
  InMemoryMinioLifecycle,
  InMemoryRoute53Lifecycle,
  InMemorySystemdUnitLifecycle,
};
export type {
  AwsFargateWebServiceProviderOptions,
  AwsRdsProviderOptions,
  AwsS3ObjectStoreProviderOptions,
  CloudDnsProviderOptions,
  CloudflareContainerProviderOptions,
  CloudflareDnsProviderOptions,
  CloudflareR2ObjectStoreProviderOptions,
  CloudRunWebServiceProviderOptions,
  CloudSqlProviderOptions,
  CoreDnsLocalProviderOptions,
  DockerComposeWebServiceProviderOptions,
  FilesystemObjectStoreProviderOptions,
  GcsProviderOptions,
  K3sDeploymentProviderOptions,
  LocalDockerPostgresProviderOptions,
  MinioProviderOptions,
  Route53ProviderOptions,
  SystemdUnitProviderOptions,
};

export function createInMemoryTakosumiProviders(): readonly ProviderPlugin[] {
  return [
    createAwsS3ObjectStoreProvider({
      lifecycle: new InMemoryAwsS3Lifecycle(),
    }) as unknown as ProviderPlugin,
    createCloudflareR2ObjectStoreProvider({
      lifecycle: new InMemoryCloudflareR2Lifecycle("test-account"),
      accountId: "test-account",
    }) as unknown as ProviderPlugin,
    createFilesystemObjectStoreProvider({
      lifecycle: new InMemoryFilesystemLifecycle("/var/lib/takos/object-store"),
      rootDir: "/var/lib/takos/object-store",
    }) as unknown as ProviderPlugin,
    createGcsObjectStoreProvider({
      lifecycle: new InMemoryGcsLifecycle("test-project"),
      project: "test-project",
    }) as unknown as ProviderPlugin,
    createMinioObjectStoreProvider({
      lifecycle: new InMemoryMinioLifecycle("http://minio.local:9000"),
      endpoint: "http://minio.local:9000",
    }) as unknown as ProviderPlugin,
    createDockerComposeWebServiceProvider({
      lifecycle: new InMemoryDockerComposeLifecycle(),
    }) as unknown as ProviderPlugin,
    createAwsFargateWebServiceProvider({
      lifecycle: new InMemoryAwsFargateLifecycle("takos-cluster", "us-east-1"),
      clusterName: "takos-cluster",
      region: "us-east-1",
    }) as unknown as ProviderPlugin,
    createCloudRunWebServiceProvider({
      lifecycle: new InMemoryCloudRunLifecycle("test-project", "us-central1"),
      project: "test-project",
      region: "us-central1",
    }) as unknown as ProviderPlugin,
    createCloudflareContainerWebServiceProvider({
      lifecycle: new InMemoryCloudflareContainerLifecycle("test-account"),
      accountId: "test-account",
    }) as unknown as ProviderPlugin,
    createK3sDeploymentWebServiceProvider({
      lifecycle: new InMemoryK3sDeploymentLifecycle(),
      namespace: "takos",
    }) as unknown as ProviderPlugin,
    createSystemdUnitWebServiceProvider({
      lifecycle: new InMemorySystemdUnitLifecycle(),
    }) as unknown as ProviderPlugin,
    createLocalDockerPostgresProvider({
      lifecycle: new InMemoryLocalDockerPostgresLifecycle(),
    }) as unknown as ProviderPlugin,
    createAwsRdsProvider({
      lifecycle: new InMemoryAwsRdsLifecycle("us-east-1"),
    }) as unknown as ProviderPlugin,
    createCloudSqlProvider({
      lifecycle: new InMemoryCloudSqlLifecycle(
        "test-project",
        "us-central1",
      ),
      project: "test-project",
      region: "us-central1",
    }) as unknown as ProviderPlugin,
    createCloudflareDnsProvider({
      lifecycle: new InMemoryCloudflareDnsLifecycle("test-zone"),
      zoneId: "test-zone",
      accountId: "test-account",
    }) as unknown as ProviderPlugin,
    createRoute53Provider({
      lifecycle: new InMemoryRoute53Lifecycle("Z123"),
      hostedZoneId: "Z123",
    }) as unknown as ProviderPlugin,
    createCloudDnsProvider({
      lifecycle: new InMemoryCloudDnsLifecycle("test-project", "test-zone"),
      project: "test-project",
      zoneName: "test-zone",
    }) as unknown as ProviderPlugin,
    createCoreDnsLocalProvider({
      lifecycle: new InMemoryCoreDnsLifecycle("/etc/coredns/Corefile"),
      zoneFile: "/etc/coredns/Corefile",
    }) as unknown as ProviderPlugin,
  ];
}

export function registerInMemoryTakosumiProviders(): readonly ProviderPlugin[] {
  const providers = createInMemoryTakosumiProviders();
  for (const provider of providers) {
    registerProvider(provider);
  }
  return providers;
}
