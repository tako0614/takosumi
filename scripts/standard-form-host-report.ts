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
  FormInterfaceDescriptor,
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
  isResourceShapeKind,
  portableTypeForShapeKind,
} from "takosumi-contract";

import { createApiApp } from "../core/api/app.ts";
import {
  InMemoryPortableHostIdempotencyLedger,
  PortableHostIdempotencyCoordinator,
} from "../core/api/portable_host_idempotency.ts";
import { ActivityService } from "../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../core/domains/deploy-control/store.ts";
import {
  createInMemoryResourceShapeStores,
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  MapResourceShapeModuleRegistry,
  ResourceShapeService,
  StubResourceShapeAdapter,
  type ApplyResourceRequest,
  type AdapterApplyInput,
  type AdapterApplyResult,
  formatResourceShapeId,
  type ResourceShapeSchemaParser,
} from "../core/domains/resource-shape/mod.ts";
import {
  createInMemoryInterfaceStores,
  createPortableDeclarationReader,
  ensureFormDescriptorInterfaces,
  InterfaceService,
  OutputBackedInterfaceInputResolver,
} from "../core/domains/interfaces/mod.ts";
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
  createTakoformPortableHostEvidenceAdapter,
  executeExactTakoformPortableHostRunner,
  TAKOFORM_RUNNER_ALTERNATE_TENANT_TOKEN,
  TAKOFORM_RUNNER_ALTERNATE_TOKEN,
  TAKOFORM_RUNNER_PRIMARY_TOKEN,
  type TakoformPortableHostAuthority,
} from "./lib/takoform-portable-host-evidence.ts";
import {
  CURRENT_HOST_GENERATION,
  finalizeSignedHostReportCandidate,
  verifySignedHostReportCandidate,
  verifyUnsignedHostReportCandidate,
  writeUnsignedHostReportCandidate,
  type CurrentFormCandidate,
  type ExecutedCurrentFormHostReport,
} from "./lib/standard-form-host-report-candidate.ts";

const HOST_ORIGIN = "https://in-process.takosumi.test";
const HOST_SPACE = "space_host_report";
const RUNNER_SPACE = "conformance-space";
const RUNNER_ALTERNATE_SPACE = "conformance-space-alternate";
const HOST_SPACES = [
  HOST_SPACE,
  RUNNER_SPACE,
  RUNNER_ALTERNATE_SPACE,
] as const;
const HOST_EVIDENCE_PRIMARY_WORKSPACE =
  "workspace_host_evidence_primary";
const HOST_TARGET_POOL = "default";
const CANDIDATE_PATH = "forms/admission-candidate-set.json";
const CANDIDATE_FORMAT = "takoform.admission-candidate-set@v1";
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
  readonly interfaces?: readonly FormInterfaceDescriptor[];
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
  readonly takoformRoot: string;
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
  const requestId = required(options, "request-id");
  if (command === "build") {
    const takoformRoot = required(options, "takoform-root");
    assertOnlyOptions(options, [
      "output-dir",
      "request-id",
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
    const host = await createInProcessHost(candidates);
    const reports = await executeCurrentHostReports(candidates, host);
    const portableRunnerReport = await executeExactTakoformPortableHostRunner({
      takoformRoot: resolve(takoformRoot),
      fetch: host.portableRunnerFetch,
    });
    await writeUnsignedHostReportCandidate({
      outputRoot,
      sourceCommit,
      takoformSourceCommit,
      requestId,
      reports,
      portableRunnerReport,
    });
    console.log(
      `host-report candidate: wrote 10 Form reports and exact portable runner evidence to ${outputRoot}`,
    );
    return 0;
  }
  if (command === "verify-unsigned") {
    assertOnlyOptions(options, [
      "output-dir",
      "request-id",
      "source-commit",
      "takoform-source-commit",
    ]);
    await verifyUnsignedHostReportCandidate(outputRoot, {
      sourceCommit,
      takoformSourceCommit,
      requestId,
    });
    console.log("host-report candidate: unsigned closure verified");
    return 0;
  }
  const workflowRunId = required(options, "workflow-run-id");
  const workflowRunAttempt = Number(required(options, "workflow-run-attempt"));
  assertOnlyOptions(options, [
    "output-dir",
    "request-id",
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
      requestId,
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
      requestId,
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
    document.generation !== CURRENT_HOST_GENERATION ||
    document.packages.length !== 10
  ) {
    throw new TypeError(
      "Takoform current admission candidate must be ga-core-v2 exact10",
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
    const desiredNegativeFixtures =
      definition.negativeConformanceFixtures.filter((fixture) => {
        if (
          (fixture.stage !== "desired" && fixture.stage !== "observed") ||
          fixture.expectedFailure !== "schema_validation_failed"
        ) {
          throw new TypeError(
            `${entry.kind} has unsupported negative fixture ${fixture.name}`,
          );
        }
        return fixture.stage === "desired";
      });
    const negativeFixtures = await Promise.all(
      desiredNegativeFixtures.map(async (fixture) => {
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
    const updatedDesired = buildCurrentHostReportUpdateFixture(
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
      takoformRoot,
    });
  }
  return loaded;
}

export async function executeCurrentHostReports(
  candidates: readonly LoadedCandidate[],
  existingHost?: Awaited<ReturnType<typeof createInProcessHost>>,
): Promise<readonly ExecutedCurrentFormHostReport[]> {
  const { app, service } =
    existingHost ?? (await createInProcessHost(candidates));
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
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set(
            "authorization",
            `Bearer ${TAKOFORM_RUNNER_PRIMARY_TOKEN}`,
          );
          return app.request(input.toString(), { ...init, headers });
        }) as typeof fetch,
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

async function loadPortableRunnerFormDependencies(
  candidates: readonly LoadedCandidate[],
): Promise<readonly LoadedCandidate[]> {
  if (!candidates[0]?.takoformRoot) return [];
  const roots = new Set(candidates.map((candidate) => candidate.takoformRoot));
  if (roots.size !== 1) {
    throw new TypeError("host evidence candidates must share one Takoform root");
  }
  const takoformRoot = [...roots][0]!;
  const contract = await readJson<{
    readonly runnerInput: {
      readonly connectionProbe: {
        readonly sourceIdentity: {
          readonly formRef: CandidatePackage["formRef"];
          readonly packageDigest: string;
        };
        readonly desired: JsonObject;
      };
    };
  }>(safePath(takoformRoot, "conformance/portable-host-v1/contract.json"));
  const sourceIdentity = contract.runnerInput.connectionProbe.sourceIdentity;
  const existing = candidates.find(
    (candidate) => candidate.package.kind === sourceIdentity.formRef.kind,
  );
  if (existing) {
    if (
      canonicalJson(existing.package.formRef as never) !==
        canonicalJson(sourceIdentity.formRef as never) ||
      existing.package.packageDigest !== sourceIdentity.packageDigest
    ) {
      throw new TypeError(
        "portable runner dependency conflicts with the admission candidate",
      );
    }
    return [];
  }
  const releasePlan = await readJson<{
    readonly releases: readonly CandidatePackage[];
  }>(safePath(takoformRoot, "forms/release-plan.json"));
  const entry = releasePlan.releases.find(
    (candidate) =>
      candidate.kind === sourceIdentity.formRef.kind &&
      canonicalJson(candidate.formRef as never) ===
        canonicalJson(sourceIdentity.formRef as never) &&
      candidate.packageDigest === sourceIdentity.packageDigest,
  );
  if (!entry) {
    throw new TypeError(
      "portable runner dependency is absent from the exact Form release plan",
    );
  }
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
    throw new TypeError("portable runner dependency identity drifted");
  }
  const schemaParser = compileSchemaParser(
    entry.kind,
    definition.desiredSchema,
  );
  return [
    {
      package: entry,
      candidate: {
        kind: entry.kind,
        slug: entry.slug,
        identity: internalIdentity(entry),
      },
      definition,
      packageRoot,
      desired: contract.runnerInput.connectionProbe.desired,
      updatedDesired: contract.runnerInput.connectionProbe.desired,
      positiveName: "runner-only",
      positivePackageDigest: `sha256:${"0".repeat(64)}`,
      negativeFixtures: [],
      negativePackageDigests: {},
      schemaParser,
      takoformRoot,
    },
  ];
}

export async function createInProcessHost(
  candidates: readonly LoadedCandidate[],
) {
  const runnerDependencies =
    await loadPortableRunnerFormDependencies(candidates);
  const hostCandidates = [...candidates, ...runnerDependencies];
  const kinds = [
    ...new Set<ResourceShapeKind>([
      ...hostCandidates.map(({ package: entry }) => entry.kind),
      "Workflow",
      "ObjectBucket",
    ]),
  ];
  const currentFormSchemas = new Map<
    ResourceShapeKind,
    ResourceShapeSchemaParser
  >(
    hostCandidates.map(
      (entry) => [entry.package.kind, entry.schemaParser] as const,
    ),
  );
  currentFormSchemas.set("Workflow", passthroughSchemaParser);
  const schemaRegistry = {
    get: (kind: ResourceShapeKind) =>
      currentFormSchemas.get(kind) ??
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY.get(kind),
    kinds: () => [
      ...new Set<ResourceShapeKind>([
        ...LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY.kinds(),
        ...currentFormSchemas.keys(),
      ]),
    ],
  };
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
  const formRegistry = currentFormRegistry(hostCandidates);
  const formDesiredParsers = new Map(
    hostCandidates.map((item) => [
      formRefKey(formRefOfInstalled(item.candidate.identity)),
      item.schemaParser,
    ]),
  );
  const interfaceStores = createInMemoryInterfaceStores();
  let interfaceSequence = 0;
  const interfaces = new InterfaceService({
    stores: interfaceStores,
    resolver: new OutputBackedInterfaceInputResolver({
      opentofu: activityStore,
      resources: stores.resources,
      resolveResourceWorkspace: async ({ resourceSpaceId }) =>
        hostEvidenceWorkspace(resourceSpaceId),
    }),
    now: () => NOW,
    newId: (prefix) => `${prefix}_host_evidence_${++interfaceSequence}`,
  });
  const service = new ResourceShapeService({
    stores,
    adapter: new PortableHostEvidenceResourceAdapter(),
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
  const materializeInterfaces = async (resourceId: string): Promise<void> => {
    const resource = await stores.resources.get(resourceId);
    if (
      !resource?.form ||
      resource.phase !== "Ready" ||
      resource.observedGeneration !== resource.generation
    ) {
      return;
    }
    const definition = await formRegistry.getDefinition(
      formRefOfInstalled(resource.form),
    );
    if (!definition) return;
    await ensureFormDescriptorInterfaces({
      interfaces,
      workspaceId: hostEvidenceWorkspace(resource.spaceId),
      resourceId,
      form: resource.form,
      descriptors: definition.interfaceDescriptors ?? [],
    });
  };
  service.setLifecycleObserver({
    async observe(event) {
      switch (event.type) {
        case "ready":
          await materializeInterfaces(event.resourceId);
          await interfaces.reconcileResource(
            hostEvidenceWorkspace(event.spaceId),
            event.resourceId,
          );
          return;
        case "unknown":
          await interfaces.markResourceUnknown(
            hostEvidenceWorkspace(event.spaceId),
            event.resourceId,
            `Resource ${event.operation} failed after backend dispatch`,
          );
          return;
        case "terminating":
          await interfaces.markResourceTerminating(
            hostEvidenceWorkspace(event.spaceId),
            event.resourceId,
          );
          return;
        case "retired":
          await interfaces.retireResource(
            hostEvidenceWorkspace(event.spaceId),
            event.resourceId,
          );
      }
    },
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
  for (const space of HOST_SPACES) {
    const putPool = await service.putTargetPool(
      space,
      HOST_TARGET_POOL,
      pool,
    );
    if (!putPool.ok) {
      throw new TypeError(
        `cannot seed host target pool for ${space}: ${putPool.error.message}`,
      );
    }
    await service.putSpacePolicy(space, HOST_TARGET_POOL, {
      resolution: { lockAfterCreate: true, allowAutoMigration: false },
    });
  }
  const interfaceDeclarations = createPortableDeclarationReader({
    interfaces,
    listResources: (space, page) => service.listPage(space, page),
    getResource: async (space, kind, name) => {
      const result = await service.get(space, kind, name);
      return result.ok ? result.value : undefined;
    },
    resolveWorkspace: async ({ resourceSpaceId }) =>
      hostEvidenceWorkspace(resourceSpaceId),
    ensureResourceDeclarations: async (resource) => {
      await materializeInterfaces(
        formatResourceShapeId(
          resource.metadata.space,
          resource.kind,
          resource.metadata.name,
        ),
      );
    },
  });
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    requestCorrelation: false,
    resourceShapeRouteOptions: {
      service,
      portableHostIdempotency: new PortableHostIdempotencyCoordinator(
        new InMemoryPortableHostIdempotencyLedger(),
      ),
      enabledResourceShapeKinds: kinds,
      installedResourceShapeKinds: kinds,
      interfaceDeclarations,
      authorizeResourceShapeBearer: async ({ token }) =>
        hostEvidenceActor(token),
    },
  });
  const portableRunnerFetch = createTakoformPortableHostEvidenceAdapter({
    fetch: (request) => app.request(request),
    authorizeBearer: async ({ token }) => hostEvidenceAuthority(token),
    readResource: async (space, kind, name) => {
      const result = await service.get(space, kind, name);
      return result.ok ? result.value : undefined;
    },
    validatePlanBinding: async ({
      authorization,
      resource,
      planDigest,
    }) => {
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : "";
      const actor = hostEvidenceActor(token);
      if (!actor) return false;
      const request = portablePlanBindingRequest(actor, resource);
      if (!request) return false;
      const validated = await service.validateDeploymentReview(request, {
        planDigest,
      });
      return validated.ok;
    },
  });
  return { app, service, portableRunnerFetch };
}

function currentFormRegistry(candidates: readonly LoadedCandidate[]) {
  const definitions = candidates.map<FormDefinition>((item) => ({
    identity: item.candidate.identity,
    displayName: item.definition.title ?? item.package.kind,
    ...(item.definition.description
      ? { description: item.definition.description }
      : {}),
    operations: item.definition.lifecycleCapabilities as FormOperation[],
    ...(item.definition.interfaces
      ? { interfaceDescriptors: item.definition.interfaces }
      : {}),
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
  const activations = HOST_SPACES.flatMap((space, spaceIndex) =>
    candidates.map<FormActivation>((item, index) => ({
      id: `activation_host_report_${spaceIndex + 1}_${index + 1}`,
      identity: item.candidate.identity,
      scope: { type: "space", id: space },
      audience: { roles: ["owner"] },
      policy: { evidence: "source-conformance-only" },
      eligibleTargetPoolClasses: ["host.conformance"],
      status: "active",
      revision: 1,
      createdAt: NOW,
      createdBy: "host-report",
      updatedAt: NOW,
      updatedBy: "host-report",
    })),
  );
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

class PortableHostEvidenceResourceAdapter extends StubResourceShapeAdapter {
  override apply(input: AdapterApplyInput): Promise<AdapterApplyResult> {
    const name = input.plan.validatedSpec.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(
        `${input.plan.shape} portable host evidence requires spec.name`,
      );
    }
    return Promise.resolve({
      nativeResources: input.nativeResources ?? [],
      outputs: {
        ...(input.plan.shape === "RelationalDatabase" &&
        typeof input.plan.validatedSpec.engine === "string"
          ? { engine: input.plan.validatedSpec.engine }
          : {}),
        generation: input.resourceGeneration,
        id: `${input.plan.shape}/${name}`,
        kind: input.plan.shape,
        name,
        portability: "portable",
      },
    });
  }
}

function hostEvidenceActor(token: string): ActorContext | undefined {
  const authority = hostEvidenceAuthority(token);
  if (!authority) return undefined;
  return {
    actorAccountId: `acct_host_evidence_${authority.principal}`,
    workspaceId: `workspace_host_evidence_${authority.tenant}`,
    roles: ["owner"],
    scopes: ["admin", "forms:read", "resources:*"],
    requestId:
      `req_host_evidence_${authority.tenant}_${authority.principal}`,
  };
}

function hostEvidenceAuthority(
  token: string,
): TakoformPortableHostAuthority | undefined {
  if (token === TAKOFORM_RUNNER_PRIMARY_TOKEN) {
    return { tenant: "primary", principal: "primary" };
  }
  if (token === TAKOFORM_RUNNER_ALTERNATE_TOKEN) {
    return { tenant: "primary", principal: "alternate" };
  }
  if (token === TAKOFORM_RUNNER_ALTERNATE_TENANT_TOKEN) {
    return { tenant: "alternate", principal: "primary" };
  }
  return undefined;
}

function portablePlanBindingRequest(
  actor: ActorContext,
  resource: JsonObject,
): ApplyResourceRequest | undefined {
  const metadata = jsonRecord(resource.metadata);
  const form = jsonRecord(resource.form);
  const formRef = jsonRecord(form?.formRef);
  const spec = jsonRecord(resource.spec);
  const kind = resource.kind;
  if (
    resource.apiVersion !== "forms.takoform.com/v1alpha1" ||
    typeof kind !== "string" ||
    !isResourceShapeKind(kind) ||
    !metadata ||
    typeof metadata.name !== "string" ||
    typeof metadata.space !== "string" ||
    !form ||
    !formRef ||
    formRef.apiVersion !== "forms.takoform.com/v1alpha1" ||
    formRef.kind !== kind ||
    typeof formRef.definitionVersion !== "string" ||
    typeof formRef.schemaDigest !== "string" ||
    typeof form.packageDigest !== "string" ||
    !spec
  ) {
    return undefined;
  }
  const resourceVersion = metadata.resourceVersion;
  if (
    resourceVersion !== undefined &&
    (typeof resourceVersion !== "string" ||
      !/^[1-9][0-9]*$/u.test(resourceVersion))
  ) {
    return undefined;
  }
  return {
    actor,
    space: metadata.space,
    kind,
    name: metadata.name,
    form: {
      type: portableTypeForShapeKind(kind),
      version: formRef.definitionVersion,
      schemaDigest: formRef.schemaDigest,
      packageDigest: form.packageDigest,
    },
    expectedGeneration:
      resourceVersion === undefined ? 0 : Number(resourceVersion),
    managedBy: "takoform.form-host.v1",
    spec,
  };
}

function jsonRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hostEvidenceWorkspace(space: string): string {
  if ((HOST_SPACES as readonly string[]).includes(space)) {
    return HOST_EVIDENCE_PRIMARY_WORKSPACE;
  }
  throw new TypeError(`portable host evidence Space is not owned: ${space}`);
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
      "worker_fetch",
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

export function buildCurrentHostReportUpdateFixture(
  kind: string,
  desired: JsonObject,
  immutableFields: readonly string[],
  parser: ResourceShapeSchemaParser,
): JsonObject {
  const result = structuredClone(desired);
  const mutations: Readonly<Record<string, () => void>> = {
    EdgeWorker: () => {
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
      result.maxConcurrency = Number(result.maxConcurrency ?? 1) + 1;
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
    "  build --takoform-root DIR --output-dir DIR --source-commit SHA --takoform-source-commit SHA --request-id UUID",
    "  verify-unsigned --output-dir DIR --source-commit SHA --takoform-source-commit SHA --request-id UUID",
    "  finalize --output-dir DIR --source-commit SHA --takoform-source-commit SHA --request-id UUID --workflow-run-id ID --workflow-run-attempt 1",
    "  verify-signed --output-dir DIR --source-commit SHA --takoform-source-commit SHA --request-id UUID --workflow-run-id ID --workflow-run-attempt 1",
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
