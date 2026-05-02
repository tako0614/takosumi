/**
 * Shared test utilities for the Phase 17A3 k8s provider tests.
 *
 * `FakeK8sClient` is a lightweight in-memory backend for the apply / get /
 * delete client surfaces. It supports:
 *   - per-method failure injection via `failOn` (replays a fixed sequence of
 *     errors, then succeeds)
 *   - drift simulation via `mutateOnGet`
 *   - call tracking via `calls` for assertions
 */
import type {
  K8sApplyClient,
  K8sApplyResult,
  K8sConfigMapSpec,
  K8sDeleteClient,
  K8sDeploymentSpec,
  K8sGetClient,
  K8sIngressSpec,
  K8sListInput,
  K8sListResult,
  K8sNamespaceSpec,
  K8sObjectKind,
  K8sObjectState,
  K8sSecretSpec,
  K8sServiceSpec,
} from "../src/providers/k8s/mod.ts";
import { fromHttpStatus } from "../src/providers/k8s/errors.ts";

export interface FakeK8sFailures {
  applyNamespace?: number[];
  applyDeployment?: number[];
  applyService?: number[];
  applyIngress?: number[];
  applyConfigMap?: number[];
  applySecret?: number[];
  getNamespace?: number[];
  getDeployment?: number[];
  getService?: number[];
  getIngress?: number[];
  getConfigMap?: number[];
  getSecret?: number[];
  deleteNamespace?: number[];
  deleteDeployment?: number[];
  deleteService?: number[];
  deleteIngress?: number[];
  deleteConfigMap?: number[];
  deleteSecret?: number[];
}

export class FakeK8sClient
  implements K8sApplyClient, K8sDeleteClient, K8sGetClient {
  readonly state = new Map<string, K8sObjectState>();
  readonly calls: Record<string, unknown[]> = {};
  readonly failures: FakeK8sFailures;
  private resourceVersionCounter = 0;

  constructor(failures: FakeK8sFailures = {}) {
    this.failures = {
      applyNamespace: [...(failures.applyNamespace ?? [])],
      applyDeployment: [...(failures.applyDeployment ?? [])],
      applyService: [...(failures.applyService ?? [])],
      applyIngress: [...(failures.applyIngress ?? [])],
      applyConfigMap: [...(failures.applyConfigMap ?? [])],
      applySecret: [...(failures.applySecret ?? [])],
      getNamespace: [...(failures.getNamespace ?? [])],
      getDeployment: [...(failures.getDeployment ?? [])],
      getService: [...(failures.getService ?? [])],
      getIngress: [...(failures.getIngress ?? [])],
      getConfigMap: [...(failures.getConfigMap ?? [])],
      getSecret: [...(failures.getSecret ?? [])],
      deleteNamespace: [...(failures.deleteNamespace ?? [])],
      deleteDeployment: [...(failures.deleteDeployment ?? [])],
      deleteService: [...(failures.deleteService ?? [])],
      deleteIngress: [...(failures.deleteIngress ?? [])],
      deleteConfigMap: [...(failures.deleteConfigMap ?? [])],
      deleteSecret: [...(failures.deleteSecret ?? [])],
    };
  }

  // ---------- Apply ----------

  applyNamespace(input: K8sNamespaceSpec): Promise<K8sApplyResult> {
    return this.#apply(
      "applyNamespace",
      "Namespace",
      "v1",
      undefined,
      input.metadata.name,
      () => ({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { ...input.metadata },
      }),
    );
  }

  applyDeployment(input: K8sDeploymentSpec): Promise<K8sApplyResult> {
    return this.#apply(
      "applyDeployment",
      "Deployment",
      "apps/v1",
      input.metadata.namespace,
      input.metadata.name,
      () => ({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { ...input.metadata },
        spec: {
          replicas: input.replicas ?? 1,
          template: {
            spec: { containers: input.containers.map((c) => ({ ...c })) },
          },
        },
      }),
    );
  }

  applyService(input: K8sServiceSpec): Promise<K8sApplyResult> {
    return this.#apply(
      "applyService",
      "Service",
      "v1",
      input.metadata.namespace,
      input.metadata.name,
      () => ({
        apiVersion: "v1",
        kind: "Service",
        metadata: { ...input.metadata },
        spec: {
          ports: input.ports.map((p) => ({ ...p })),
          selector: { ...input.selector },
        },
      }),
    );
  }

  applyIngress(input: K8sIngressSpec): Promise<K8sApplyResult> {
    return this.#apply(
      "applyIngress",
      "Ingress",
      "networking.k8s.io/v1",
      input.metadata.namespace,
      input.metadata.name,
      () => ({
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: { ...input.metadata },
        spec: { rules: input.rules.map((r) => ({ ...r })) },
      }),
    );
  }

  applyConfigMap(input: K8sConfigMapSpec): Promise<K8sApplyResult> {
    return this.#apply(
      "applyConfigMap",
      "ConfigMap",
      "v1",
      input.metadata.namespace,
      input.metadata.name,
      () => ({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { ...input.metadata },
        data: { ...input.data },
      }),
    );
  }

  applySecret(input: K8sSecretSpec): Promise<K8sApplyResult> {
    return this.#apply(
      "applySecret",
      "Secret",
      "v1",
      input.metadata.namespace,
      input.metadata.name,
      () => ({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { ...input.metadata },
        stringData: { ...(input.stringData ?? {}) },
      }),
    );
  }

  // ---------- Get ----------

  getNamespace(input: { name: string }): Promise<K8sObjectState | undefined> {
    return this.#get("getNamespace", undefined, "Namespace", input.name);
  }
  getDeployment(input: { namespace: string; name: string }) {
    return this.#get(
      "getDeployment",
      input.namespace,
      "Deployment",
      input.name,
    );
  }
  getService(input: { namespace: string; name: string }) {
    return this.#get("getService", input.namespace, "Service", input.name);
  }
  getIngress(input: { namespace: string; name: string }) {
    return this.#get("getIngress", input.namespace, "Ingress", input.name);
  }
  getConfigMap(input: { namespace: string; name: string }) {
    return this.#get("getConfigMap", input.namespace, "ConfigMap", input.name);
  }
  getSecret(input: { namespace: string; name: string }) {
    return this.#get("getSecret", input.namespace, "Secret", input.name);
  }

  listNamespaces(input: K8sListInput = {}): Promise<K8sListResult> {
    this.#track("listNamespaces", input);
    const items = [...this.state.values()].filter((item) =>
      item.kind === "Namespace"
    );
    return Promise.resolve({ items });
  }

  listInNamespace(input: {
    kind: K8sObjectKind;
    namespace: string;
    cursor?: string;
    limit?: number;
  }): Promise<K8sListResult> {
    this.#track("listInNamespace", input);
    const all = [...this.state.values()].filter((item) =>
      item.kind === input.kind && item.metadata.namespace === input.namespace
    );
    const limit = input.limit ?? all.length;
    const start = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const slice = all.slice(start, start + limit);
    const nextStart = start + slice.length;
    const nextCursor = nextStart < all.length ? String(nextStart) : undefined;
    return Promise.resolve({ items: slice, nextCursor });
  }

  // ---------- Delete ----------

  deleteNamespace(input: { name: string }) {
    return this.#delete("deleteNamespace", undefined, "Namespace", input.name);
  }
  deleteDeployment(input: { namespace: string; name: string }) {
    return this.#delete(
      "deleteDeployment",
      input.namespace,
      "Deployment",
      input.name,
    );
  }
  deleteService(input: { namespace: string; name: string }) {
    return this.#delete(
      "deleteService",
      input.namespace,
      "Service",
      input.name,
    );
  }
  deleteIngress(input: { namespace: string; name: string }) {
    return this.#delete(
      "deleteIngress",
      input.namespace,
      "Ingress",
      input.name,
    );
  }
  deleteConfigMap(input: { namespace: string; name: string }) {
    return this.#delete(
      "deleteConfigMap",
      input.namespace,
      "ConfigMap",
      input.name,
    );
  }
  deleteSecret(input: { namespace: string; name: string }) {
    return this.#delete("deleteSecret", input.namespace, "Secret", input.name);
  }

  // ---------- internal ----------

  #apply(
    key: keyof FakeK8sFailures,
    kind: K8sObjectKind,
    apiVersion: string,
    namespace: string | undefined,
    name: string,
    builder: () => K8sObjectState,
  ): Promise<K8sApplyResult> {
    this.#track(key, { namespace, name });
    this.#maybeFail(key);
    const id = stateId(kind, namespace, name);
    const next = builder();
    this.resourceVersionCounter += 1;
    const state: K8sObjectState = {
      ...next,
      apiVersion,
      kind,
      metadata: {
        ...next.metadata,
        resourceVersion: String(this.resourceVersionCounter),
        uid: this.state.get(id)?.metadata.uid ?? `uid-${id}`,
        generation: (this.state.get(id)?.metadata.generation ?? 0) + 1,
      },
    };
    this.state.set(id, state);
    return Promise.resolve({
      resourceVersion: state.metadata.resourceVersion,
      uid: state.metadata.uid,
      startedAt: "2026-04-30T00:00:00.000Z",
      completedAt: "2026-04-30T00:00:01.000Z",
    });
  }

  #get(
    key: keyof FakeK8sFailures,
    namespace: string | undefined,
    kind: K8sObjectKind,
    name: string,
  ): Promise<K8sObjectState | undefined> {
    this.#track(key, { namespace, name });
    this.#maybeFail(key);
    return Promise.resolve(this.state.get(stateId(kind, namespace, name)));
  }

  #delete(
    key: keyof FakeK8sFailures,
    namespace: string | undefined,
    kind: K8sObjectKind,
    name: string,
  ): Promise<K8sApplyResult> {
    this.#track(key, { namespace, name });
    this.#maybeFail(key);
    this.state.delete(stateId(kind, namespace, name));
    return Promise.resolve({
      startedAt: "2026-04-30T00:00:00.000Z",
      completedAt: "2026-04-30T00:00:01.000Z",
    });
  }

  #maybeFail(key: keyof FakeK8sFailures): void {
    const queue = this.failures[key];
    if (!queue || queue.length === 0) return;
    const status = queue.shift()!;
    throw fromHttpStatus(
      status,
      `injected ${key} failure status=${status}`,
    );
  }

  #track(method: string, payload: unknown): void {
    this.calls[method] = [...(this.calls[method] ?? []), payload];
  }
}

export function stateId(
  kind: K8sObjectKind,
  namespace: string | undefined,
  name: string,
): string {
  return `${kind}:${namespace ?? "_"}:${name}`;
}

export function fakeDesired(overrides: Partial<{
  spaceId: string;
  groupId: string;
  activationId: string;
  appName: string;
}> = {}) {
  return {
    id: "desired_1",
    spaceId: overrides.spaceId ?? "space_1",
    groupId: overrides.groupId ?? "group_1",
    activationId: overrides.activationId ?? "activation_1",
    appName: overrides.appName ?? "docs",
    materializedAt: "2026-04-30T00:00:00.000Z",
    workloads: [],
    resources: [],
    routes: [],
  };
}

export function fakeWorkload(overrides: Partial<{
  id: string;
  componentName: string;
  image: string;
  env: Record<string, string>;
  command: string[];
  args: string[];
}> = {}) {
  return {
    id: overrides.id ?? "wl_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    componentName: overrides.componentName ?? "web",
    runtimeName: "runtime/container@v1",
    type: "container",
    image: overrides.image ?? "ghcr.io/example/web:1.0",
    command: overrides.command ?? [],
    args: overrides.args ?? [],
    env: overrides.env ?? {},
    depends: [] as readonly string[],
  };
}

export function fakeResource(overrides: Partial<{
  id: string;
  resourceName: string;
  env: Record<string, string>;
}> = {}) {
  return {
    id: overrides.id ?? "res_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    resourceName: overrides.resourceName ?? "db",
    runtimeName: "resource/postgres@v1",
    type: "postgres",
    env: overrides.env ?? {},
  };
}

export function fakeRoute(overrides: Partial<{
  id: string;
  routeName: string;
  host: string;
  path: string;
  port: number;
  targetComponentName: string;
}> = {}) {
  return {
    id: overrides.id ?? "route_1",
    spaceId: "space_1",
    groupId: "group_1",
    activationId: "activation_1",
    routeName: overrides.routeName ?? "web",
    targetComponentName: overrides.targetComponentName ?? "web",
    host: overrides.host ?? "docs.example.test",
    path: overrides.path ?? "/",
    protocol: "https",
    port: overrides.port ?? 8080,
    targetPort: overrides.port ?? 8080,
  };
}

export function clockFrom(start: string) {
  let now = Date.parse(start);
  return () => {
    const value = new Date(now);
    now += 1; // monotonic, 1 ms steps so timeout budgets behave deterministically
    return value;
  };
}

export function noopSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}
