import type { provider } from "takosumi-contract";
import type {
  RuntimeDesiredState,
  RuntimeRouteBindingSpec,
} from "takosumi-contract";
import {
  type AwsRetryConfig,
  classifyAwsError,
  compactRecord,
  detectDrift,
  type DriftField,
  runAwsCall,
} from "./support.ts";

/**
 * `provider.aws.alb@v1` + `provider.aws.target-group@v1` materializer.
 *
 * Tenant routing on the AWS profile uses an Application Load Balancer (ALB) as
 * the public ingress and one Target Group per tenant component. The kernel
 * never imports the AWS SDK directly: every entry point is an
 * operator-injected client (typically wrapping `elbv2` calls).
 *
 * Production-grade behaviour:
 *  - listener rule (path-based / host-based) materialization
 *  - health check spec on each target group
 *  - drift detection between desired and observed listener rules
 *  - retry / timeout via {@link runAwsCall}
 */

export type AwsLoadBalancerScheme = "internet-facing" | "internal";
export type AwsLoadBalancerType = "application" | "network";

export interface AwsAlbHealthCheck {
  readonly path?: string;
  readonly protocol?: "HTTP" | "HTTPS" | "TCP";
  readonly port?: number;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly healthyThreshold?: number;
  readonly unhealthyThreshold?: number;
}

export interface AwsTargetGroupSpec {
  readonly name: string;
  readonly port: number;
  readonly protocol: "HTTP" | "HTTPS" | "TCP";
  readonly vpcId?: string;
  readonly targetType?: "ip" | "instance" | "lambda" | "alb";
  readonly healthCheck?: AwsAlbHealthCheck;
  readonly deregistrationDelaySeconds?: number;
  readonly tags?: Record<string, string>;
}

export interface AwsAlbListenerRuleCondition {
  readonly hostHeader?: string;
  readonly pathPattern?: string;
  readonly httpMethods?: readonly string[];
}

export interface AwsAlbListenerRuleSpec {
  readonly priority: number;
  readonly conditions: AwsAlbListenerRuleCondition;
  readonly targetGroupName: string;
}

export interface AwsAlbListenerSpec {
  readonly port: number;
  readonly protocol: "HTTP" | "HTTPS";
  readonly certificateArn?: string;
  readonly defaultTargetGroupName?: string;
  readonly rules: readonly AwsAlbListenerRuleSpec[];
}

export interface AwsAlbApplyInput {
  readonly desiredState: RuntimeDesiredState;
  readonly loadBalancerName: string;
  readonly scheme?: AwsLoadBalancerScheme;
  readonly type?: AwsLoadBalancerType;
  readonly subnetIds: readonly string[];
  readonly securityGroupIds?: readonly string[];
  readonly listeners: readonly AwsAlbListenerSpec[];
  readonly targetGroups: readonly AwsTargetGroupSpec[];
  readonly tags?: Record<string, string>;
  readonly requestedAt: string;
}

export interface AwsTargetGroupDescriptor {
  readonly arn: string;
  readonly name: string;
  readonly port: number;
  readonly protocol: string;
}

export interface AwsAlbListenerRuleDescriptor {
  readonly arn: string;
  readonly priority: number;
  readonly conditions: AwsAlbListenerRuleCondition;
  readonly targetGroupArn: string;
}

export interface AwsAlbDescriptor {
  readonly loadBalancerArn: string;
  readonly dnsName: string;
  readonly hostedZoneId?: string;
  readonly listenerArns: readonly string[];
  readonly targetGroups: readonly AwsTargetGroupDescriptor[];
  readonly listenerRules: readonly AwsAlbListenerRuleDescriptor[];
}

export interface AwsAlbApplyResult {
  readonly alb: AwsAlbDescriptor;
  readonly objectAddress?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface AwsAlbDescribeInput {
  readonly loadBalancerName: string;
}

export interface AwsAlbDeleteInput {
  readonly loadBalancerArn: string;
  readonly force?: boolean;
}

export interface AwsAlbDeleteResult {
  readonly deleted: boolean;
}

export interface AwsLoadBalancerClient {
  applyLoadBalancer(input: AwsAlbApplyInput): Promise<AwsAlbApplyResult>;
  describeLoadBalancer?(
    input: AwsAlbDescribeInput,
  ): Promise<AwsAlbDescriptor | undefined>;
  deleteLoadBalancer?(
    input: AwsAlbDeleteInput,
  ): Promise<AwsAlbDeleteResult>;
}

export interface AwsLoadBalancerProviderOptions {
  readonly client: AwsLoadBalancerClient;
  /** Default LB name template; `${appName}` substituted with desired.appName. */
  readonly loadBalancerNameTemplate?: string;
  readonly scheme?: AwsLoadBalancerScheme;
  readonly type?: AwsLoadBalancerType;
  readonly subnetIds?: readonly string[];
  readonly securityGroupIds?: readonly string[];
  readonly certificateArn?: string;
  readonly vpcId?: string;
  readonly defaultHealthCheck?: AwsAlbHealthCheck;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly retry?: Partial<AwsRetryConfig>;
  /** Override the default route → listener-rule extractor. */
  readonly extractListenerSpec?: (
    desiredState: RuntimeDesiredState,
  ) => {
    readonly listeners: readonly AwsAlbListenerSpec[];
    readonly targetGroups: readonly AwsTargetGroupSpec[];
  };
}

export class AwsLoadBalancerProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: AwsLoadBalancerClient;
  readonly #options: AwsLoadBalancerProviderOptions;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #retry?: Partial<AwsRetryConfig>;
  readonly #extract: (
    desiredState: RuntimeDesiredState,
  ) => {
    readonly listeners: readonly AwsAlbListenerSpec[];
    readonly targetGroups: readonly AwsTargetGroupSpec[];
  };

  constructor(options: AwsLoadBalancerProviderOptions) {
    this.#client = options.client;
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#retry = options.retry;
    this.#extract = options.extractListenerSpec ??
      ((desiredState) => defaultExtractListenerSpec(desiredState, options));
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const lbName = resolveLoadBalancerName(
      this.#options.loadBalancerNameTemplate,
      desiredState.appName,
    );
    const { listeners, targetGroups } = this.#extract(desiredState);

    const outcome = await runAwsCall(
      {
        kind: "aws-alb-apply",
        target: lbName,
        desiredStateId: desiredState.id,
        command: [
          "aws",
          "elbv2",
          "create-load-balancer",
          "--name",
          lbName,
        ],
        details: compactRecord({
          scheme: this.#options.scheme,
          type: this.#options.type,
          listenerCount: listeners.length,
          targetGroupCount: targetGroups.length,
          routeCount: desiredState.routes.length,
        }),
        retry: this.#retry,
      },
      { clock: this.#clock, idGenerator: this.#idGenerator },
      () =>
        this.#client.applyLoadBalancer({
          desiredState: structuredClone(desiredState),
          loadBalancerName: lbName,
          scheme: this.#options.scheme,
          type: this.#options.type,
          subnetIds: this.#options.subnetIds ?? [],
          securityGroupIds: this.#options.securityGroupIds,
          listeners,
          targetGroups,
          requestedAt: this.#clock().toISOString(),
        }),
    );

    if (outcome.status === "failed") {
      this.#operations.push(outcome.operation);
      return deepFreeze({
        id: `provider_plan_${this.#idGenerator()}`,
        provider: "aws",
        desiredStateId: desiredState.id,
        recordedAt: outcome.operation.recordedAt,
        createdByOperationId: outcome.operation.id,
        operations: [outcome.operation],
      });
    }

    const result = outcome.result;
    const completedAt = outcome.operation.recordedAt;
    const operation: provider.ProviderOperation = {
      ...outcome.operation,
      targetId: result.alb.loadBalancerArn,
      targetName: lbName,
      details: compactRecord({
        ...outcome.operation.details,
        loadBalancerArn: result.alb.loadBalancerArn,
        dnsName: result.alb.dnsName,
        hostedZoneId: result.alb.hostedZoneId,
        listenerArns: result.alb.listenerArns,
        targetGroupArns: result.alb.targetGroups.map((tg) => tg.arn),
        listenerRuleCount: result.alb.listenerRules.length,
        objectAddress: result.objectAddress,
      }),
      execution: result.stderr
        ? {
          ...outcome.operation.execution!,
          status: "failed",
          code: 1,
          stderr: result.stderr,
          stdout: result.stdout,
        }
        : {
          ...outcome.operation.execution!,
          stdout: result.stdout,
          stderr: result.stderr,
        },
    };
    this.#operations.push(operation, ...(result.operations ?? []));
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "aws",
      desiredStateId: desiredState.id,
      recordedAt: completedAt,
      objectAddress: result.objectAddress,
      createdByOperationId: operation.id,
      operations: [operation, ...(result.operations ?? [])],
    });
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }

  /**
   * Compares observed listener rules / target groups to the desired set and
   * returns the list of fields that differ (used by drift detection).
   */
  async detectDrift(
    desiredState: RuntimeDesiredState,
  ): Promise<readonly DriftField[]> {
    if (!this.#client.describeLoadBalancer) {
      throw new Error(
        "AwsLoadBalancerClient does not implement describeLoadBalancer; cannot detect drift",
      );
    }
    const lbName = resolveLoadBalancerName(
      this.#options.loadBalancerNameTemplate,
      desiredState.appName,
    );
    const observed = await this.#client.describeLoadBalancer({
      loadBalancerName: lbName,
    });
    if (!observed) return [];
    const { listeners, targetGroups } = this.#extract(desiredState);
    const desired = compactRecord({
      listenerRuleCount: listeners.reduce((a, l) => a + l.rules.length, 0),
      targetGroupCount: targetGroups.length,
      hosts: hostsFromListeners(listeners),
    });
    const observedSubset = compactRecord({
      listenerRuleCount: observed.listenerRules.length,
      targetGroupCount: observed.targetGroups.length,
      hosts: hostsFromObserved(observed.listenerRules),
    });
    return detectDrift(desired, observedSubset);
  }
}

export { classifyAwsError };

function resolveLoadBalancerName(
  template: string | undefined,
  appName: string,
): string {
  if (!template) return `${appName}-alb`;
  return template.includes("${appName}")
    ? template.replace("${appName}", appName)
    : template;
}

function defaultExtractListenerSpec(
  desiredState: RuntimeDesiredState,
  options: AwsLoadBalancerProviderOptions,
): {
  readonly listeners: readonly AwsAlbListenerSpec[];
  readonly targetGroups: readonly AwsTargetGroupSpec[];
} {
  if (desiredState.routes.length === 0) {
    return { listeners: [], targetGroups: [] };
  }
  const targetGroupByComponent = new Map<string, AwsTargetGroupSpec>();
  const rules: AwsAlbListenerRuleSpec[] = [];
  let priority = 1;
  for (const route of desiredState.routes) {
    const tgName = `tg-${route.targetComponentName}`;
    const port = route.targetPort ?? route.port ?? 80;
    if (!targetGroupByComponent.has(tgName)) {
      targetGroupByComponent.set(tgName, {
        name: tgName,
        port,
        protocol: protocolForRoute(route),
        vpcId: options.vpcId,
        targetType: "ip",
        healthCheck: options.defaultHealthCheck ?? {
          path: "/healthz",
          protocol: "HTTP",
          port,
          intervalSeconds: 30,
          healthyThreshold: 2,
          unhealthyThreshold: 3,
        },
        deregistrationDelaySeconds: 30,
      });
    }
    rules.push({
      priority: priority++,
      conditions: {
        hostHeader: route.host,
        pathPattern: route.path ?? "/*",
      },
      targetGroupName: tgName,
    });
  }
  const certificateArn = options.certificateArn;
  const protocol: "HTTP" | "HTTPS" = certificateArn ? "HTTPS" : "HTTP";
  const port = protocol === "HTTPS" ? 443 : 80;
  const listener: AwsAlbListenerSpec = {
    port,
    protocol,
    certificateArn,
    defaultTargetGroupName: rules[0]?.targetGroupName,
    rules,
  };
  return {
    listeners: [listener],
    targetGroups: [...targetGroupByComponent.values()],
  };
}

function protocolForRoute(route: RuntimeRouteBindingSpec): "HTTP" | "HTTPS" {
  const proto = (route.protocol ?? "https").toLowerCase();
  return proto === "https" ? "HTTPS" : "HTTP";
}

function hostsFromListeners(
  listeners: readonly AwsAlbListenerSpec[],
): readonly string[] {
  const out = new Set<string>();
  for (const l of listeners) {
    for (const r of l.rules) {
      if (r.conditions.hostHeader) out.add(r.conditions.hostHeader);
    }
  }
  return [...out].sort();
}

function hostsFromObserved(
  rules: readonly AwsAlbListenerRuleDescriptor[],
): readonly string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.conditions.hostHeader) out.add(r.conditions.hostHeader);
  }
  return [...out].sort();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
