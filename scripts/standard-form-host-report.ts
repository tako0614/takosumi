#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type {
  ActorContext,
  FormActivation,
  FormDefinition,
  FormOperation,
  FormPackage,
  InstalledFormReference,
  JsonObject,
  ResourceConnectionSpec,
  ResourceShapeKind,
  TargetImplementationDescriptor,
  TargetPoolSpec,
} from "takosumi-contract";
import {
  formRefKey,
  formRefOfInstalled,
  isInstalledFormReference,
  portableTypeForShapeKind,
  RESOURCE_SHAPE_KINDS,
} from "takosumi-contract";

import { createApiApp } from "../core/api/app.ts";
import { ActivityService } from "../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../core/domains/deploy-control/store.ts";
import {
  composeResourceShapeSchemaRegistries,
  createInMemoryResourceShapeStores,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  MapResourceShapeModuleRegistry,
  MapResourceShapeSchemaRegistry,
  ResourceShapeService,
  StubResourceShapeAdapter,
  type ResourceShapeSchemaParser,
} from "../core/domains/resource-shape/mod.ts";
import {
  runPortableFormHostConformance,
  type PortableFormHostNegativeFixture,
} from "../core/conformance/portable_form_host.ts";
import {
  canonicalJson,
  canonicalJsonBytes,
  parseCanonicalJson,
} from "../core/adapters/takoform/canonical_json.ts";
import { readExactPackageFixtureBindings } from "./lib/takoform-package-fixture-bindings.ts";
import {
  finalizeSignedHostReportCandidate,
  verifySignedHostReportCandidate,
  verifyUnsignedHostReportCandidate,
  writeUnsignedHostReportCandidate,
  type CurrentFormCandidate,
  type ExecutedCurrentFormHostReport,
} from "./lib/standard-form-host-report-candidate.ts";

const HOST_ORIGIN = "https://in-process.takosumi.test";
const HOST_SPACE = "space_host_report";
const HOST_TARGET_POOL = "default";
const CANDIDATE_PATH = "forms/admission-candidate-set.json";
const CANDIDATE_FORMAT = "takoform.admission-candidate-set@v1";
const CURRENT_GENERATION = "ga-core-v1";
const NOW = "2026-07-29T00:00:00.000Z";
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ACTOR: ActorContext = {
  actorAccountId: "acct_host_report",
  roles: ["owner"],
  scopes: ["admin"],
  requestId: "req_host_report",
};

interface CandidateDocument {
  readonly format: string;
  readonly generation: string;
  readonly packages: readonly CandidatePackage[];
}

interface CandidatePackage {
  readonly kind: string;
  readonly slug: string;
  readonly sourcePath: string;
  readonly formRef: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  };
  readonly packageDigest: string;
}

interface PackageDefinition {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly title?: string;
  readonly description?: string;
  readonly desiredSchema: JsonObject;
  readonly immutableFields?: readonly string[];
  readonly lifecycleCapabilities: readonly string[];
  readonly conformanceFixtures: readonly {
    readonly name: string;
    readonly desiredPath: string;
  }[];
  readonly negativeConformanceFixtures: readonly {
    readonly name: string;
    readonly stage: string;
    readonly inputPath: string;
    readonly expectedFailure: string;
  }[];
}

interface LoadedCandidate {
  readonly package: CandidatePackage;
  readonly candidate: CurrentFormCandidate;
  readonly definition: PackageDefinition;
  readonly packageRoot: string;
  readonly desired: JsonObject;
  readonly updatedDesired: JsonObject;
  readonly positiveName: string;
  readonly positivePackageDigest: string;
  readonly negativeFixtures: readonly PortableFormHostNegativeFixture[];
  readonly negativePackageDigests: Readonly<Record<string, string>>;
  readonly schemaParser: ResourceShapeSchemaParser;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(
      `standard-form-host-report: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  });
  process.exit(exitCode);
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  const sourceCommit = required(options, "source-commit");
  const takoformSourceCommit = required(options, "takoform-source-commit");
  const outputRoot = required(options, "output-dir");
  if (command === "build") {
    const takoformRoot = required(options, "takoform-root");
    assertOnlyOptions(options, [
      "output-dir",
      "source-commit",
      "takoform-root",
      "takoform-source-commit",
    ]);
    await assertExactCleanCheckout(resolve("."), sourceCommit, "Takosumi");
    await assertExactCleanCheckout(
      resolve(takoformRoot),
      takoformSourceCommit,
      "Takoform",
    );
    const candidates = await loadCurrentCandidates(resolve(takoformRoot));
    const reports = await executeCurrentHostReports(candidates);
    await writeUnsignedHostReportCandidate({
      outputRoot,
      sourceCommit,
      takoformSourceCommit,
      reports,
    });
    console.log(`host-report candidate: wrote 10 reports to ${outputRoot}`);
    return 0;
  }
  if (command === "verify-unsigned") {
    assertOnlyOptions(options, [
      "output-dir",
      "source-commit",
      "takoform-source-commit",
    ]);
    await verifyUnsignedHostReportCandidate(outputRoot, {
      sourceCommit,
      takoformSourceCommit,
    });
    console.log("host-report candidate: unsigned closure verified");
    return 0;
  }
  const workflowRunId = required(options, "workflow-run-id");
  const workflowRunAttempt = Number(required(options, "workflow-run-attempt"));
  assertOnlyOptions(options, [
    "output-dir",
    "source-commit",
    "takoform-source-commit",
    "workflow-run-attempt",
    "workflow-run-id",
  ]);
  if (command === "finalize") {
    await finalizeSignedHostReportCandidate({
      outputRoot,
      sourceCommit,
      takoformSourceCommit,
      workflowRunId,
      workflowRunAttempt,
    });
    console.log("host-report candidate: signed closure finalized");
    return 0;
  }
  if (command === "verify-signed") {
    await verifySignedHostReportCandidate(outputRoot, {
      sourceCommit,
      takoformSourceCommit,
      workflowRunId,
      workflowRunAttempt,
    });
    console.log("host-report candidate: signed closure verified");
    return 0;
  }
  throw new TypeError(usage());
}

export async function loadCurrentCandidates(
  takoformRoot: string,
): Promise<readonly LoadedCandidate[]> {
  const document = await readJson<CandidateDocument>(
    safePath(takoformRoot, CANDIDATE_PATH),
  );
  if (
    document.format !== CANDIDATE_FORMAT ||
    document.generation !== CURRENT_GENERATION ||
    document.packages.length !== 10
  ) {
    throw new TypeError(
      "Takoform current admission candidate must be ga-core-v1 exact10",
    );
  }
  const seen = new Set<string>();
  const loaded: LoadedCandidate[] = [];
  for (const entry of document.packages) {
    validateCandidateEntry(entry, seen);
    const packageRoot = safePath(takoformRoot, entry.sourcePath);
    const definition = await readJson<PackageDefinition>(
      safePath(packageRoot, "definition.json"),
    );
    const packageIndexBytes = await readRegularFile(
      safePath(packageRoot, "package-index.json"),
    );
    const packageIndex = JSON.parse(
      new TextDecoder().decode(packageIndexBytes),
    ) as { readonly formRef?: unknown };
    if (
      digest(canonicalJsonBytes(parseCanonicalJson(packageIndexBytes))) !==
        entry.packageDigest ||
      canonicalJson(packageIndex.formRef as never) !==
        canonicalJson(entry.formRef as never) ||
      definition.apiVersion !== entry.formRef.apiVersion ||
      definition.kind !== entry.kind ||
      definition.definitionVersion !== entry.formRef.definitionVersion ||
      digest(new TextEncoder().encode(canonicalJson(definition as never))) !==
        entry.formRef.schemaDigest
    ) {
      throw new TypeError(`${entry.kind} candidate package identity drifted`);
    }
    if (definition.conformanceFixtures.length !== 1) {
      throw new TypeError(
        `${entry.kind} current host producer requires one positive lifecycle fixture`,
      );
    }
    const positive = definition.conformanceFixtures[0]!;
    const desired = await readJson<JsonObject>(
      safePath(packageRoot, positive.desiredPath),
    );
    const negativeFixtures = await Promise.all(
      definition.negativeConformanceFixtures.map(async (fixture) => {
        if (
          fixture.stage !== "desired" ||
          fixture.expectedFailure !== "schema_validation_failed"
        ) {
          throw new TypeError(
            `${entry.kind} has unsupported negative fixture ${fixture.name}`,
          );
        }
        return {
          name: fixture.name,
          stage: "desired" as const,
          input: await readJson<JsonObject>(
            safePath(packageRoot, fixture.inputPath),
          ),
          expectedErrorCode: "invalid_argument",
        };
      }),
    );
    const identity = internalIdentity(entry);
    const bindings = await readExactPackageFixtureBindings({
      root: packageRoot,
      identity,
      positiveFixtureName: positive.name,
      desired,
      negativeFixtures,
    });
    const schemaParser = compileSchemaParser(
      entry.kind,
      definition.desiredSchema,
    );
    const updatedDesired = mutableDesired(
      entry.kind,
      desired,
      definition.immutableFields ?? [],
      schemaParser,
    );
    loaded.push({
      package: entry,
      candidate: { kind: entry.kind, slug: entry.slug, identity },
      definition,
      packageRoot,
      desired,
      updatedDesired,
      positiveName: positive.name,
      positivePackageDigest: bindings.positive,
      negativeFixtures,
      negativePackageDigests: bindings.negative,
      schemaParser,
    });
  }
  return loaded;
}

export async function executeCurrentHostReports(
  candidates: readonly LoadedCandidate[],
): Promise<readonly ExecutedCurrentFormHostReport[]> {
  const { app, service } = await createInProcessHost(candidates);
  await seedConnectionDependency(service, "ObjectBucket", "object-bucket", {
    name: "object-bucket",
    storageClass: "standard",
  });
  await seedConnectionDependency(service, "Workflow", "workflow", {
    name: "workflow",
  });
  const reports: ExecutedCurrentFormHostReport[] = [];
  for (const item of candidates) {
    let execution;
    try {
      execution = await runPortableFormHostConformance({
        endpoint: HOST_ORIGIN,
        space: HOST_SPACE,
        name: `host-report-${item.package.slug}`,
        identity: item.candidate.identity,
        desired: item.desired,
        updatedDesired: item.updatedDesired,
        positiveFixtureName: item.positiveName,
        negativeFixtures: item.negativeFixtures,
        importNativeId: `provider-native-${item.package.slug}`,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          app.request(input.toString(), init)) as typeof fetch,
      });
    } catch (error) {
      throw new TypeError(
        `${item.package.kind} host lifecycle failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    reports.push({
      candidate: item.candidate,
      execution,
      positive: [
        {
          name: item.positiveName,
          packageFixtureDigest: item.positivePackageDigest,
        },
      ],
      negative: item.negativeFixtures.map((fixture) => ({
        name: fixture.name,
        packageFixtureDigest: item.negativePackageDigests[fixture.name]!,
      })),
    });
  }
  return reports;
}

export async function createInProcessHost(
  candidates: readonly LoadedCandidate[],
) {
  const kinds = [
    ...new Set<ResourceShapeKind>([
      ...candidates.map(({ package: entry }) => entry.kind),
      "Workflow",
      "ObjectBucket",
    ]),
  ];
  const customSchemas = Object.fromEntries(
    candidates
      .filter(
        ({ package: entry }) =>
          !(RESOURCE_SHAPE_KINDS as readonly string[]).includes(entry.kind),
      )
      .map((entry) => [entry.package.kind, entry.schemaParser]),
  );
  customSchemas.Workflow = passthroughSchemaParser;
  const schemaRegistry = composeResourceShapeSchemaRegistries(
    LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    new MapResourceShapeSchemaRegistry(customSchemas),
  );
  const modules = new MapResourceShapeModuleRegistry({
    "in-process-host-conformance": {
      files: [{ path: "main.tf", text: "terraform {}\n" }],
    },
  });
  const stores = createInMemoryResourceShapeStores();
  const activityStore = new InMemoryOpenTofuControlStore();
  const activity = new ActivityService({
    store: activityStore,
    now: () => new Date(NOW),
  });
  const formRegistry = currentFormRegistry(candidates);
  const formDesiredParsers = new Map(
    candidates.map((item) => [
      formRefKey(formRefOfInstalled(item.candidate.identity)),
      item.schemaParser,
    ]),
  );
  const service = new ResourceShapeService({
    stores,
    adapter: new StubResourceShapeAdapter(),
    activity,
    operationRuns: activityStore,
    moduleRegistry: modules,
    schemaRegistry,
    formRegistry,
    formDesiredStateAdmission: async ({ request, definition }) => {
      const parser = formDesiredParsers.get(
        formRefKey(formRefOfInstalled(definition.identity)),
      );
      if (!parser) return "exact Form desired-state parser is unavailable";
      return parser(request.spec).ok
        ? undefined
        : "desired state failed the exact installed Form schema";
    },
    now: () => NOW,
  });
  const pool: TargetPoolSpec = {
    classes: ["host.conformance"],
    targets: [
      {
        name: "in-process-reference",
        type: "in-process",
        ref: "host-report",
        priority: 1,
        implementations: kinds.map(genericImplementation),
      },
    ],
  };
  const putPool = await service.putTargetPool(
    HOST_SPACE,
    HOST_TARGET_POOL,
    pool,
  );
  if (!putPool.ok) {
    throw new TypeError(
      `cannot seed host target pool: ${putPool.error.message}`,
    );
  }
  await service.putSpacePolicy(HOST_SPACE, HOST_TARGET_POOL, {
    resolution: { lockAfterCreate: true, allowAutoMigration: false },
  });
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    requestCorrelation: false,
    resourceShapeRouteOptions: {
      service,
      enabledResourceShapeKinds: kinds,
      installedResourceShapeKinds: kinds,
    },
  });
  return { app, service };
}

function currentFormRegistry(candidates: readonly LoadedCandidate[]) {
  const definitions = candidates.map<FormDefinition>((item) => ({
    identity: item.candidate.identity,
    displayName: item.definition.title ?? item.package.kind,
    ...(item.definition.description
      ? { description: item.definition.description }
      : {}),
    operations: item.definition.lifecycleCapabilities as FormOperation[],
    installedAt: NOW,
  }));
  const packages = candidates.map<FormPackage>((item) => ({
    packageDigest: item.candidate.identity.packageDigest,
    artifactRef: `retained:takoform/${item.package.slug}/${item.candidate.identity.version}`,
    verifierId: "takoform-current-source-conformance",
    status: "installed",
    definitionRefs: [formRefOfInstalled(item.candidate.identity)],
    installedAt: NOW,
    installedBy: "host-report",
    updatedAt: NOW,
  }));
  const activations = candidates.map<FormActivation>((item, index) => ({
    id: `activation_host_report_${index + 1}`,
    identity: item.candidate.identity,
    scope: { type: "space", id: HOST_SPACE },
    audience: { roles: ["owner"] },
    policy: { evidence: "source-conformance-only" },
    eligibleTargetPoolClasses: ["host.conformance"],
    status: "active",
    revision: 1,
    createdAt: NOW,
    createdBy: "host-report",
    updatedAt: NOW,
    updatedBy: "host-report",
  }));
  const definitionsByRef = new Map(
    definitions.map((definition) => [
      formRefKey(formRefOfInstalled(definition.identity)),
      definition,
    ]),
  );
  const packagesByDigest = new Map(
    packages.map((entry) => [entry.packageDigest, entry]),
  );
  return {
    getDefinition: async (ref: Parameters<typeof formRefKey>[0]) =>
      definitionsByRef.get(formRefKey(ref)),
    getPackage: async (packageDigest: string) =>
      packagesByDigest.get(packageDigest),
    listDefinitions: async () => ({ items: definitions }),
    listActivations: async () => ({ items: activations }),
  };
}

async function seedConnectionDependency(
  service: ResourceShapeService,
  kind: string,
  name: string,
  spec: JsonObject,
): Promise<void> {
  const request = { actor: ACTOR, space: HOST_SPACE, kind, name, spec };
  const preview = await service.preview(request);
  if (!preview.ok) {
    throw new TypeError(
      `cannot preview host dependency ${kind}/${name}: ${preview.error.message}`,
    );
  }
  const applied = await service.apply(request, {
    planDigest: preview.value.planDigest,
  });
  if (!applied.ok) {
    throw new TypeError(
      `cannot apply host dependency ${kind}/${name}: ${applied.error.message}`,
    );
  }
}

function genericImplementation(
  kind: ResourceShapeKind,
): TargetImplementationDescriptor {
  const interfaces = Object.fromEntries(
    [
      "object_store",
      "s3_api",
      "storage_class_infrequent_access",
      "oci_container",
      "public_http",
      "env_projection",
      "queue",
      "publish",
      "consume",
      "vector_index",
      "vector_query",
      "runtime_binding",
      "cosine",
      "dot_product",
      "schedule",
      "cron",
      "invoke",
      "resource_connection",
      "object.binding.v1",
      "schedule.trigger.v1",
      "grant_read",
      "grant_invoke",
    ].map((name) => [name, "native"] as const),
  );
  return {
    shape: kind,
    implementation: "in_process_reference",
    nativeResourceType: `in_process.${kind}`,
    providerSource: "registry.terraform.io/hashicorp/null",
    moduleTemplate: "in-process-host-conformance",
    moduleImportAddress: "null_resource.this",
    moduleInputMappings: {},
    moduleOutputs: [],
    interfaces,
  };
}

function compileSchemaParser(
  kind: string,
  schema: JsonObject,
): ResourceShapeSchemaParser {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  const validate = ajv.compile(structuredClone(schema) as object);
  return (spec) => validateRegisteredSpec(kind, validate, spec);
}

function validateRegisteredSpec(
  kind: string,
  validate: ValidateFunction,
  spec: unknown,
) {
  if (!validate(spec)) {
    return {
      ok: false as const,
      error: {
        code: "invalid_argument",
        message: `${kind} desired state failed its exact Form schema`,
      },
    };
  }
  const value = structuredClone(spec) as JsonObject;
  return {
    ok: true as const,
    value: {
      spec: value,
      interfaces: [],
      ...(isRecord(value.connections)
        ? {
            connections: value.connections as Readonly<
              Record<string, ResourceConnectionSpec>
            >,
          }
        : {}),
    },
  };
}

function passthroughSchemaParser(spec: unknown) {
  if (!isRecord(spec)) {
    return {
      ok: false as const,
      error: { code: "invalid_argument", message: "spec must be an object" },
    };
  }
  return {
    ok: true as const,
    value: { spec: spec as JsonObject, interfaces: [] },
  };
}

function mutableDesired(
  kind: string,
  desired: JsonObject,
  immutableFields: readonly string[],
  parser: ResourceShapeSchemaParser,
): JsonObject {
  const result = structuredClone(desired);
  const mutations: Readonly<Record<string, () => void>> = {
    HttpService: () => {
      result.configuration = {
        ...(isRecord(result.configuration) ? result.configuration : {}),
        LOG_LEVEL: "debug",
      };
    },
    ContainerService: () => {
      result.replicas = Number(result.replicas ?? 1) + 1;
    },
    StatefulEntity: () => {
      result.migrationTag = "v2";
    },
    Schedule: () => {
      result.cron = "0 1 * * *";
    },
    ObjectBucket: () => {
      result.storageClass = "infrequent_access";
    },
    KeyValueStore: () => {
      result.consistency = "strong";
    },
    RelationalDatabase: () => {
      result.engineVersion = "17";
    },
    Queue: () => {
      result.maxRetries = Number(result.maxRetries ?? 0) + 1;
    },
    VectorIndex: () => {
      result.metric = "dot_product";
    },
    ModelEndpoint: () => {
      result.model = "portable-conformance/v1/embedding-large";
    },
  };
  const mutate = mutations[kind];
  if (!mutate) throw new TypeError(`${kind} lacks an update fixture mutation`);
  mutate();
  if (canonicalJson(result as never) === canonicalJson(desired as never)) {
    throw new TypeError(`${kind} update fixture did not change desired state`);
  }
  for (const pointer of immutableFields) {
    if (
      canonicalJson(pointerValue(result, pointer) as never) !==
      canonicalJson(pointerValue(desired, pointer) as never)
    ) {
      throw new TypeError(`${kind} update changed immutable field ${pointer}`);
    }
  }
  if (!parser(result).ok) {
    throw new TypeError(`${kind} update fixture is not schema valid`);
  }
  return result;
}

function internalIdentity(entry: CandidatePackage): InstalledFormReference {
  const type = portableTypeForShapeKind(entry.kind);
  const identity = {
    type,
    version: entry.formRef.definitionVersion,
    schemaDigest: entry.formRef.schemaDigest,
    packageDigest: entry.packageDigest,
  };
  if (!type || !isInstalledFormReference(identity)) {
    throw new TypeError(`${entry.kind} cannot map to an exact host FormRef`);
  }
  return identity;
}

function validateCandidateEntry(
  entry: CandidatePackage,
  seen: Set<string>,
): void {
  if (
    !/^[A-Z][A-Za-z0-9]{0,127}$/u.test(entry.kind) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.slug) ||
    entry.formRef.apiVersion !== "forms.takoform.com/v1alpha1" ||
    entry.formRef.kind !== entry.kind ||
    !DIGEST_PATTERN.test(entry.formRef.schemaDigest) ||
    !DIGEST_PATTERN.test(entry.packageDigest) ||
    seen.has(entry.kind)
  ) {
    throw new TypeError("current Takoform candidate entry is invalid");
  }
  seen.add(entry.kind);
}

async function assertExactCleanCheckout(
  root: string,
  expectedCommit: string,
  label: string,
): Promise<void> {
  if (!SOURCE_COMMIT_PATTERN.test(expectedCommit)) {
    throw new TypeError(`${label} source commit must be lowercase 40-hex`);
  }
  const head = await Bun.$`git -C ${root} rev-parse HEAD`.quiet().text();
  if (head.trim() !== expectedCommit) {
    throw new TypeError(`${label} checkout is not the declared source commit`);
  }
  const status =
    await Bun.$`git -C ${root} status --porcelain=v1 --untracked-files=all`
      .quiet()
      .text();
  if (status.trim() !== "") {
    throw new TypeError(`${label} checkout must be clean`);
  }
}

function parseOptions(values: readonly string[]): Record<string, string> {
  if (values.length % 2 !== 0) throw new TypeError(usage());
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const raw = values[index];
    const value = values[index + 1];
    if (
      !raw?.startsWith("--") ||
      !value ||
      result[raw.slice(2)] !== undefined
    ) {
      throw new TypeError(usage());
    }
    result[raw.slice(2)] = value;
  }
  return result;
}

function required(
  values: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = values[name];
  if (!value) throw new TypeError(`--${name} is required\n${usage()}`);
  return value;
}

function assertOnlyOptions(
  values: Readonly<Record<string, string>>,
  allowed: readonly string[],
): void {
  for (const name of Object.keys(values)) {
    if (!allowed.includes(name)) {
      throw new TypeError(`unknown option --${name}\n${usage()}`);
    }
  }
}

function usage(): string {
  return [
    "usage:",
    "  build --takoform-root DIR --output-dir DIR --source-commit SHA --takoform-source-commit SHA",
    "  verify-unsigned --output-dir DIR --source-commit SHA --takoform-source-commit SHA",
    "  finalize --output-dir DIR --source-commit SHA --takoform-source-commit SHA --workflow-run-id ID --workflow-run-attempt 1",
    "  verify-signed --output-dir DIR --source-commit SHA --takoform-source-commit SHA --workflow-run-id ID --workflow-run-attempt 1",
  ].join("\n");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await readRegularFile(path))) as T;
}

async function readRegularFile(path: string): Promise<Uint8Array> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 << 20) {
    throw new TypeError(`not a bounded regular file: ${path}`);
  }
  return new Uint8Array(await readFile(path));
}

function safePath(root: string, path: string): string {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new TypeError(`unsafe candidate path: ${path}`);
  }
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, path);
  const fromRoot = relative(absoluteRoot, absolute);
  if (fromRoot === ".." || fromRoot.startsWith("../")) {
    throw new TypeError(`candidate path escapes root: ${path}`);
  }
  return absolute;
}

function pointerValue(value: JsonObject, pointer: string): unknown {
  let current: unknown = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
