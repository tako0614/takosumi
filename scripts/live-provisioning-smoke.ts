#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net

import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import type { provider, RuntimeDesiredState } from "takosumi-contract";
import {
  assertProviderProofFixture,
  operationDescriptor,
  type ProviderProofExecutionMode,
  type ProviderProofFixture,
  type ProviderProofProvider,
  type ProviderProofReport,
  type ProviderProofStepReport,
} from "../packages/plugins/src/providers/proof.ts";

const ROOT_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_FIXTURE_FILES = [
  "aws.shape-v1.json",
  "gcp.shape-v1.json",
  "kubernetes.shape-v1.json",
  "cloudflare.shape-v1.json",
  "selfhosted.shape-v1.json",
] as const;

export interface SmokeOptions {
  readonly mode: ProviderProofExecutionMode;
  readonly fixtureFile?: string;
  readonly provider?: ProviderProofProvider;
  readonly cleanupOnly?: boolean;
  readonly gateway?: GatewayConfig;
  readonly fetch?: typeof fetch;
}

export interface GatewayConfig {
  readonly baseUrl: string;
  readonly bearerToken?: string;
  readonly headers?: HeadersInit;
}

export interface AggregateProviderProofReport {
  readonly status: "passed" | "failed";
  readonly executionMode: ProviderProofExecutionMode;
  readonly live: boolean;
  readonly providers: readonly ProviderProofProvider[];
  readonly reports: readonly ProviderProofReport[];
}

export async function main(args = Deno.args): Promise<number> {
  try {
    const options = parseOptions(args, Deno.env.toObject());
    const report = await runFromOptions(options);
    console.log(JSON.stringify(report, null, 2));
    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

export async function runFromOptions(
  options: SmokeOptions,
): Promise<ProviderProofReport | AggregateProviderProofReport> {
  if (options.mode === "fixture" && !options.fixtureFile) {
    return runBundledFixtureProof();
  }

  const fixtureFile = options.fixtureFile;
  if (!fixtureFile) {
    throw new Error("TAKOSUMI_PLUGIN_LIVE_PROOF_FIXTURE_FILE is required");
  }
  const fixture = await loadProofFixture(fixtureFile);
  const provider = options.provider ?? fixture.provider;
  if (provider !== fixture.provider) {
    throw new Error(
      `fixture provider ${fixture.provider} does not match requested provider ${provider}`,
    );
  }

  if (options.mode === "fixture") {
    return runFixtureProof(fixture);
  }
  if (!options.gateway) {
    throw new Error("TAKOSUMI_PLUGIN_GATEWAY_URL is required in live mode");
  }
  return runLiveProof(fixture, options.gateway, {
    cleanupOnly: options.cleanupOnly === true,
    fetch: options.fetch ?? fetch,
  });
}

export async function runBundledFixtureProof(): Promise<
  AggregateProviderProofReport
> {
  const reports: ProviderProofReport[] = [];
  for (const file of DEFAULT_FIXTURE_FILES) {
    const fixture = await loadProofFixture(
      join(ROOT_DIR, "fixtures/live-provisioning", file),
    );
    reports.push(await runFixtureProof(fixture));
  }
  const status = reports.every((report) => report.status === "passed")
    ? "passed"
    : "failed";
  return {
    status,
    executionMode: "fixture",
    live: false,
    providers: reports.map((report) => report.provider),
    reports,
  };
}

export async function loadProofFixture(
  fixtureFile: string,
): Promise<ProviderProofFixture> {
  const raw = JSON.parse(await Deno.readTextFile(fixtureFile));
  if (isProviderProofEnvelope(raw)) {
    assertProviderProofFixture(raw);
    return normalizeProofFixture(raw);
  }
  return manifestToProofFixture(raw, basename(fixtureFile));
}

export function manifestToProofFixture(
  manifest: unknown,
  sourceName = "manifest.json",
): ProviderProofFixture {
  if (!isRecord(manifest)) {
    throw new Error(`${sourceName}: fixture manifest must be a JSON object`);
  }
  const metadata = record(manifest.metadata, `${sourceName}: metadata`);
  const resources = arrayOfRecords(
    manifest.resources,
    `${sourceName}: resources`,
  );
  if (resources.length === 0) {
    throw new Error(`${sourceName}: resources must not be empty`);
  }

  const providerName = providerFromManifest(sourceName, resources);
  const desiredBase = {
    id: stringValue(metadata.runId ?? metadata.name, `${sourceName}: runId`),
    spaceId: stringValue(
      metadata.spaceId ?? "space_live_smoke",
      `${sourceName}: spaceId`,
    ),
    groupId: stringValue(
      metadata.groupId ?? "group_live_smoke",
      `${sourceName}: groupId`,
    ),
    activationId: stringValue(
      metadata.activationId ?? `activation_${providerName}_live_smoke`,
      `${sourceName}: activationId`,
    ),
    appName: stringValue(metadata.name, `${sourceName}: metadata.name`),
    materializedAt: stringValue(
      metadata.materializedAt ?? new Date(0).toISOString(),
      `${sourceName}: materializedAt`,
    ),
  };
  const desiredState = {
    ...desiredBase,
    workloads: resources
      .filter((resource) => isWorkloadShape(resource.shape))
      .map((resource) => resourceToRuntimeWorkload(resource, desiredBase)),
    resources: resources
      .filter((resource) =>
        !isWorkloadShape(resource.shape) && !isRouteShape(resource.shape)
      )
      .map((resource) => resourceToRuntimeResource(resource, desiredBase)),
    routes: resources
      .filter((resource) => isRouteShape(resource.shape))
      .map((resource) => resourceToRuntimeRoute(resource, desiredBase)),
  } satisfies RuntimeDesiredState;

  const fixture: ProviderProofFixture = {
    version: "takos.provider-proof/v1",
    provider: providerName,
    runId: desiredState.id,
    desiredState: desiredState as unknown as ProviderProofFixture[
      "desiredState"
    ],
    expectedDescriptors: resources.map(resourceDescriptor),
    verify: { gateway: true, expectedStatus: 200 },
    cleanup: { enabled: true, strategy: "gateway", requireSmokeLabels: true },
    metadata: { source: sourceName },
  };
  assertProviderProofFixture(fixture);
  return fixture;
}

export function runFixtureProof(
  fixture: ProviderProofFixture,
): ProviderProofReport {
  const startedAt = now();
  const operations = fixture.expectedDescriptors.map((descriptor, index) =>
    fixtureOperation(fixture, descriptor, index, startedAt)
  );
  const materialization: provider.ProviderMaterializationPlan = {
    id: `provider_plan_${fixture.runId}`,
    provider: fixture.provider,
    desiredStateId: fixture.desiredState.id,
    recordedAt: startedAt,
    operations,
  };
  const descriptorCheck = descriptorStep(fixture, operations);
  const cleanupEnabled = fixture.cleanup?.enabled !== false;
  const cleanupChecks: ProviderProofStepReport[] = cleanupEnabled
    ? [{
      name: "fixture-teardown",
      status: "passed",
      message: "fixture teardown path completed",
      observed: { clearedOperations: operations.length },
    }]
    : [];
  const checks = [
    {
      name: "fixture-materialize",
      status: "passed" as const,
      message: "fixture materialization path completed",
      observed: { operationCount: operations.length },
    },
    descriptorCheck,
    {
      name: "fixture-verify",
      status: "passed" as const,
      message: "fixture verification path completed",
    },
  ];
  return reportFor(fixture, "fixture", false, {
    materialization,
    operations,
    checks,
    cleanup: {
      attempted: cleanupEnabled,
      retained: false,
      checks: cleanupChecks,
    },
  });
}

export async function runLiveProof(
  fixture: ProviderProofFixture,
  gateway: GatewayConfig,
  options: { cleanupOnly?: boolean; fetch?: typeof fetch } = {},
): Promise<ProviderProofReport> {
  const httpFetch = options.fetch ?? fetch;
  const client = new GatewayClient(gateway, httpFetch);
  const checks: ProviderProofStepReport[] = [];
  let materialization: unknown;
  let operations: readonly unknown[] = [];

  if (options.cleanupOnly === true) {
    return runLiveCleanupOnly(fixture, client);
  }

  try {
    materialization = await client.post(
      "provider/materialize-desired-state",
      fixture.desiredState,
    );
    checks.push({
      name: "gateway-materialize",
      status: "passed",
      message: "provider gateway materialized desired state",
      observed: materialization,
    });
  } catch (error) {
    checks.push(failedStep("gateway-materialize", error));
  }

  try {
    operations = collectOperations(
      materialization,
      await client.post("provider/list-operations", {}),
    );
    checks.push(descriptorStep(fixture, operations));
  } catch (error) {
    checks.push(failedStep("gateway-list-operations", error));
  }

  if (fixture.verify.gateway !== false) {
    try {
      const observed = await client.post(
        "provider/verify-desired-state",
        fixture.desiredState,
      );
      checks.push(gatewayVerifyStep(observed));
    } catch (error) {
      checks.push(failedStep("gateway-verify", error));
    }
  }

  if (fixture.verify.endpointUrl) {
    try {
      checks.push(await endpointVerifyStep(fixture, httpFetch));
    } catch (error) {
      checks.push(failedStep("endpoint-verify", error));
    }
  }

  return reportFor(fixture, "live", true, {
    materialization,
    operations,
    checks,
    cleanup: {
      attempted: false,
      retained: fixture.cleanup?.enabled !== false,
      checks: [],
    },
  });
}

async function runLiveCleanupOnly(
  fixture: ProviderProofFixture,
  client: GatewayClient,
): Promise<ProviderProofReport> {
  const checks: ProviderProofStepReport[] = [];
  let operations: readonly unknown[] = [];
  try {
    const observed = await client.post(
      "provider/teardown-desired-state",
      fixture.desiredState,
    );
    checks.push({
      name: "gateway-teardown",
      status: "passed",
      message: "provider gateway teardown completed",
      observed,
    });
  } catch (error) {
    checks.push(failedStep("gateway-teardown", error));
  }

  try {
    operations = collectOperations(
      undefined,
      await client.post("provider/list-operations", {}),
    );
    await client.post("provider/clear-operations", {});
    checks.push({
      name: "gateway-clear-operations",
      status: "passed",
      message: "provider gateway operations were listed and cleared",
      observed: { operationCount: operations.length },
    });
  } catch (error) {
    checks.push(failedStep("gateway-clear-operations", error));
  }

  return reportFor(fixture, "live", true, {
    operations,
    checks: [],
    cleanup: {
      attempted: true,
      retained: checks.some((check) => check.status === "failed"),
      checks,
    },
  });
}

function parseOptions(
  args: readonly string[],
  env: Record<string, string | undefined>,
): SmokeOptions {
  if (args.includes("--fixture-all")) {
    return { mode: "fixture" };
  }

  const provider = providerFromEnv(env);
  const mode = executionMode(env.TAKOSUMI_PLUGIN_LIVE_PROOF_MODE);
  const fixtureFile = env.TAKOSUMI_PLUGIN_LIVE_PROOF_FIXTURE_FILE;
  const cleanupOnly = env.TAKOSUMI_PLUGIN_LIVE_CLEANUP_ONLY === "1" ||
    env.TAKOSUMI_PLUGIN_LIVE_CLEANUP_ONLY === "true";
  const gateway = mode === "live" ? gatewayFromEnv(provider, env) : undefined;
  return { mode, fixtureFile, provider, cleanupOnly, gateway };
}

function providerFromEnv(
  env: Record<string, string | undefined>,
): ProviderProofProvider | undefined {
  const value = env.TAKOSUMI_PLUGIN_LIVE_PROVIDER;
  if (value === undefined || value === "") return undefined;
  if (!isProvider(value)) {
    throw new Error(`unsupported provider: ${value}`);
  }
  return value;
}

function executionMode(value: string | undefined): ProviderProofExecutionMode {
  if (value === undefined || value === "") return "fixture";
  if (value === "fixture" || value === "live") return value;
  throw new Error(`unsupported proof mode: ${value}`);
}

function gatewayFromEnv(
  providerName: ProviderProofProvider | undefined,
  env: Record<string, string | undefined>,
): GatewayConfig {
  const prefixes = envPrefixes(providerName);
  const baseUrl = firstEnv(env, [
    "TAKOSUMI_PLUGIN_GATEWAY_URL",
    ...prefixes.map((prefix) => `${prefix}_GATEWAY_URL`),
  ]);
  if (!baseUrl) {
    throw new Error("TAKOSUMI_PLUGIN_GATEWAY_URL is required in live mode");
  }
  const bearerToken = firstEnv(env, [
    "TAKOSUMI_PLUGIN_GATEWAY_BEARER_TOKEN",
    ...prefixes.map((prefix) => `${prefix}_GATEWAY_BEARER_TOKEN`),
  ]);
  const headersJson = firstEnv(env, [
    "TAKOSUMI_PLUGIN_GATEWAY_HEADERS",
    ...prefixes.map((prefix) => `${prefix}_GATEWAY_HEADERS`),
  ]);
  const headers = headersJson ? parseHeaders(headersJson) : undefined;
  return { baseUrl, bearerToken, headers };
}

function envPrefixes(
  providerName: ProviderProofProvider | undefined,
): readonly string[] {
  if (!providerName) return [];
  const upper = providerName.toUpperCase();
  if (providerName === "k8s") {
    return ["TAKOSUMI_PLUGIN_K8S", "TAKOSUMI_PLUGIN_KUBERNETES"];
  }
  if (providerName === "kubernetes") {
    return ["TAKOSUMI_PLUGIN_KUBERNETES", "TAKOSUMI_PLUGIN_K8S"];
  }
  return [`TAKOSUMI_PLUGIN_${upper}`];
}

function parseHeaders(headersJson: string): HeadersInit {
  const value = JSON.parse(headersJson);
  if (!isRecord(value)) {
    throw new Error("TAKOSUMI_PLUGIN_GATEWAY_HEADERS must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" ? entry : JSON.stringify(entry),
    ]),
  );
}

function firstEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value && value.length > 0) return value;
  }
  return undefined;
}

class GatewayClient {
  readonly #gateway: GatewayConfig;
  readonly #fetch: typeof fetch;

  constructor(gateway: GatewayConfig, fetchImpl: typeof fetch) {
    this.#gateway = gateway;
    this.#fetch = fetchImpl;
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const headers = new Headers(this.#gateway.headers);
    headers.set("content-type", "application/json");
    if (this.#gateway.bearerToken) {
      headers.set("authorization", `Bearer ${this.#gateway.bearerToken}`);
    }
    const response = await this.#fetch(
      gatewayUrl(this.#gateway.baseUrl, path),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      throw new Error(
        `gateway ${path} failed with HTTP ${response.status}: ${text}`,
      );
    }
    return isRecord(json) && "result" in json ? json.result : json;
  }
}

function gatewayUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, base).toString();
}

function reportFor(
  fixture: ProviderProofFixture,
  executionModeValue: ProviderProofExecutionMode,
  live: boolean,
  parts: {
    readonly materialization?: unknown;
    readonly operations: readonly unknown[];
    readonly checks: readonly ProviderProofStepReport[];
    readonly cleanup: {
      readonly attempted: boolean;
      readonly retained: boolean;
      readonly checks: readonly ProviderProofStepReport[];
    };
  },
): ProviderProofReport {
  const allChecks = [...parts.checks, ...parts.cleanup.checks];
  return {
    status: allChecks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
    executionMode: executionModeValue,
    live,
    provider: fixture.provider,
    runId: fixture.runId,
    desiredStateId: fixture.desiredState.id,
    materialization: parts.materialization,
    verification: { checks: parts.checks },
    cleanup: parts.cleanup,
    operations: parts.operations,
  };
}

function descriptorStep(
  fixture: ProviderProofFixture,
  operations: readonly unknown[],
): ProviderProofStepReport {
  const observed = operations
    .map(operationDescriptor)
    .filter((value): value is string => value !== undefined);
  const missing = fixture.expectedDescriptors.filter((descriptor) =>
    !observed.includes(descriptor)
  );
  if (missing.length > 0) {
    return {
      name: "expected-descriptors",
      status: "failed",
      message: `missing expected descriptor(s): ${missing.join(", ")}`,
      observed,
    };
  }
  return {
    name: "expected-descriptors",
    status: "passed",
    message: "all expected provider descriptors were observed",
    observed,
  };
}

function gatewayVerifyStep(observed: unknown): ProviderProofStepReport {
  if (isRecord(observed) && observed.ok === false) {
    return {
      name: "gateway-verify",
      status: "failed",
      message: "provider gateway verification reported failure",
      observed,
    };
  }
  return {
    name: "gateway-verify",
    status: "passed",
    message: "provider gateway verification completed",
    observed,
  };
}

async function endpointVerifyStep(
  fixture: ProviderProofFixture,
  fetchImpl: typeof fetch,
): Promise<ProviderProofStepReport> {
  const endpointUrl = fixture.verify.endpointUrl;
  if (!endpointUrl) {
    throw new Error("fixture verify.endpointUrl is missing");
  }
  const expectedStatus = fixture.verify.expectedStatus ?? 200;
  const url = fixture.verify.healthPath
    ? new URL(fixture.verify.healthPath, endpointUrl).toString()
    : endpointUrl;
  const controller = new AbortController();
  const timeoutMs = fixture.verify.timeoutMs ?? fixture.timeouts?.verifyMs ??
    30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (response.status !== expectedStatus) {
      return {
        name: "endpoint-verify",
        status: "failed",
        message: `expected HTTP ${expectedStatus}, got ${response.status}`,
        observed: { url, status: response.status },
      };
    }
    return {
      name: "endpoint-verify",
      status: "passed",
      message: `endpoint returned HTTP ${expectedStatus}`,
      observed: { url, status: response.status },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function collectOperations(
  materialization: unknown,
  listed: unknown,
): readonly unknown[] {
  const operations: unknown[] = [];
  if (isRecord(materialization) && Array.isArray(materialization.operations)) {
    operations.push(...materialization.operations);
  }
  if (Array.isArray(listed)) {
    operations.push(...listed);
  } else if (isRecord(listed) && Array.isArray(listed.operations)) {
    operations.push(...listed.operations);
  }
  return operations;
}

function failedStep(name: string, error: unknown): ProviderProofStepReport {
  return {
    name,
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function fixtureOperation(
  fixture: ProviderProofFixture,
  descriptor: string,
  index: number,
  timestamp: string,
): provider.ProviderOperation {
  return {
    id: `provider_op_${fixture.runId}_${index}`,
    kind: "fixture-provider-proof",
    provider: fixture.provider,
    desiredStateId: fixture.desiredState.id,
    targetName: descriptor,
    command: [
      "takosumi",
      "provider-proof",
      "fixture",
      fixture.provider,
      descriptor,
    ],
    details: { descriptor },
    recordedAt: timestamp,
    execution: {
      status: "succeeded",
      code: 0,
      startedAt: timestamp,
      completedAt: timestamp,
    },
  };
}

function normalizeProofFixture(
  fixture: ProviderProofFixture,
): ProviderProofFixture {
  const desiredState = fixture.desiredState as unknown as RuntimeDesiredState;
  return {
    ...fixture,
    desiredState: {
      ...desiredState,
      materializedAt: desiredState.materializedAt ?? now(),
    },
  };
}

function isProviderProofEnvelope(
  value: unknown,
): value is ProviderProofFixture {
  return isRecord(value) && value.version === "takos.provider-proof/v1";
}

function providerFromManifest(
  sourceName: string,
  resources: readonly Record<string, unknown>[],
): ProviderProofProvider {
  const providerFromName = providerFromSourceName(sourceName);
  if (providerFromName) return providerFromName;
  const providerNames = new Set(
    resources.map((resource) =>
      manifestProviderFamily(
        stringValue(resource.provider, `${sourceName}: resource.provider`),
      )
    ),
  );
  if (providerNames.size !== 1) {
    throw new Error(
      `${sourceName}: live provisioning fixture must target one provider family, got ${
        [...providerNames].join(", ")
      }`,
    );
  }
  const [providerName] = [...providerNames];
  if (!isProvider(providerName)) {
    throw new Error(`${sourceName}: unsupported provider ${providerName}`);
  }
  return providerName;
}

function providerFromSourceName(
  sourceName: string,
): ProviderProofProvider | undefined {
  if (sourceName.startsWith("aws")) return "aws";
  if (sourceName.startsWith("gcp")) return "gcp";
  if (sourceName.startsWith("kubernetes")) return "kubernetes";
  if (sourceName.startsWith("cloudflare")) return "cloudflare";
  if (sourceName.startsWith("selfhosted")) return "selfhosted";
  if (sourceName.startsWith("azure")) return "azure";
  return undefined;
}

function manifestProviderFamily(providerId: string): string {
  if (
    providerId.startsWith("aws") || providerId === "route53" ||
    providerId === "s3"
  ) return "aws";
  if (
    providerId.startsWith("gcp") || providerId === "cloud-run" ||
    providerId === "cloud-sql" || providerId === "cloud-dns"
  ) return "gcp";
  if (
    providerId.startsWith("k8s") || providerId.startsWith("kubernetes") ||
    providerId === "k3s-deployment" || providerId === "coredns-local"
  ) return "kubernetes";
  if (providerId.startsWith("cloudflare")) return "cloudflare";
  if (
    providerId.startsWith("selfhost") ||
    providerId === "filesystem" ||
    providerId === "local-docker" ||
    providerId === "docker-compose" ||
    providerId === "coredns-local" ||
    providerId === "systemd-unit" ||
    providerId === "minio" ||
    providerId === "postgres"
  ) return "selfhosted";
  if (providerId.startsWith("azure")) return "azure";
  return providerId;
}

function resourceToRuntimeWorkload(
  resource: Record<string, unknown>,
  base: RuntimeDesiredStateBase,
): RuntimeDesiredState["workloads"][number] {
  const name = stringValue(resource.name, "resource.name");
  return {
    id: `${base.activationId}:workload:${name}`,
    spaceId: base.spaceId,
    groupId: base.groupId,
    activationId: base.activationId,
    componentName: name,
    runtimeName: stringValue(resource.provider, "resource.provider"),
    type: stringValue(resource.shape, "resource.shape"),
    image: specString(resource, "image"),
    command: [],
    args: [],
    env: bindingEnv(resource),
    depends: [],
  };
}

function resourceToRuntimeResource(
  resource: Record<string, unknown>,
  base: RuntimeDesiredStateBase,
): RuntimeDesiredState["resources"][number] {
  const name = stringValue(resource.name, "resource.name");
  return {
    id: `${base.activationId}:resource:${name}`,
    spaceId: base.spaceId,
    groupId: base.groupId,
    activationId: base.activationId,
    resourceName: name,
    runtimeName: stringValue(resource.provider, "resource.provider"),
    type: stringValue(resource.shape, "resource.shape"),
    env: bindingEnv(resource),
  };
}

function resourceToRuntimeRoute(
  resource: Record<string, unknown>,
  base: RuntimeDesiredStateBase,
): RuntimeDesiredState["routes"][number] {
  const name = stringValue(resource.name, "resource.name");
  const spec = record(resource.spec ?? {}, "resource.spec");
  return {
    id: `${base.activationId}:route:${name}`,
    spaceId: base.spaceId,
    groupId: base.groupId,
    activationId: base.activationId,
    routeName: name,
    host: typeof spec.name === "string" ? spec.name : undefined,
    targetComponentName: targetComponentName(spec.target),
    protocol: "https",
    source: stringValue(resource.provider, "resource.provider"),
  };
}

type RuntimeDesiredStateBase = Pick<
  RuntimeDesiredState,
  "id" | "spaceId" | "groupId" | "activationId" | "appName" | "materializedAt"
>;

function bindingEnv(resource: Record<string, unknown>): Record<string, string> {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const bindings = isRecord(spec.bindings) ? spec.bindings : {};
  return Object.fromEntries(
    Object.entries(bindings).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}

function targetComponentName(target: unknown): string {
  if (typeof target === "string") {
    const match = target.match(/^\$\{ref:([^.\}]+)(?:\.[^\}]+)?\}$/);
    return match?.[1] ?? target;
  }
  return "web";
}

function resourceDescriptor(resource: Record<string, unknown>): string {
  return [
    stringValue(resource.shape, "resource.shape"),
    stringValue(resource.provider, "resource.provider"),
    stringValue(resource.name, "resource.name"),
  ].join(":");
}

function isWorkloadShape(value: unknown): boolean {
  return typeof value === "string" &&
    (value.startsWith("web-service@") || value.startsWith("worker@"));
}

function isRouteShape(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("custom-domain@");
}

function specString(
  resource: Record<string, unknown>,
  key: string,
): string | undefined {
  const spec = isRecord(resource.spec) ? resource.spec : {};
  const value = spec[key];
  return typeof value === "string" ? value : undefined;
}

function isProvider(value: string): value is ProviderProofProvider {
  return value === "aws" || value === "gcp" || value === "k8s" ||
    value === "kubernetes" || value === "cloudflare" ||
    value === "selfhosted" || value === "azure";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function arrayOfRecords(
  value: unknown,
  label: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${label} must be an array of JSON objects`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}

if (import.meta.main) {
  Deno.exit(await main());
}
