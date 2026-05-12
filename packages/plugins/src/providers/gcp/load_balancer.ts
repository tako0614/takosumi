import type { provider } from "takosumi-contract";
import type {
  RuntimeDesiredState,
  RuntimeRouteBindingSpec,
} from "takosumi-contract";
import {
  buildRuntimeDetails,
  compactRecord,
  computeDrift,
  computeIdempotencyKey,
  deepFreeze,
  executionFromCondition,
  type GcpDriftReport,
  type GcpRuntimeHooks,
  resolveRuntimeContext,
  withRetry,
} from "./_runtime.ts";

/**
 * `provider.gcp.load-balancer@v1` + `provider.gcp.url-map@v1` materializer.
 *
 * Tenant routing on the GCP profile uses an HTTP(S) Load Balancer fronted by a
 * URL map. Each tenant component is bound to a backend service plus health
 * check. The kernel never imports the GCP SDK directly: every entry point is
 * an operator-injected client wrapping `compute.googleapis.com` REST calls.
 *
 * Production-grade behaviour:
 *  - URL map host / path matcher materialization
 *  - backend service + health check spec per tenant component
 *  - SSL certificate attachment on the target HTTPS proxy
 *  - drift detection between desired and observed URL map / backend services
 *  - retry / timeout via {@link withRetry}
 */

export type GcpLoadBalancerScheme =
  | "EXTERNAL"
  | "EXTERNAL_MANAGED"
  | "INTERNAL_MANAGED";

export interface GcpHealthCheckSpec {
  readonly path?: string;
  readonly protocol?: "HTTP" | "HTTPS" | "TCP";
  readonly port?: number;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly healthyThreshold?: number;
  readonly unhealthyThreshold?: number;
}

export interface GcpBackendServiceSpec {
  readonly name: string;
  readonly protocol: "HTTP" | "HTTPS" | "HTTP2";
  readonly port: number;
  readonly portName?: string;
  readonly healthCheck?: GcpHealthCheckSpec;
  readonly connectionDrainingSeconds?: number;
  readonly negs?: readonly string[];
  readonly cdnEnabled?: boolean;
  readonly tags?: Record<string, string>;
}

export interface GcpUrlMapPathRule {
  readonly paths: readonly string[];
  readonly backendServiceName: string;
}

export interface GcpUrlMapHostRule {
  readonly hosts: readonly string[];
  readonly pathRules: readonly GcpUrlMapPathRule[];
  readonly defaultBackendServiceName?: string;
}

export interface GcpUrlMapSpec {
  readonly name: string;
  readonly hostRules: readonly GcpUrlMapHostRule[];
  readonly defaultBackendServiceName?: string;
}

export interface GcpSslCertificateSpec {
  readonly name: string;
  readonly managedDomains?: readonly string[];
  readonly selfManagedCertificate?: string;
  readonly selfManagedPrivateKey?: string;
}

export interface GcpLoadBalancerApplyInput {
  readonly desiredState: RuntimeDesiredState;
  readonly projectId: string;
  readonly region?: string;
  readonly scheme?: GcpLoadBalancerScheme;
  readonly loadBalancerName: string;
  readonly urlMap: GcpUrlMapSpec;
  readonly backendServices: readonly GcpBackendServiceSpec[];
  readonly sslCertificates?: readonly GcpSslCertificateSpec[];
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface GcpBackendServiceDescriptor {
  readonly name: string;
  readonly selfLink: string;
  readonly port: number;
  readonly protocol: string;
}

export interface GcpUrlMapDescriptor {
  readonly name: string;
  readonly selfLink: string;
  readonly hostCount: number;
  readonly pathRuleCount: number;
}

export interface GcpLoadBalancerDescriptor {
  readonly loadBalancerName: string;
  readonly forwardingRuleSelfLink: string;
  readonly ipAddress: string;
  readonly urlMap: GcpUrlMapDescriptor;
  readonly backendServices: readonly GcpBackendServiceDescriptor[];
  readonly sslCertificateSelfLinks?: readonly string[];
}

export interface GcpLoadBalancerApplyResult {
  readonly loadBalancer: GcpLoadBalancerDescriptor;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly observed?: GcpLoadBalancerObservedRecord;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface GcpLoadBalancerDescribeInput {
  readonly projectId: string;
  readonly loadBalancerName: string;
}

export interface GcpLoadBalancerObservedRecord {
  readonly loadBalancerName: string;
  readonly hostCount: number;
  readonly pathRuleCount: number;
  readonly backendServiceCount: number;
  readonly hosts: readonly string[];
  readonly ready?: boolean;
}

export interface GcpLoadBalancerClient {
  applyLoadBalancer(
    input: GcpLoadBalancerApplyInput,
  ): Promise<GcpLoadBalancerApplyResult>;
  describeLoadBalancer?(
    input: GcpLoadBalancerDescribeInput,
  ): Promise<GcpLoadBalancerObservedRecord | undefined>;
}

export interface GcpLoadBalancerProviderOptions {
  readonly client: GcpLoadBalancerClient;
  readonly projectId: string;
  readonly region?: string;
  readonly scheme?: GcpLoadBalancerScheme;
  /** Default LB name template; `${appName}` substituted with desired.appName. */
  readonly loadBalancerNameTemplate?: string;
  readonly defaultHealthCheck?: GcpHealthCheckSpec;
  readonly sslCertificateName?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly runtime?: GcpRuntimeHooks;
  readonly extractUrlMap?: (
    desiredState: RuntimeDesiredState,
  ) => {
    readonly urlMap: GcpUrlMapSpec;
    readonly backendServices: readonly GcpBackendServiceSpec[];
  };
}

/** Descriptor identifier consumed by Deployment.desired graphs. */
export const GCP_LOAD_BALANCER_DESCRIPTOR =
  "provider.gcp.load-balancer@v1" as const;
export const GCP_URL_MAP_DESCRIPTOR = "provider.gcp.url-map@v1" as const;

export class GcpLoadBalancerProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: GcpLoadBalancerClient;
  readonly #options: GcpLoadBalancerProviderOptions;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runtime?: GcpRuntimeHooks;
  readonly #extract: (
    desiredState: RuntimeDesiredState,
  ) => {
    readonly urlMap: GcpUrlMapSpec;
    readonly backendServices: readonly GcpBackendServiceSpec[];
  };

  constructor(options: GcpLoadBalancerProviderOptions) {
    this.#client = options.client;
    this.#options = options;
    this.#clock = options.clock ?? options.runtime?.clock ??
      (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#runtime = options.runtime;
    this.#extract = options.extractUrlMap ??
      ((desiredState) => defaultExtractUrlMap(desiredState, options));
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const ctx = resolveRuntimeContext({
      ...(this.#runtime ?? {}),
      clock: this.#clock,
    });
    const startedAt = ctx.clock().toISOString();
    const lbName = resolveLoadBalancerName(
      this.#options.loadBalancerNameTemplate,
      desiredState.appName,
    );
    const idempotencyKey = computeIdempotencyKey({
      descriptor: GCP_LOAD_BALANCER_DESCRIPTOR,
      desiredStateId: desiredState.id,
      targetId: lbName,
    });
    const { urlMap, backendServices } = this.#extract(desiredState);
    const sslCerts: readonly GcpSslCertificateSpec[] | undefined =
      this.#options.sslCertificateName
        ? [{
          name: this.#options.sslCertificateName,
          managedDomains: hostsFromUrlMap(urlMap),
        }]
        : undefined;

    const outcome = await withRetry(
      ctx,
      () =>
        this.#client.applyLoadBalancer({
          desiredState: structuredClone(desiredState),
          projectId: this.#options.projectId,
          region: this.#options.region,
          scheme: this.#options.scheme,
          loadBalancerName: lbName,
          urlMap,
          backendServices,
          sslCertificates: sslCerts,
          idempotencyKey,
          requestedAt: startedAt,
        }),
      {
        handoffInput: {
          descriptor: GCP_LOAD_BALANCER_DESCRIPTOR,
          desiredStateId: desiredState.id,
          targetId: lbName,
          idempotencyKey,
          enqueuedAt: startedAt,
        },
      },
    );
    const completedAt = ctx.clock().toISOString();
    const result = outcome.result;
    const desiredObservedSnapshot: Record<string, unknown> = {
      loadBalancerName: lbName,
      hostCount: urlMap.hostRules.length,
      pathRuleCount: pathRuleCount(urlMap),
      backendServiceCount: backendServices.length,
      hosts: hostsFromUrlMap(urlMap),
    };
    const drift = result?.observed
      ? computeDrift(
        desiredObservedSnapshot,
        result.observed,
        completedAt,
      )
      : undefined;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "gcp-load-balancer-apply",
      provider: "gcp",
      desiredStateId: desiredState.id,
      targetId: result?.loadBalancer.loadBalancerName ?? lbName,
      targetName: lbName,
      command: [
        "gcloud",
        "compute",
        "url-maps",
        "create",
        urlMap.name,
        `--project=${this.#options.projectId}`,
      ],
      details: {
        descriptor: GCP_LOAD_BALANCER_DESCRIPTOR,
        urlMapDescriptor: GCP_URL_MAP_DESCRIPTOR,
        ...compactRecord({
          projectId: this.#options.projectId,
          region: this.#options.region,
          scheme: this.#options.scheme,
          loadBalancerName: lbName,
          urlMapName: urlMap.name,
          forwardingRuleSelfLink: result?.loadBalancer.forwardingRuleSelfLink,
          ipAddress: result?.loadBalancer.ipAddress,
          backendServiceCount: backendServices.length,
          hostRuleCount: urlMap.hostRules.length,
          pathRuleCount: pathRuleCount(urlMap),
        }),
        ...(result?.loadBalancer.sslCertificateSelfLinks
          ? {
            sslCertificateSelfLinks:
              result.loadBalancer.sslCertificateSelfLinks,
          }
          : {}),
        ...buildRuntimeDetails(outcome, idempotencyKey),
        ...(drift ? { drift } : {}),
      },
      recordedAt: completedAt,
      execution: executionFromCondition(
        outcome.condition,
        startedAt,
        completedAt,
        result?.stdout,
        result?.stderr,
      ),
    };
    this.#operations.push(operation, ...(result?.operations ?? []));
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "gcp",
      desiredStateId: desiredState.id,
      recordedAt: completedAt,
      objectAddress: result?.loadBalancer.forwardingRuleSelfLink,
      createdByOperationId: operation.id,
      operations: [operation, ...(result?.operations ?? [])],
    });
  }

  async observe(
    desiredState: RuntimeDesiredState,
  ): Promise<GcpDriftReport> {
    if (!this.#client.describeLoadBalancer) {
      return {
        status: "unknown",
        entries: [],
        observedAt: this.#clock().toISOString(),
      };
    }
    const lbName = resolveLoadBalancerName(
      this.#options.loadBalancerNameTemplate,
      desiredState.appName,
    );
    const observed = await this.#client.describeLoadBalancer({
      projectId: this.#options.projectId,
      loadBalancerName: lbName,
    });
    const observedAt = this.#clock().toISOString();
    if (!observed) return { status: "missing", entries: [], observedAt };
    const { urlMap, backendServices } = this.#extract(desiredState);
    const desired: Record<string, unknown> = {
      loadBalancerName: lbName,
      hostCount: urlMap.hostRules.length,
      pathRuleCount: pathRuleCount(urlMap),
      backendServiceCount: backendServices.length,
      hosts: hostsFromUrlMap(urlMap),
    };
    return computeDrift(
      desired,
      observed,
      observedAt,
    );
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }
}

function resolveLoadBalancerName(
  template: string | undefined,
  appName: string,
): string {
  if (!template) return `${appName}-lb`;
  return template.includes("${appName}")
    ? template.replace("${appName}", appName)
    : template;
}

function defaultExtractUrlMap(
  desiredState: RuntimeDesiredState,
  options: GcpLoadBalancerProviderOptions,
): {
  readonly urlMap: GcpUrlMapSpec;
  readonly backendServices: readonly GcpBackendServiceSpec[];
} {
  const lbName = resolveLoadBalancerName(
    options.loadBalancerNameTemplate,
    desiredState.appName,
  );
  if (desiredState.routes.length === 0) {
    return {
      urlMap: { name: `${lbName}-url-map`, hostRules: [] },
      backendServices: [],
    };
  }
  const backendByComponent = new Map<string, GcpBackendServiceSpec>();
  const hostMap = new Map<
    string,
    {
      readonly host: string;
      readonly pathRules: GcpUrlMapPathRule[];
    }
  >();
  for (const route of desiredState.routes) {
    const backendName = `bs-${route.targetComponentName}`;
    const port = route.targetPort ?? route.port ?? 80;
    if (!backendByComponent.has(backendName)) {
      backendByComponent.set(backendName, {
        name: backendName,
        port,
        protocol: protocolForRoute(route),
        healthCheck: options.defaultHealthCheck ?? {
          path: "/healthz",
          protocol: "HTTP",
          port,
          intervalSeconds: 30,
          healthyThreshold: 2,
          unhealthyThreshold: 3,
        },
        connectionDrainingSeconds: 30,
      });
    }
    const host = route.host ?? "*";
    if (!hostMap.has(host)) {
      hostMap.set(host, { host, pathRules: [] });
    }
    hostMap.get(host)!.pathRules.push({
      paths: [route.path ?? "/*"],
      backendServiceName: backendName,
    });
  }
  const hostRules: GcpUrlMapHostRule[] = [...hostMap.values()].map((entry) => ({
    hosts: [entry.host],
    pathRules: entry.pathRules,
    defaultBackendServiceName: entry.pathRules[0]?.backendServiceName,
  }));
  const firstBackend = backendByComponent.keys().next().value;
  return {
    urlMap: {
      name: `${lbName}-url-map`,
      hostRules,
      defaultBackendServiceName: firstBackend,
    },
    backendServices: [...backendByComponent.values()],
  };
}

function protocolForRoute(
  route: RuntimeRouteBindingSpec,
): "HTTP" | "HTTPS" | "HTTP2" {
  const proto = (route.protocol ?? "https").toLowerCase();
  return proto === "https" ? "HTTPS" : "HTTP";
}

function hostsFromUrlMap(urlMap: GcpUrlMapSpec): readonly string[] {
  const out = new Set<string>();
  for (const rule of urlMap.hostRules) {
    for (const host of rule.hosts) {
      if (host && host !== "*") out.add(host);
    }
  }
  return [...out].sort();
}

function pathRuleCount(urlMap: GcpUrlMapSpec): number {
  let count = 0;
  for (const rule of urlMap.hostRules) count += rule.pathRules.length;
  return count;
}
