/**
 * Production factory for the 18 shape-providers.
 *
 * The shape-providers in `src/shape-providers/` accept an injected
 * `*LifecycleClient` so that tests can use in-memory fakes. This module wires
 * each shape-provider to a real production lifecycle:
 *
 *  - AWS / GCP / Cloudflare / Kubernetes: thin HTTP gateway adapters that
 *    speak the same JSON RPC shape as the existing
 *    `src/providers/<cloud>/http_clients.ts` gateways. The operator gateway
 *    signs requests with credentials and proxies them to the upstream API.
 *  - selfhosted (filesystem / local-docker / systemd-unit / minio /
 *    coredns-local): minimal Deno API adapters (Deno.Command, fetch, file IO).
 *
 * Each adapter implements only the lifecycle interface defined alongside the
 * shape-provider — it does not subclass or modify the existing
 * `src/providers/<cloud>/<service>.ts` materializer classes.
 */

import type { ProviderPlugin } from "takosumi-contract";

import type {
  AwsS3BucketCreateInput,
  AwsS3BucketDeleteInput,
  AwsS3BucketDescribeInput,
  AwsS3BucketDescriptor,
  AwsS3LifecycleClient,
} from "../providers/aws/s3.ts";
import {
  type AwsS3ObjectStoreProviderOptions,
  createAwsS3ObjectStoreProvider,
} from "./object-store/aws-s3.ts";
import {
  type CloudflareR2BucketCreateInput,
  type CloudflareR2BucketDescriptor,
  type CloudflareR2BucketLifecycleClient,
  type CloudflareR2ObjectStoreProviderOptions,
  createCloudflareR2ObjectStoreProvider,
} from "./object-store/cloudflare-r2.ts";
import {
  createFilesystemObjectStoreProvider,
  type FilesystemBucketDescriptor,
  type FilesystemBucketLifecycleClient,
  type FilesystemObjectStoreProviderOptions,
} from "./object-store/filesystem.ts";
import {
  createGcsObjectStoreProvider,
  type GcsBucketDescriptor,
  type GcsLifecycleClient,
  type GcsProviderOptions,
} from "./object-store/gcp-gcs.ts";
import {
  createMinioObjectStoreProvider,
  type MinioBucketDescriptor,
  type MinioLifecycleClient,
  type MinioProviderOptions,
} from "./object-store/minio.ts";
import {
  type AwsFargateLifecycleClient,
  type AwsFargateServiceCreateInput,
  type AwsFargateServiceDescriptor,
  type AwsFargateWebServiceProviderOptions,
  createAwsFargateWebServiceProvider,
} from "./web-service/aws-fargate.ts";
import {
  type CloudflareContainerDescriptor,
  type CloudflareContainerLifecycleClient,
  type CloudflareContainerProviderOptions,
  createCloudflareContainerWebServiceProvider,
} from "./web-service/cloudflare-container.ts";
import {
  type CloudRunLifecycleClient,
  type CloudRunServiceDescriptor,
  type CloudRunWebServiceProviderOptions,
  createCloudRunWebServiceProvider,
} from "./web-service/cloud-run.ts";
import {
  createDockerComposeWebServiceProvider,
  type DockerComposeServiceCreateInput,
  type DockerComposeServiceDescriptor,
  type DockerComposeServiceLifecycleClient,
  type DockerComposeWebServiceProviderOptions,
} from "./web-service/docker-compose.ts";
import {
  createK3sDeploymentWebServiceProvider,
  type K3sDeploymentDescriptor,
  type K3sDeploymentLifecycleClient,
  type K3sDeploymentProviderOptions,
} from "./web-service/k3s-deployment.ts";
import {
  createSystemdUnitWebServiceProvider,
  type SystemdUnitDescriptor,
  type SystemdUnitLifecycleClient,
  type SystemdUnitProviderOptions,
} from "./web-service/systemd-unit.ts";
import {
  type AwsRdsInstanceDescriptor,
  type AwsRdsLifecycleClient,
  type AwsRdsProviderOptions,
  createAwsRdsProvider,
} from "./database-postgres/aws-rds.ts";
import {
  type CloudSqlInstanceDescriptor,
  type CloudSqlLifecycleClient,
  type CloudSqlProviderOptions,
  createCloudSqlProvider,
} from "./database-postgres/cloud-sql.ts";
import {
  createLocalDockerPostgresProvider,
  type LocalDockerPostgresCreateInput,
  type LocalDockerPostgresDescriptor,
  type LocalDockerPostgresLifecycleClient,
  type LocalDockerPostgresProviderOptions,
} from "./database-postgres/local-docker.ts";
import {
  type CloudflareDnsLifecycleClient,
  type CloudflareDnsProviderOptions,
  type CloudflareDnsRecordDescriptor,
  createCloudflareDnsProvider,
} from "./custom-domain/cloudflare-dns.ts";
import {
  createRoute53Provider,
  type Route53LifecycleClient,
  type Route53ProviderOptions,
  type Route53RecordDescriptor,
} from "./custom-domain/route53.ts";
import {
  type CloudDnsLifecycleClient,
  type CloudDnsProviderOptions,
  type CloudDnsRecordDescriptor,
  createCloudDnsProvider,
} from "./custom-domain/cloud-dns.ts";
import {
  type CoreDnsLifecycleClient,
  type CoreDnsLocalProviderOptions,
  type CoreDnsRecordDescriptor,
  createCoreDnsLocalProvider,
} from "./custom-domain/coredns-local.ts";

/** Per-cloud config bundles supplied by the operator. */
export interface TakosumiAwsCredentials {
  readonly region: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
  /** Operator gateway URL that signs / proxies AWS requests. */
  readonly gatewayUrl?: string | URL;
  readonly bearerToken?: string;
  readonly fetch?: typeof fetch;
}

export interface TakosumiGcpCredentials {
  readonly project: string;
  readonly region: string;
  readonly credentialsJson?: string;
  readonly gatewayUrl?: string | URL;
  readonly bearerToken?: string;
  readonly fetch?: typeof fetch;
}

export interface TakosumiCloudflareCredentials {
  readonly accountId: string;
  readonly apiToken?: string;
  readonly zoneId?: string;
  readonly gatewayUrl?: string | URL;
  readonly fetch?: typeof fetch;
}

export interface TakosumiKubernetesCredentials {
  readonly namespace: string;
  readonly kubeconfigPath?: string;
  readonly gatewayUrl?: string | URL;
  readonly bearerToken?: string;
  readonly fetch?: typeof fetch;
}

export interface TakosumiSelfhostedCredentials {
  readonly rootDir?: string;
  readonly postgresHostBinding?: string;
  readonly objectStoreEndpoint?: string;
  /** systemd unit directory; defaults to `/etc/systemd/system`. */
  readonly systemdUnitDir?: string;
  /** CoreDNS Corefile path; defaults to `/etc/coredns/Corefile`. */
  readonly coreDnsZoneFile?: string;
  readonly fetch?: typeof fetch;
}

export interface TakosumiProductionProviderOptions {
  readonly aws?: TakosumiAwsCredentials;
  readonly gcp?: TakosumiGcpCredentials;
  readonly cloudflare?: TakosumiCloudflareCredentials;
  readonly kubernetes?: TakosumiKubernetesCredentials;
  readonly selfhosted?: TakosumiSelfhostedCredentials;
}

/**
 * Build the production-ready set of shape-provider plugins.
 *
 * Empty `opts` returns 0 providers (operators must opt in to each cloud).
 * Every provider is materialized via the operator gateway or a local Deno
 * API adapter — credentials never reach the shape-provider directly.
 */
export function createTakosumiProductionProviders(
  opts: TakosumiProductionProviderOptions,
): readonly ProviderPlugin[] {
  const out: ProviderPlugin[] = [];

  if (opts.aws) {
    const lifecycleS3 = new GatewayAwsS3Lifecycle(opts.aws);
    const lifecycleFargate = new GatewayAwsFargateLifecycle(opts.aws);
    const lifecycleRds = new GatewayAwsRdsLifecycle(opts.aws);
    const lifecycleR53 = new GatewayRoute53Lifecycle(opts.aws);
    out.push(
      asPlugin<AwsS3ObjectStoreProviderOptions>(
        createAwsS3ObjectStoreProvider({
          lifecycle: lifecycleS3,
          defaultRegion: opts.aws.region,
        }),
      ),
      asPlugin<AwsFargateWebServiceProviderOptions>(
        createAwsFargateWebServiceProvider({
          lifecycle: lifecycleFargate,
          clusterName: "takos",
          region: opts.aws.region,
        }),
      ),
      asPlugin<AwsRdsProviderOptions>(
        createAwsRdsProvider({ lifecycle: lifecycleRds }),
      ),
      asPlugin<Route53ProviderOptions>(
        createRoute53Provider({
          lifecycle: lifecycleR53,
          hostedZoneId: "TAKOS_HOSTED_ZONE",
        }),
      ),
    );
  }

  if (opts.gcp) {
    const lifecycleGcs = new GatewayGcsLifecycle(opts.gcp);
    const lifecycleRun = new GatewayCloudRunLifecycle(opts.gcp);
    const lifecycleCloudSql = new GatewayCloudSqlLifecycle(opts.gcp);
    const lifecycleCloudDns = new GatewayCloudDnsLifecycle(opts.gcp);
    out.push(
      asPlugin<GcsProviderOptions>(
        createGcsObjectStoreProvider({
          lifecycle: lifecycleGcs,
          project: opts.gcp.project,
          defaultLocation: opts.gcp.region,
        }),
      ),
      asPlugin<CloudRunWebServiceProviderOptions>(
        createCloudRunWebServiceProvider({
          lifecycle: lifecycleRun,
          project: opts.gcp.project,
          region: opts.gcp.region,
        }),
      ),
      asPlugin<CloudSqlProviderOptions>(
        createCloudSqlProvider({
          lifecycle: lifecycleCloudSql,
          project: opts.gcp.project,
          region: opts.gcp.region,
        }),
      ),
      asPlugin<CloudDnsProviderOptions>(
        createCloudDnsProvider({
          lifecycle: lifecycleCloudDns,
          project: opts.gcp.project,
          zoneName: "takos",
        }),
      ),
    );
  }

  if (opts.cloudflare) {
    const lifecycleR2 = new GatewayCloudflareR2Lifecycle(opts.cloudflare);
    const lifecycleContainer = new GatewayCloudflareContainerLifecycle(
      opts.cloudflare,
    );
    const lifecycleDns = new GatewayCloudflareDnsLifecycle(opts.cloudflare);
    out.push(
      asPlugin<CloudflareR2ObjectStoreProviderOptions>(
        createCloudflareR2ObjectStoreProvider({
          lifecycle: lifecycleR2,
          accountId: opts.cloudflare.accountId,
        }),
      ),
      asPlugin<CloudflareContainerProviderOptions>(
        createCloudflareContainerWebServiceProvider({
          lifecycle: lifecycleContainer,
          accountId: opts.cloudflare.accountId,
        }),
      ),
      asPlugin<CloudflareDnsProviderOptions>(
        createCloudflareDnsProvider({
          lifecycle: lifecycleDns,
          zoneId: opts.cloudflare.zoneId ?? "TAKOS_ZONE",
          accountId: opts.cloudflare.accountId,
        }),
      ),
    );
  }

  if (opts.kubernetes) {
    const lifecycleK3s = new GatewayK3sDeploymentLifecycle(opts.kubernetes);
    out.push(
      asPlugin<K3sDeploymentProviderOptions>(
        createK3sDeploymentWebServiceProvider({
          lifecycle: lifecycleK3s,
          namespace: opts.kubernetes.namespace,
        }),
      ),
    );
  }

  if (opts.selfhosted) {
    const root = opts.selfhosted.rootDir ?? "/var/lib/takos/object-store";
    const fsLifecycle = new FilesystemLifecycleAdapter(root);
    const composeLifecycle = new DockerComposeCliLifecycleAdapter();
    const systemdLifecycle = new SystemdCliLifecycleAdapter(
      opts.selfhosted.systemdUnitDir ?? "/etc/systemd/system",
    );
    const localPg = new LocalDockerPostgresCliLifecycleAdapter();
    const minioLifecycle = new MinioHttpLifecycleAdapter(
      opts.selfhosted.objectStoreEndpoint ?? "http://minio.local:9000",
      opts.selfhosted.fetch ?? fetch,
    );
    const corednsLifecycle = new CoreDnsFileLifecycleAdapter(
      opts.selfhosted.coreDnsZoneFile ?? "/etc/coredns/Corefile",
    );
    out.push(
      asPlugin<FilesystemObjectStoreProviderOptions>(
        createFilesystemObjectStoreProvider({
          lifecycle: fsLifecycle,
          rootDir: root,
        }),
      ),
      asPlugin<DockerComposeWebServiceProviderOptions>(
        createDockerComposeWebServiceProvider({
          lifecycle: composeLifecycle,
        }),
      ),
      asPlugin<SystemdUnitProviderOptions>(
        createSystemdUnitWebServiceProvider({
          lifecycle: systemdLifecycle,
        }),
      ),
      asPlugin<LocalDockerPostgresProviderOptions>(
        createLocalDockerPostgresProvider({
          lifecycle: localPg,
          hostBinding: opts.selfhosted.postgresHostBinding ?? "localhost",
        }),
      ),
      asPlugin<MinioProviderOptions>(
        createMinioObjectStoreProvider({
          lifecycle: minioLifecycle,
          endpoint: opts.selfhosted.objectStoreEndpoint ??
            "http://minio.local:9000",
        }),
      ),
      asPlugin<CoreDnsLocalProviderOptions>(
        createCoreDnsLocalProvider({
          lifecycle: corednsLifecycle,
          zoneFile: opts.selfhosted.coreDnsZoneFile ?? "/etc/coredns/Corefile",
        }),
      ),
    );
  }

  return out;
}

/**
 * Cast helper. The shape-provider factories return `ProviderPlugin<TSpec,
 * TOutputs>`, but the kernel registry stores them as a generic
 * `ProviderPlugin`. This is the same erasure used by `mod.ts`.
 */
// deno-lint-ignore no-explicit-any
function asPlugin<_T = any>(plugin: unknown): ProviderPlugin {
  return plugin as ProviderPlugin;
}

// ---------------------------------------------------------------------------
// JSON gateway plumbing — shared by AWS / GCP / Cloudflare / K8s adapters.
// ---------------------------------------------------------------------------

interface JsonGatewayOptions {
  readonly baseUrl: string | URL;
  readonly bearerToken?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
}

/**
 * Minimal JSON-over-HTTP gateway. Mirrors the `JsonHttpGateway` pattern in
 * `src/providers/<cloud>/http_clients.ts`. The operator gateway is
 * responsible for credentialing / signing / region routing — the kernel only
 * sees JSON-shaped lifecycle calls.
 */
class JsonGateway {
  readonly #baseUrl: string;
  readonly #bearerToken?: string;
  readonly #headers?: HeadersInit;
  readonly #fetch: typeof fetch;

  constructor(options: JsonGatewayOptions) {
    const url = `${options.baseUrl}`;
    this.#baseUrl = url.endsWith("/") ? url : `${url}/`;
    this.#bearerToken = options.bearerToken;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? fetch;
  }

  async post<T>(path: string, input: unknown): Promise<T> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method: "POST",
      headers: this.#requestHeaders(),
      body: JSON.stringify(input ?? {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `gateway ${path} failed: HTTP ${response.status} ${response.statusText}${
          text ? `: ${text}` : ""
        }`,
      );
    }
    if (!text || response.status === 204) return undefined as T;
    return JSON.parse(text) as T;
  }

  #requestHeaders(): Headers {
    const headers = new Headers(this.#headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    if (this.#bearerToken) {
      headers.set("authorization", `Bearer ${this.#bearerToken}`);
    }
    return headers;
  }
}

function requireGatewayUrl(
  cloud: string,
  url: string | URL | undefined,
): string | URL {
  if (!url) {
    throw new Error(
      `${cloud} gatewayUrl is required for production shape-providers; configure operator gateway`,
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// AWS gateway adapters
// ---------------------------------------------------------------------------

class GatewayAwsS3Lifecycle implements AwsS3LifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiAwsCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("aws", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createBucket(
    input: AwsS3BucketCreateInput,
  ): Promise<AwsS3BucketDescriptor> {
    return this.#gw.post("aws/s3/create-bucket", input);
  }

  describeBucket(
    input: AwsS3BucketDescribeInput,
  ): Promise<AwsS3BucketDescriptor | undefined> {
    return this.#gw.post("aws/s3/describe-bucket", input);
  }

  async deleteBucket(input: AwsS3BucketDeleteInput): Promise<boolean> {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "aws/s3/delete-bucket",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayAwsFargateLifecycle implements AwsFargateLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiAwsCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("aws", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createService(
    input: AwsFargateServiceCreateInput,
  ): Promise<AwsFargateServiceDescriptor> {
    return this.#gw.post("aws/fargate/create-service", input);
  }

  describeService(
    input: { readonly serviceName: string },
  ): Promise<AwsFargateServiceDescriptor | undefined> {
    return this.#gw.post("aws/fargate/describe-service", input);
  }

  async deleteService(input: { readonly serviceName: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "aws/fargate/delete-service",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayAwsRdsLifecycle implements AwsRdsLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiAwsCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("aws", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createInstance(
    input: Parameters<AwsRdsLifecycleClient["createInstance"]>[0],
  ): Promise<AwsRdsInstanceDescriptor> {
    return this.#gw.post("aws/rds/create-instance", input);
  }

  describeInstance(
    input: { readonly instanceId: string },
  ): Promise<AwsRdsInstanceDescriptor | undefined> {
    return this.#gw.post("aws/rds/describe-instance", input);
  }

  async deleteInstance(input: { readonly instanceId: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "aws/rds/delete-instance",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayRoute53Lifecycle implements Route53LifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiAwsCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("aws", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createRecord(
    input: Parameters<Route53LifecycleClient["createRecord"]>[0],
  ): Promise<Route53RecordDescriptor> {
    return this.#gw.post("aws/route53/create-record", input);
  }

  describeRecord(
    input: { readonly recordSetId: string },
  ): Promise<Route53RecordDescriptor | undefined> {
    return this.#gw.post("aws/route53/describe-record", input);
  }

  async deleteRecord(input: { readonly recordSetId: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "aws/route53/delete-record",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

// ---------------------------------------------------------------------------
// GCP gateway adapters
// ---------------------------------------------------------------------------

class GatewayGcsLifecycle implements GcsLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiGcpCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("gcp", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createBucket(
    input: Parameters<GcsLifecycleClient["createBucket"]>[0],
  ): Promise<GcsBucketDescriptor> {
    return this.#gw.post("gcp/gcs/create-bucket", input);
  }

  describeBucket(
    input: { readonly bucketName: string },
  ): Promise<GcsBucketDescriptor | undefined> {
    return this.#gw.post("gcp/gcs/describe-bucket", input);
  }

  async deleteBucket(input: { readonly bucketName: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "gcp/gcs/delete-bucket",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayCloudRunLifecycle implements CloudRunLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiGcpCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("gcp", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createService(
    input: Parameters<CloudRunLifecycleClient["createService"]>[0],
  ): Promise<CloudRunServiceDescriptor> {
    return this.#gw.post("gcp/cloud-run/create-service", input);
  }

  describeService(
    input: { readonly serviceName: string },
  ): Promise<CloudRunServiceDescriptor | undefined> {
    return this.#gw.post("gcp/cloud-run/describe-service", input);
  }

  async deleteService(input: { readonly serviceName: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "gcp/cloud-run/delete-service",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayCloudSqlLifecycle implements CloudSqlLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiGcpCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("gcp", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createInstance(
    input: Parameters<CloudSqlLifecycleClient["createInstance"]>[0],
  ): Promise<CloudSqlInstanceDescriptor> {
    return this.#gw.post("gcp/cloud-sql/create-instance", input);
  }

  describeInstance(
    input: { readonly instanceName: string },
  ): Promise<CloudSqlInstanceDescriptor | undefined> {
    return this.#gw.post("gcp/cloud-sql/describe-instance", input);
  }

  async deleteInstance(input: { readonly instanceName: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "gcp/cloud-sql/delete-instance",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayCloudDnsLifecycle implements CloudDnsLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiGcpCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("gcp", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createRecord(
    input: { readonly fqdn: string; readonly target: string },
  ): Promise<CloudDnsRecordDescriptor> {
    return this.#gw.post("gcp/cloud-dns/create-record", input);
  }

  describeRecord(
    input: { readonly recordName: string },
  ): Promise<CloudDnsRecordDescriptor | undefined> {
    return this.#gw.post("gcp/cloud-dns/describe-record", input);
  }

  async deleteRecord(input: { readonly recordName: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "gcp/cloud-dns/delete-record",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare gateway adapters
// ---------------------------------------------------------------------------

class GatewayCloudflareR2Lifecycle
  implements CloudflareR2BucketLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiCloudflareCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("cloudflare", opts.gatewayUrl),
      bearerToken: opts.apiToken,
      fetch: opts.fetch,
    });
  }

  createBucket(
    input: CloudflareR2BucketCreateInput,
  ): Promise<CloudflareR2BucketDescriptor> {
    return this.#gw.post("cloudflare/r2/create-bucket", input);
  }

  describeBucket(
    input: { readonly bucketName: string },
  ): Promise<CloudflareR2BucketDescriptor | undefined> {
    return this.#gw.post("cloudflare/r2/describe-bucket", input);
  }

  async deleteBucket(input: { readonly bucketName: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "cloudflare/r2/delete-bucket",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayCloudflareContainerLifecycle
  implements CloudflareContainerLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiCloudflareCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("cloudflare", opts.gatewayUrl),
      bearerToken: opts.apiToken,
      fetch: opts.fetch,
    });
  }

  createService(
    input: Parameters<CloudflareContainerLifecycleClient["createService"]>[0],
  ): Promise<CloudflareContainerDescriptor> {
    return this.#gw.post("cloudflare/containers/create-service", input);
  }

  describeService(
    input: { readonly serviceName: string },
  ): Promise<CloudflareContainerDescriptor | undefined> {
    return this.#gw.post("cloudflare/containers/describe-service", input);
  }

  async deleteService(input: { readonly serviceName: string }): Promise<
    boolean
  > {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "cloudflare/containers/delete-service",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

class GatewayCloudflareDnsLifecycle implements CloudflareDnsLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiCloudflareCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("cloudflare", opts.gatewayUrl),
      bearerToken: opts.apiToken,
      fetch: opts.fetch,
    });
  }

  createRecord(
    input: {
      readonly fqdn: string;
      readonly target: string;
      readonly proxied: boolean;
    },
  ): Promise<CloudflareDnsRecordDescriptor> {
    return this.#gw.post("cloudflare/dns/create-record", input);
  }

  describeRecord(
    input: { readonly recordId: string },
  ): Promise<CloudflareDnsRecordDescriptor | undefined> {
    return this.#gw.post("cloudflare/dns/describe-record", input);
  }

  async deleteRecord(input: { readonly recordId: string }): Promise<boolean> {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "cloudflare/dns/delete-record",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

// ---------------------------------------------------------------------------
// Kubernetes gateway adapter
// ---------------------------------------------------------------------------

class GatewayK3sDeploymentLifecycle implements K3sDeploymentLifecycleClient {
  readonly #gw: JsonGateway;

  constructor(opts: TakosumiKubernetesCredentials) {
    this.#gw = new JsonGateway({
      baseUrl: requireGatewayUrl("kubernetes", opts.gatewayUrl),
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
  }

  createDeployment(
    input: Parameters<K3sDeploymentLifecycleClient["createDeployment"]>[0],
  ): Promise<K3sDeploymentDescriptor> {
    return this.#gw.post("k8s/deployment/create", input);
  }

  describeDeployment(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K3sDeploymentDescriptor | undefined> {
    return this.#gw.post("k8s/deployment/describe", input);
  }

  async deleteDeployment(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<boolean> {
    const result = await this.#gw.post<{ readonly deleted?: boolean } | null>(
      "k8s/deployment/delete",
      input,
    );
    return Boolean(result && result.deleted);
  }
}

// ---------------------------------------------------------------------------
// Selfhosted Deno-API adapters (filesystem / docker / systemd / coredns / minio)
// ---------------------------------------------------------------------------

/** Maps `bucketName` to a directory under `rootDir` using `Deno.mkdir/remove`. */
class FilesystemLifecycleAdapter implements FilesystemBucketLifecycleClient {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  async createBucket(
    input: { readonly bucketName: string },
  ): Promise<FilesystemBucketDescriptor> {
    const path = `${this.#rootDir}/${input.bucketName}`;
    await Deno.mkdir(path, { recursive: true });
    return { bucketName: input.bucketName, path };
  }

  async describeBucket(
    input: { readonly bucketName: string },
  ): Promise<FilesystemBucketDescriptor | undefined> {
    const path = `${this.#rootDir}/${input.bucketName}`;
    try {
      const stat = await Deno.stat(path);
      if (!stat.isDirectory) return undefined;
      return { bucketName: input.bucketName, path };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  async deleteBucket(
    input: { readonly bucketName: string; readonly recursive?: boolean },
  ): Promise<boolean> {
    const path = `${this.#rootDir}/${input.bucketName}`;
    try {
      await Deno.remove(path, { recursive: input.recursive ?? true });
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }
}

/** Drives `docker compose` via Deno.Command for selfhosted web-services. */
class DockerComposeCliLifecycleAdapter
  implements DockerComposeServiceLifecycleClient {
  readonly #services = new Map<string, DockerComposeServiceDescriptor>();

  async createService(
    input: DockerComposeServiceCreateInput,
  ): Promise<DockerComposeServiceDescriptor> {
    // operator-side compose runner: `docker run -d --name <svc> -p host:internal <image>`
    const cmd = new Deno.Command("docker", {
      args: [
        "run",
        "-d",
        "--restart",
        input.restart ?? "unless-stopped",
        "--name",
        input.serviceName,
        "-p",
        `${input.hostPort}:${input.internalPort}`,
        ...envFlags(input.env),
        input.image,
        ...(input.command ?? []),
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(
        `docker run failed for ${input.serviceName}: ${
          new TextDecoder().decode(stderr)
        }`,
      );
    }
    const desc: DockerComposeServiceDescriptor = {
      serviceName: input.serviceName,
      image: input.image,
      hostPort: input.hostPort,
      internalPort: input.internalPort,
      env: input.env,
    };
    this.#services.set(input.serviceName, desc);
    return desc;
  }

  describeService(
    input: { readonly serviceName: string },
  ): Promise<DockerComposeServiceDescriptor | undefined> {
    return Promise.resolve(this.#services.get(input.serviceName));
  }

  async deleteService(
    input: { readonly serviceName: string },
  ): Promise<boolean> {
    const cmd = new Deno.Command("docker", {
      args: ["rm", "-f", input.serviceName],
      stdout: "null",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    this.#services.delete(input.serviceName);
    return code === 0;
  }
}

/** Writes a systemd unit file to `unitDir`, then runs `systemctl enable --now`. */
class SystemdCliLifecycleAdapter implements SystemdUnitLifecycleClient {
  readonly #units = new Map<string, SystemdUnitDescriptor>();
  readonly #unitDir: string;

  constructor(unitDir: string) {
    this.#unitDir = unitDir;
  }

  async createUnit(
    input: Parameters<SystemdUnitLifecycleClient["createUnit"]>[0],
  ): Promise<SystemdUnitDescriptor> {
    const unitFile = `${this.#unitDir}/${input.unitName}`;
    const body = renderSystemdUnit(input);
    await Deno.writeTextFile(unitFile, body);
    await runOrThrow("systemctl", ["daemon-reload"]);
    await runOrThrow("systemctl", ["enable", "--now", input.unitName]);
    const desc: SystemdUnitDescriptor = {
      unitName: input.unitName,
      hostBinding: "127.0.0.1",
      hostPort: input.hostPort,
      internalPort: input.internalPort,
    };
    this.#units.set(input.unitName, desc);
    return desc;
  }

  describeUnit(
    input: { readonly unitName: string },
  ): Promise<SystemdUnitDescriptor | undefined> {
    return Promise.resolve(this.#units.get(input.unitName));
  }

  async deleteUnit(input: { readonly unitName: string }): Promise<boolean> {
    const unitFile = `${this.#unitDir}/${input.unitName}`;
    try {
      await runOrThrow("systemctl", ["disable", "--now", input.unitName]);
    } catch {
      // unit may already be stopped — proceed with file cleanup
    }
    try {
      await Deno.remove(unitFile);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.#units.delete(input.unitName);
    return true;
  }
}

/** Drives `docker run postgres` for the local-docker postgres shape. */
class LocalDockerPostgresCliLifecycleAdapter
  implements LocalDockerPostgresLifecycleClient {
  readonly #instances = new Map<string, LocalDockerPostgresDescriptor>();

  async createInstance(
    input: LocalDockerPostgresCreateInput,
  ): Promise<LocalDockerPostgresDescriptor> {
    const cmd = new Deno.Command("docker", {
      args: [
        "run",
        "-d",
        "--restart",
        "unless-stopped",
        "--name",
        input.containerName,
        "-p",
        `${input.hostPort}:5432`,
        "-e",
        `POSTGRES_DB=${input.database}`,
        "-e",
        `POSTGRES_USER=${input.username}`,
        "-e",
        `POSTGRES_PASSWORD=${input.password}`,
        `postgres:${input.version}`,
      ],
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(
        `docker run postgres failed: ${new TextDecoder().decode(stderr)}`,
      );
    }
    const desc: LocalDockerPostgresDescriptor = {
      containerName: input.containerName,
      host: "localhost",
      port: input.hostPort,
      database: input.database,
      username: input.username,
      version: input.version,
    };
    this.#instances.set(input.containerName, desc);
    return desc;
  }

  describeInstance(
    input: { readonly containerName: string },
  ): Promise<LocalDockerPostgresDescriptor | undefined> {
    return Promise.resolve(this.#instances.get(input.containerName));
  }

  async deleteInstance(
    input: { readonly containerName: string },
  ): Promise<boolean> {
    const cmd = new Deno.Command("docker", {
      args: ["rm", "-f", input.containerName],
      stdout: "null",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    this.#instances.delete(input.containerName);
    return code === 0;
  }
}

/** Talks to MinIO via the S3-compatible REST API (PUT/HEAD/DELETE bucket). */
class MinioHttpLifecycleAdapter implements MinioLifecycleClient {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #buckets = new Map<string, MinioBucketDescriptor>();

  constructor(endpoint: string, fetchImpl: typeof fetch) {
    this.#endpoint = endpoint.replace(/\/$/, "");
    this.#fetch = fetchImpl;
  }

  async createBucket(
    input: { readonly bucketName: string },
  ): Promise<MinioBucketDescriptor> {
    const response = await this.#fetch(
      `${this.#endpoint}/${input.bucketName}`,
      {
        method: "PUT",
      },
    );
    if (!response.ok && response.status !== 409 /* BucketAlreadyOwnedByYou */) {
      throw new Error(
        `minio create bucket failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const desc: MinioBucketDescriptor = {
      bucketName: input.bucketName,
      endpoint: this.#endpoint,
    };
    this.#buckets.set(input.bucketName, desc);
    return desc;
  }

  async describeBucket(
    input: { readonly bucketName: string },
  ): Promise<MinioBucketDescriptor | undefined> {
    const response = await this.#fetch(
      `${this.#endpoint}/${input.bucketName}`,
      {
        method: "HEAD",
      },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `minio describe bucket failed: HTTP ${response.status}`,
      );
    }
    return this.#buckets.get(input.bucketName) ?? {
      bucketName: input.bucketName,
      endpoint: this.#endpoint,
    };
  }

  async deleteBucket(
    input: { readonly bucketName: string },
  ): Promise<boolean> {
    const response = await this.#fetch(
      `${this.#endpoint}/${input.bucketName}`,
      {
        method: "DELETE",
      },
    );
    this.#buckets.delete(input.bucketName);
    return response.ok || response.status === 404;
  }
}

/** Appends/removes A-record stanzas in a CoreDNS Corefile. */
class CoreDnsFileLifecycleAdapter implements CoreDnsLifecycleClient {
  readonly #zoneFile: string;
  readonly #records = new Map<string, CoreDnsRecordDescriptor>();
  #counter = 0;

  constructor(zoneFile: string) {
    this.#zoneFile = zoneFile;
  }

  async createRecord(
    input: { readonly fqdn: string; readonly target: string },
  ): Promise<CoreDnsRecordDescriptor> {
    const recordName = `coredns-${++this.#counter}`;
    const desc: CoreDnsRecordDescriptor = {
      recordName,
      fqdn: input.fqdn,
      target: input.target,
      zoneFile: this.#zoneFile,
    };
    const stanza = `\n# ${recordName}\n${input.fqdn}. IN A ${input.target}\n`;
    await Deno.writeTextFile(this.#zoneFile, stanza, { append: true });
    this.#records.set(recordName, desc);
    return desc;
  }

  describeRecord(
    input: { readonly recordName: string },
  ): Promise<CoreDnsRecordDescriptor | undefined> {
    return Promise.resolve(this.#records.get(input.recordName));
  }

  async deleteRecord(
    input: { readonly recordName: string },
  ): Promise<boolean> {
    const desc = this.#records.get(input.recordName);
    if (!desc) return false;
    try {
      const text = await Deno.readTextFile(this.#zoneFile);
      const filtered = text
        .split("\n")
        .filter((line) =>
          !line.includes(`# ${input.recordName}`) &&
          !line.startsWith(`${desc.fqdn}.`)
        )
        .join("\n");
      await Deno.writeTextFile(this.#zoneFile, filtered);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    this.#records.delete(input.recordName);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envFlags(env: Readonly<Record<string, string>> | undefined): string[] {
  if (!env) return [];
  const flags: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    flags.push("-e", `${k}=${v}`);
  }
  return flags;
}

function renderSystemdUnit(
  input: Parameters<SystemdUnitLifecycleClient["createUnit"]>[0],
): string {
  const env = input.env
    ? Object.entries(input.env)
      .map(([k, v]) => `Environment=${k}=${v}`)
      .join("\n")
    : "";
  const exec = input.command && input.command.length > 0
    ? input.command.join(" ")
    : input.image;
  return [
    "[Unit]",
    `Description=Takos Web Service ${input.unitName}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    env,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].filter(Boolean).join("\n");
}

async function runOrThrow(cmd: string, args: readonly string[]): Promise<void> {
  const child = new Deno.Command(cmd, {
    args: [...args],
    stdout: "null",
    stderr: "piped",
  });
  const { code, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited with code ${code}: ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
}
