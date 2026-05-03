/**
 * Production factory for the curated set of shape-providers.
 *
 * Every provider is a paper-thin HTTP wrapper around a runtime-agent: the
 * kernel posts lifecycle envelopes (apply / destroy / describe) to the
 * agent which holds all credentials and SDK code. Plugins themselves never
 * touch cloud APIs.
 *
 * Operators wire the kernel by passing `{ agentUrl, token }` plus optional
 * `enable*` switches. By default every cloud is enabled and selfhosted is
 * always on — operators turn off clouds whose connectors aren't registered
 * on the agent.
 */

import type {
  ApplyResult,
  ArtifactStoreLocator,
  JsonObject,
  ProviderPlugin,
  ResourceHandle,
  ResourceStatus,
  ShapeRef,
} from "takosumi-contract";
import type {
  CustomDomainCapability,
  DatabasePostgresCapability,
  ObjectStoreCapability,
  WebServiceCapability,
  WorkerCapability,
} from "../shapes/mod.ts";

import { RuntimeAgentLifecycle } from "./_runtime_agent_lifecycle.ts";

export { RuntimeAgentLifecycle };
export type { RuntimeAgentClientOptions } from "./_runtime_agent_lifecycle.ts";

/**
 * Operator-supplied options for the production provider set.
 *
 * `agentUrl` and `token` are the only required fields — the runtime-agent
 * is the single point that holds cloud credentials. The boolean
 * `enable*` switches let an operator disable a cloud whose connector
 * isn't registered on the agent (defaults: all enabled).
 */
export interface TakosumiProductionProviderOptions {
  /** Base URL of the runtime-agent (e.g. `http://127.0.0.1:8789`). */
  readonly agentUrl: string;
  /** Bearer token shared with the runtime-agent. */
  readonly token: string;
  /** Optional fetch override for testing. */
  readonly fetch?: typeof fetch;
  /** Enable AWS providers (s3, fargate, rds, route53). Default: true. */
  readonly enableAws?: boolean;
  /** Enable GCP providers (gcs, cloud-run, cloud-sql, cloud-dns). Default: true. */
  readonly enableGcp?: boolean;
  /** Enable Cloudflare providers (r2, container, dns). Default: true. */
  readonly enableCloudflare?: boolean;
  /** Enable Azure providers (container-apps). Default: true. */
  readonly enableAzure?: boolean;
  /** Enable Kubernetes providers (k3s-deployment). Default: true. */
  readonly enableKubernetes?: boolean;
  /**
   * Enable selfhost providers (filesystem, minio, docker-compose, systemd-unit,
   * local-docker, coredns-local). Default: true.
   */
  readonly enableSelfhost?: boolean;
  /**
   * Enable Deno Deploy provider (deno-deploy → worker@v1). Default: false —
   * the runtime-agent must have a Deno Deploy connector registered via
   * `connectorBootOptions.denoDeploy` for this provider to do anything.
   */
  readonly enableDenoDeploy?: boolean;
  /** Optional clock for status timestamps. */
  readonly clock?: () => Date;
  /**
   * When set, every apply request the kernel sends to the agent carries this
   * `artifactStore` field so connectors with `acceptedArtifactKinds` other than
   * `oci-image` (e.g. `js-bundle` for cloudflare-workers) can fetch the
   * uploaded bytes by hash. Operator-side `TAKOSUMI_PUBLIC_BASE_URL` should
   * resolve to the kernel's externally-reachable base URL (typically
   * `http://kernel.internal:8788/v1/artifacts`).
   */
  readonly artifactStore?: ArtifactStoreLocator;
}

interface ProviderEntry {
  readonly id: string;
  readonly shape: ShapeRef;
  readonly capabilities: readonly string[];
}

/**
 * Catalog of every (shape, provider) pair Takosumi ships out of the box.
 * Capability sets mirror the per-provider plugin definitions in
 * `shape-providers/<shape>/<provider>.ts` (and the runtime-agent connector
 * in `runtime-agent/src/connectors/<cloud>/<service>.ts`).
 */
const OBJECT_STORE: ShapeRef = { id: "object-store", version: "v1" };
const WEB_SERVICE: ShapeRef = { id: "web-service", version: "v1" };
const DATABASE_POSTGRES: ShapeRef = { id: "database-postgres", version: "v1" };
const CUSTOM_DOMAIN: ShapeRef = { id: "custom-domain", version: "v1" };
const WORKER: ShapeRef = { id: "worker", version: "v1" };

const AWS_PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "@takos/aws-s3",
    shape: OBJECT_STORE,
    capabilities: [
      "versioning",
      "presigned-urls",
      "server-side-encryption",
      "public-access",
      "event-notifications",
      "lifecycle-rules",
      "multipart-upload",
    ] satisfies readonly ObjectStoreCapability[],
  },
  {
    id: "@takos/aws-fargate",
    shape: WEB_SERVICE,
    capabilities: [
      "always-on",
      "websocket",
      "long-request",
      "sticky-session",
      "private-networking",
    ] satisfies readonly WebServiceCapability[],
  },
  {
    id: "@takos/aws-rds",
    shape: DATABASE_POSTGRES,
    capabilities: [
      "pitr",
      "read-replicas",
      "high-availability",
      "backups",
      "ssl-required",
      "extensions",
    ] satisfies readonly DatabasePostgresCapability[],
  },
  {
    id: "@takos/aws-route53",
    shape: CUSTOM_DOMAIN,
    capabilities: ["wildcard", "auto-tls", "sni", "alpn-acme"] satisfies readonly CustomDomainCapability[],
  },
];

const GCP_PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "@takos/gcp-gcs",
    shape: OBJECT_STORE,
    capabilities: [
      "versioning",
      "presigned-urls",
      "server-side-encryption",
      "public-access",
      "event-notifications",
      "lifecycle-rules",
      "multipart-upload",
    ] satisfies readonly ObjectStoreCapability[],
  },
  {
    id: "@takos/gcp-cloud-run",
    shape: WEB_SERVICE,
    capabilities: ["always-on", "scale-to-zero", "websocket", "long-request"] satisfies readonly WebServiceCapability[],
  },
  {
    id: "@takos/gcp-cloud-sql",
    shape: DATABASE_POSTGRES,
    capabilities: [
      "pitr",
      "read-replicas",
      "high-availability",
      "backups",
      "ssl-required",
      "extensions",
    ] satisfies readonly DatabasePostgresCapability[],
  },
  {
    id: "@takos/gcp-cloud-dns",
    shape: CUSTOM_DOMAIN,
    capabilities: ["wildcard", "auto-tls", "sni"] satisfies readonly CustomDomainCapability[],
  },
];

const CLOUDFLARE_PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "@takos/cloudflare-r2",
    shape: OBJECT_STORE,
    capabilities: ["presigned-urls", "public-access", "multipart-upload"] satisfies readonly ObjectStoreCapability[],
  },
  {
    id: "@takos/cloudflare-container",
    shape: WEB_SERVICE,
    capabilities: ["scale-to-zero", "geo-routing"] satisfies readonly WebServiceCapability[],
  },
  {
    id: "@takos/cloudflare-workers",
    shape: WORKER,
    capabilities: [
      "scale-to-zero",
      "websocket",
      "long-request",
      "geo-routing",
      "crons",
    ] satisfies readonly WorkerCapability[],
  },
  {
    id: "@takos/cloudflare-dns",
    shape: CUSTOM_DOMAIN,
    capabilities: ["wildcard", "auto-tls", "sni", "http3"] satisfies readonly CustomDomainCapability[],
  },
];

const AZURE_PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "@takos/azure-container-apps",
    shape: WEB_SERVICE,
    capabilities: ["always-on", "scale-to-zero", "websocket", "long-request"] satisfies readonly WebServiceCapability[],
  },
];

const KUBERNETES_PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "@takos/kubernetes-deployment",
    shape: WEB_SERVICE,
    capabilities: [
      "always-on",
      "websocket",
      "long-request",
      "private-networking",
    ] satisfies readonly WebServiceCapability[],
  },
];

const DENO_DEPLOY_PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "@takos/deno-deploy",
    shape: WORKER,
    capabilities: ["scale-to-zero", "long-request", "geo-routing"] satisfies readonly WorkerCapability[],
  },
];

const SELFHOST_PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "@takos/selfhost-filesystem",
    shape: OBJECT_STORE,
    capabilities: ["presigned-urls"] satisfies readonly ObjectStoreCapability[],
  },
  {
    id: "@takos/selfhost-minio",
    shape: OBJECT_STORE,
    capabilities: [
      "versioning",
      "presigned-urls",
      "server-side-encryption",
      "public-access",
      "lifecycle-rules",
      "multipart-upload",
    ] satisfies readonly ObjectStoreCapability[],
  },
  {
    id: "@takos/selfhost-docker-compose",
    shape: WEB_SERVICE,
    capabilities: ["always-on", "websocket", "long-request", "sticky-session"] satisfies readonly WebServiceCapability[],
  },
  {
    id: "@takos/selfhost-systemd",
    shape: WEB_SERVICE,
    capabilities: ["always-on", "long-request"] satisfies readonly WebServiceCapability[],
  },
  {
    id: "@takos/selfhost-postgres",
    shape: DATABASE_POSTGRES,
    capabilities: ["ssl-required", "extensions"] satisfies readonly DatabasePostgresCapability[],
  },
  {
    id: "@takos/selfhost-coredns",
    shape: CUSTOM_DOMAIN,
    capabilities: ["wildcard"] satisfies readonly CustomDomainCapability[],
  },
];

/**
 * Build the production-ready set of shape-provider plugins.
 *
 * Each returned plugin posts lifecycle envelopes to the runtime-agent at
 * `opts.agentUrl`. The agent must have a connector registered for the
 * (shape, provider) tuple — operators control which connectors load via
 * the agent's `ConnectorBootOptions`.
 */
export function createTakosumiProductionProviders(
  opts: TakosumiProductionProviderOptions,
): readonly ProviderPlugin[] {
  const lifecycle = new RuntimeAgentLifecycle({
    agentUrl: opts.agentUrl,
    token: opts.token,
    fetch: opts.fetch,
    ...(opts.artifactStore ? { artifactStore: opts.artifactStore } : {}),
  });
  const clock = opts.clock ?? (() => new Date());

  const out: ProviderPlugin[] = [];
  const push = (entries: readonly ProviderEntry[]): void => {
    for (const entry of entries) {
      out.push(buildProvider(lifecycle, entry, clock));
    }
  };

  if (opts.enableAws !== false) push(AWS_PROVIDERS);
  if (opts.enableGcp !== false) push(GCP_PROVIDERS);
  if (opts.enableCloudflare !== false) push(CLOUDFLARE_PROVIDERS);
  if (opts.enableAzure !== false) push(AZURE_PROVIDERS);
  if (opts.enableKubernetes !== false) push(KUBERNETES_PROVIDERS);
  if (opts.enableSelfhost !== false) push(SELFHOST_PROVIDERS);
  if (opts.enableDenoDeploy === true) push(DENO_DEPLOY_PROVIDERS);

  return out;
}

function buildProvider(
  lifecycle: RuntimeAgentLifecycle,
  entry: ProviderEntry,
  clock: () => Date,
): ProviderPlugin {
  const shapeRef = `${entry.shape.id}@${entry.shape.version}`;
  return {
    id: entry.id,
    version: "1.0.0",
    implements: entry.shape,
    capabilities: entry.capabilities,

    async apply(spec, ctx): Promise<ApplyResult> {
      const resourceName = pickResourceName(spec);
      const result = await lifecycle.apply({
        shape: shapeRef,
        provider: entry.id,
        resourceName,
        spec: spec as JsonObject,
        ...tenantIdOf(ctx),
      });
      return {
        handle: result.handle,
        outputs: result.outputs,
      };
    },

    async destroy(handle: ResourceHandle, ctx): Promise<void> {
      await lifecycle.destroy({
        shape: shapeRef,
        provider: entry.id,
        handle,
        ...tenantIdOf(ctx),
      });
    },

    async status(
      handle: ResourceHandle,
      ctx,
    ): Promise<ResourceStatus> {
      const result = await lifecycle.describe({
        shape: shapeRef,
        provider: entry.id,
        handle,
        ...tenantIdOf(ctx),
      });
      const observedAt = clock().toISOString();
      switch (result.status) {
        case "running":
          return {
            kind: "ready",
            outputs: result.outputs,
            observedAt,
            ...(result.note ? { reason: result.note } : {}),
          };
        case "stopped":
          return {
            kind: "degraded",
            outputs: result.outputs,
            observedAt,
            ...(result.note ? { reason: result.note } : {}),
          };
        case "missing":
          return {
            kind: "deleted",
            observedAt,
            ...(result.note ? { reason: result.note } : {}),
          };
        case "error":
          return {
            kind: "failed",
            observedAt,
            ...(result.note ? { reason: result.note } : {}),
          };
        case "unknown":
        default:
          return {
            kind: "pending",
            observedAt,
            ...(result.note ? { reason: result.note } : {}),
          };
      }
    },
  };
}

/**
 * Pull a stable resource name from the spec. Every Takosumi shape that
 * needs a name carries `name`; web-service uses `image` as the implicit
 * identity. Falls back to an empty string — the runtime-agent connector
 * is responsible for synthesizing one when necessary.
 */
function pickResourceName(spec: unknown): string {
  if (spec && typeof spec === "object") {
    const obj = spec as Record<string, unknown>;
    if (typeof obj.name === "string" && obj.name.length > 0) return obj.name;
    if (typeof obj.image === "string" && obj.image.length > 0) {
      return imageToName(obj.image);
    }
  }
  return "";
}

function tenantIdOf(
  ctx: { readonly tenantId?: string } | undefined,
): { tenantId?: string } {
  if (ctx && typeof ctx.tenantId === "string" && ctx.tenantId.length > 0) {
    return { tenantId: ctx.tenantId };
  }
  return {};
}

function imageToName(image: string): string {
  const tail = image.split("/").at(-1) ?? image;
  const stripped = tail.split(":")[0] ?? tail;
  return stripped.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}
