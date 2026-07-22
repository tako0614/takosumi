import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  AdapterApplyInput,
  AdapterDeleteInput,
  AdapterImportInput,
} from "../../core/domains/resource-shape/adapter.ts";
import {
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  MapResourceShapeModuleRegistry,
  StubResourceShapeAdapter,
} from "../../core/domains/resource-shape/mod.ts";
import { InMemoryFormRegistryStore } from "../../core/domains/service-forms/mod.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import {
  portableStandardHostRunnerReport,
  runPortableFormHostConformance,
  type TakoformStandardHostRunnerReport,
} from "../../core/conformance/portable_form_host.ts";
import { canonicalJson } from "../../core/adapters/takoform/canonical_json.ts";
import { RESOURCE_SHAPE_KINDS } from "takosumi-contract";
import type {
  FormActivation,
  FormDefinition,
  FormPackage,
  InstalledFormReference,
  JsonObject,
  ResourceShapeKind,
  TargetPoolSpec,
} from "takosumi-contract";
import { readExactPackageFixtureBindings } from "./takoform-package-fixture-bindings.ts";

export const STANDARD_HOST_REPORT_SUBJECT =
  "host:https://in-process.takosumi.test";
export const STANDARD_HOST_REPORT_ORIGIN = "https://in-process.takosumi.test";
export const STANDARD_HOST_REPORT_WORKFLOW =
  ".github/workflows/standard-form-host-report.yml";
export const STANDARD_HOST_REPORT_CERTIFICATE_IDENTITY =
  "https://github.com/tako0614/takosumi/.github/workflows/standard-form-host-report.yml@refs/heads/main";
export const STANDARD_HOST_REPORT_PROOF_TYPE =
  "oss-reference-host-source-conformance";
export const STANDARD_HOST_REPORT_MANIFEST = "host-report-manifest.json";
export const STANDARD_HOST_REPORT_SIGNED_MANIFEST =
  "signed-host-report-candidate.json";

const MATRIX_URL = new URL(
  "../../fixtures/takoform-standard-1.0.1-host-matrix.json",
  import.meta.url,
);
const POSITIVE_FIXTURE_NAME = "canonical";
const NEGATIVE_FIXTURE_NAME = "reject-invalid-semantics";
const REPORT_FORMAT = "takoform.standard-runner-report@v1";
const MANIFEST_FORMAT = "takosumi.standard-form-host-report-candidate@v1";
const SIGNED_MANIFEST_FORMAT =
  "takosumi.standard-form-host-report-signed-candidate@v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface StandardFormHostMatrixEntry {
  readonly kind: ResourceShapeKind;
  readonly identity: InstalledFormReference;
  readonly interfaceDescriptors?: FormDefinition["interfaceDescriptors"];
  readonly desired: JsonObject;
  readonly negative: JsonObject;
  readonly desiredDigest: string;
  readonly negativeDigest: string;
}

interface StandardFormHostMatrix {
  readonly format: "takosumi.takoform-standard-host-matrix@v1";
  readonly status: "candidate-only";
  readonly definitionVersion: "1.0.1";
  readonly packageVersion: "1.0.1";
  readonly entries: readonly StandardFormHostMatrixEntry[];
}

interface TakoformStandardPackageSetEntry {
  readonly kind: ResourceShapeKind;
  readonly path: string;
  readonly formRef: InstalledFormReference["formRef"];
  readonly packageDigest: string;
}

interface TakoformStandardPackageSet {
  readonly format: "takoform.standard-package-set@v1";
  readonly classification: "structural-candidate";
  readonly definitionVersion: "1.0.1";
  readonly packageVersion: "1.0.1";
  readonly admissionStatus: "external-required";
  readonly packages: readonly TakoformStandardPackageSetEntry[];
}

export interface BoundStandardFormHostEntry extends StandardFormHostMatrixEntry {
  readonly slug: string;
  readonly packageRoot: string;
  readonly positiveFixtureName: typeof POSITIVE_FIXTURE_NAME;
  readonly negativeFixtureName: typeof NEGATIVE_FIXTURE_NAME;
  readonly positivePackageFixtureDigest: string;
  readonly negativePackageFixtureDigest: string;
}

export interface StandardFormHostReportManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly status: "candidate-only";
  readonly proofType: typeof STANDARD_HOST_REPORT_PROOF_TYPE;
  readonly subject: typeof STANDARD_HOST_REPORT_SUBJECT;
  readonly definitionVersion: "1.0.1";
  readonly packageVersion: "1.0.1";
  readonly runnerVersion: string;
  readonly source: {
    readonly repository: "https://github.com/tako0614/takosumi.git";
    readonly commit: string;
  };
  readonly takoformSource: {
    readonly repository: "https://github.com/tako0614/terraform-provider-takoform.git";
    readonly commit: string;
  };
  readonly reports: readonly {
    readonly kind: ResourceShapeKind;
    readonly slug: string;
    readonly path: string;
    readonly bundlePath: string;
    readonly digest: string;
    readonly identity: InstalledFormReference;
  }[];
}

export async function loadExactStandardFormHostEntries(input: {
  readonly takoformRoot: string;
}): Promise<readonly BoundStandardFormHostEntry[]> {
  const takoformRoot = resolve(input.takoformRoot);
  const matrix = await readJson<StandardFormHostMatrix>(MATRIX_URL);
  assertMatrix(matrix);
  const packageSet = await readJson<TakoformStandardPackageSet>(
    join(takoformRoot, "forms", "standard-package-set.json"),
  );
  assertPackageSet(packageSet);

  const packages = new Map(
    packageSet.packages.map((entry) => [entry.kind, entry]),
  );
  const bound: BoundStandardFormHostEntry[] = [];
  for (const entry of matrix.entries) {
    const packageEntry = packages.get(entry.kind);
    if (!packageEntry)
      throw new Error(`Takoform package set omitted ${entry.kind}`);
    if (
      canonicalJson(packageEntry.formRef) !==
        canonicalJson(entry.identity.formRef) ||
      packageEntry.packageDigest !== entry.identity.packageDigest
    ) {
      throw new Error(`Takoform package identity drifted for ${entry.kind}`);
    }
    const packageRoot = safeChild(takoformRoot, packageEntry.path);
    const slug = basename(packageEntry.path);
    if (!SLUG.test(slug)) {
      throw new Error(
        `Takoform package path has a non-canonical slug: ${slug}`,
      );
    }
    const negativeFixtures = [
      {
        name: NEGATIVE_FIXTURE_NAME,
        stage: "desired" as const,
        input: entry.negative,
        expectedErrorCode: "invalid_argument",
      },
    ];
    const fixtureBindings = await readExactPackageFixtureBindings({
      root: packageRoot,
      identity: entry.identity,
      positiveFixtureName: POSITIVE_FIXTURE_NAME,
      desired: entry.desired,
      negativeFixtures,
    });
    if (
      fixtureBindings.positive !== entry.desiredDigest ||
      fixtureBindings.negative[NEGATIVE_FIXTURE_NAME] !== entry.negativeDigest
    ) {
      throw new Error(
        `Takosumi fixture matrix drifted from Takoform ${entry.kind}`,
      );
    }
    bound.push({
      ...entry,
      slug,
      packageRoot,
      positiveFixtureName: POSITIVE_FIXTURE_NAME,
      negativeFixtureName: NEGATIVE_FIXTURE_NAME,
      positivePackageFixtureDigest: fixtureBindings.positive,
      negativePackageFixtureDigest:
        fixtureBindings.negative[NEGATIVE_FIXTURE_NAME]!,
    });
  }
  return bound;
}

export async function generateStandardFormHostReports(input: {
  readonly entries: readonly BoundStandardFormHostEntry[];
  readonly outputDir: string;
  readonly takosumiRoot: string;
  readonly takoformRoot: string;
  readonly takosumiCommit: string;
  readonly takoformCommit: string;
}): Promise<StandardFormHostReportManifest> {
  assertCommit(input.takosumiCommit, "Takosumi");
  assertCommit(input.takoformCommit, "Takoform");
  assertExactEntrySet(input.entries);
  const outputDir = resolve(input.outputDir);
  assertOutside(outputDir, resolve(input.takosumiRoot), "Takosumi checkout");
  assertOutside(outputDir, resolve(input.takoformRoot), "Takoform checkout");
  const runnerVersion = `1.1.0+git.${input.takosumiCommit}`;

  await mkdir(outputDir, { mode: 0o700 });
  try {
    const { app, adapter } = await createReferenceHost(input.entries);
    const reports: StandardFormHostReportManifest["reports"][number][] = [];
    await seedDependency(app, input.entries, "ObjectBucket", "edge-assets");

    for (const entry of input.entries) {
      if (entry.kind === "Schedule") {
        await seedDependency(app, input.entries, "DurableWorkflow", "ingest");
      }
      const report = await runPortableFormHostConformance({
        endpoint: STANDARD_HOST_REPORT_ORIGIN,
        space: "space_1",
        name: requireName(entry.desired, entry.kind),
        identity: entry.identity,
        desired: entry.desired,
        updatedDesired: updatedStandardDesired(entry),
        positiveFixtureName: entry.positiveFixtureName,
        positivePackageFixtureDigest: entry.positivePackageFixtureDigest,
        negativeFixtures: [
          {
            name: entry.negativeFixtureName,
            stage: "desired",
            input: entry.negative,
            expectedErrorCode: "invalid_argument",
          },
        ],
        negativePackageFixtureDigests: {
          [entry.negativeFixtureName]: entry.negativePackageFixtureDigest,
        },
        importNativeId: `reference-native-${entry.kind.toLowerCase()}`,
        expectDrift: true,
        beforeDriftObserve: ({ canonicalResourceId }) => {
          adapter.mutateObservedState(canonicalResourceId);
        },
        fetch: ((request: RequestInfo | URL, init?: RequestInit) =>
          app.request(request.toString(), init)) as typeof fetch,
      });
      const standard = await portableStandardHostRunnerReport(report, {
        runnerVersion,
      });
      assertStandardReport(standard.report, entry, runnerVersion);
      const reportPath = `packages/${entry.slug}/host-report.json`;
      const bundlePath = `packages/${entry.slug}/host-report.sigstore.json`;
      await writeCreateOnly(join(outputDir, reportPath), standard.canonical);
      reports.push({
        kind: entry.kind,
        slug: entry.slug,
        path: reportPath,
        bundlePath,
        digest: standard.evidenceDigest,
        identity: entry.identity,
      });
    }

    const manifest: StandardFormHostReportManifest = {
      format: MANIFEST_FORMAT,
      status: "candidate-only",
      proofType: STANDARD_HOST_REPORT_PROOF_TYPE,
      subject: STANDARD_HOST_REPORT_SUBJECT,
      definitionVersion: "1.0.1",
      packageVersion: "1.0.1",
      runnerVersion,
      source: {
        repository: "https://github.com/tako0614/takosumi.git",
        commit: input.takosumiCommit,
      },
      takoformSource: {
        repository:
          "https://github.com/tako0614/terraform-provider-takoform.git",
        commit: input.takoformCommit,
      },
      reports,
    };
    await writeCreateOnly(
      join(outputDir, STANDARD_HOST_REPORT_MANIFEST),
      canonicalJson(manifest as never),
    );
    return manifest;
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

export async function closeSignedStandardFormHostCandidate(input: {
  readonly candidateDir: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: string;
}): Promise<void> {
  if (!/^[1-9][0-9]*$/u.test(input.workflowRunId)) {
    throw new Error("workflow run id must be a positive integer");
  }
  if (input.workflowRunAttempt !== "1") {
    throw new Error("signed host-report candidates do not permit reruns");
  }
  const candidateDir = resolve(input.candidateDir);
  const manifest = await readJson<StandardFormHostReportManifest>(
    join(candidateDir, STANDARD_HOST_REPORT_MANIFEST),
  );
  assertReportManifest(manifest);

  const expectedBeforeClose = new Set<string>([STANDARD_HOST_REPORT_MANIFEST]);
  const entries = [];
  for (const report of manifest.reports) {
    expectedBeforeClose.add(report.path);
    expectedBeforeClose.add(report.bundlePath);
    const reportRaw = await readRegular(candidateDir, report.path);
    if (`sha256:${sha256(reportRaw)}` !== report.digest) {
      throw new Error(`${report.kind} report digest drifted before closure`);
    }
    const parsed = JSON.parse(reportRaw.toString("utf8")) as {
      format?: string;
      subject?: string;
    };
    if (
      parsed.format !== REPORT_FORMAT ||
      parsed.subject !== STANDARD_HOST_REPORT_SUBJECT
    ) {
      throw new Error(`${report.kind} report identity drifted before closure`);
    }
    const bundleRaw = await readRegular(candidateDir, report.bundlePath);
    const bundle = JSON.parse(bundleRaw.toString("utf8")) as {
      mediaType?: string;
    };
    if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json") {
      throw new Error(
        `${report.kind} Sigstore bundle has the wrong media type`,
      );
    }
    entries.push({
      kind: report.kind,
      slug: report.slug,
      reportPath: report.path,
      reportDigest: report.digest,
      bundlePath: report.bundlePath,
      bundleDigest: `sha256:${sha256(bundleRaw)}`,
    });
  }
  await assertExactFiles(candidateDir, expectedBeforeClose);
  const manifestRaw = await readRegular(
    candidateDir,
    STANDARD_HOST_REPORT_MANIFEST,
  );
  const signed = {
    format: SIGNED_MANIFEST_FORMAT,
    status: "candidate-only",
    proofType: STANDARD_HOST_REPORT_PROOF_TYPE,
    subject: STANDARD_HOST_REPORT_SUBJECT,
    certificateIdentity: STANDARD_HOST_REPORT_CERTIFICATE_IDENTITY,
    workflow: STANDARD_HOST_REPORT_WORKFLOW,
    workflowRunId: input.workflowRunId,
    workflowRunAttempt: 1,
    source: manifest.source,
    takoformSource: manifest.takoformSource,
    manifest: {
      path: STANDARD_HOST_REPORT_MANIFEST,
      digest: `sha256:${sha256(manifestRaw)}`,
    },
    entries,
  };
  await writeCreateOnly(
    join(candidateDir, STANDARD_HOST_REPORT_SIGNED_MANIFEST),
    canonicalJson(signed as never),
  );

  const checksummed = [
    ...expectedBeforeClose,
    STANDARD_HOST_REPORT_SIGNED_MANIFEST,
  ].sort();
  const checksumLines: string[] = [];
  for (const path of checksummed) {
    const raw = await readRegular(candidateDir, path);
    checksumLines.push(`${sha256(raw)}  ${path}`);
  }
  await writeCreateOnly(
    join(candidateDir, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
  );
  await assertExactFiles(candidateDir, new Set([...checksummed, "SHA256SUMS"]));
}

export async function loadCommittedHostMatrixForTest(): Promise<
  readonly BoundStandardFormHostEntry[]
> {
  const matrix = await readJson<StandardFormHostMatrix>(MATRIX_URL);
  assertMatrix(matrix);
  return matrix.entries.map((entry) => ({
    ...entry,
    slug: kebab(entry.kind),
    packageRoot: "/synthetic/takoform-package",
    positiveFixtureName: POSITIVE_FIXTURE_NAME,
    negativeFixtureName: NEGATIVE_FIXTURE_NAME,
    positivePackageFixtureDigest: entry.desiredDigest,
    negativePackageFixtureDigest: entry.negativeDigest,
  }));
}

class DeterministicStatefulConformanceAdapter extends StubResourceShapeAdapter {
  readonly id = "standard-form-reference-conformance";
  readonly #states = new Map<
    string,
    { desiredDigest: string; observedDigest: string }
  >();

  override async apply(input: AdapterApplyInput) {
    const applied = await super.apply(input);
    const name = requireName(input.plan.validatedSpec, input.plan.shape);
    const desiredDigest = sha256(canonicalJson(input.plan.validatedSpec));
    this.#states.set(input.resourceId, {
      desiredDigest,
      observedDigest: desiredDigest,
    });
    return {
      ...applied,
      outputs: {
        ...applied.outputs,
        id: input.resourceId,
        kind: input.plan.shape,
        name,
        generation: input.stateGeneration + 1,
        portability: "portable",
        ...(input.plan.shape === "SQLDatabase"
          ? { engine: input.plan.validatedSpec.engine ?? "sqlite" }
          : {}),
      },
    };
  }

  override async importResource(input: AdapterImportInput) {
    const imported = await super.importResource(input);
    return { ...imported, summary: `reference import ${input.resourceId}` };
  }

  override observe(input: AdapterApplyInput) {
    const state = this.#states.get(input.resourceId);
    if (!state) {
      return Promise.resolve({
        status: "missing" as const,
        summary: `reference native state missing for ${input.resourceId}`,
      });
    }
    const drifted = state.desiredDigest !== state.observedDigest;
    return Promise.resolve({
      status: drifted ? ("drifted" as const) : ("current" as const),
      summary: drifted
        ? `reference native state drifted for ${input.resourceId}`
        : `reference native state current for ${input.resourceId}`,
    });
  }

  override async delete(input: AdapterDeleteInput) {
    this.#states.delete(input.resourceId);
  }

  mutateObservedState(resourceId: string): void {
    const state = this.#states.get(resourceId);
    if (!state) throw new Error(`cannot drift unknown Resource ${resourceId}`);
    state.observedDigest = sha256(`${state.desiredDigest}:externally-mutated`);
  }
}

async function createReferenceHost(
  entries: readonly BoundStandardFormHostEntry[],
) {
  const formRegistryStore = new InMemoryFormRegistryStore();
  const installedAt = "2026-07-20T00:00:00.000Z";
  for (const entry of entries) {
    const formPackage: FormPackage = {
      packageDigest: entry.identity.packageDigest,
      artifactRef: `fixture://${entry.slug}/1.0.1`,
      verifierId: "exact-takoform-fixture-readback",
      status: "installed",
      definitionRefs: [entry.identity.formRef],
      installedAt,
      installedBy: "standard-form-reference-host",
      updatedAt: installedAt,
    };
    const definition: FormDefinition = {
      identity: entry.identity,
      displayName: `${entry.kind} standard Form 1.0.1`,
      operations: ["create", "read", "update", "delete", "import", "refresh"],
      ...(entry.interfaceDescriptors
        ? { interfaceDescriptors: entry.interfaceDescriptors }
        : {}),
      installedAt,
    };
    await formRegistryStore.installPackage(formPackage, [definition]);
    const activation: FormActivation = {
      id: `activation_standard_${entry.kind}`,
      identity: entry.identity,
      scope: { type: "space", id: "space_1" },
      audience: { roles: ["owner"] },
      policy: {},
      eligibleTargetPoolClasses: ["standard-reference-host"],
      status: "active",
      revision: 1,
      createdAt: installedAt,
      createdBy: "standard-form-reference-host",
      updatedAt: installedAt,
      updatedBy: "standard-form-reference-host",
    };
    await formRegistryStore.createActivation(activation);
  }

  const adapter = new DeterministicStatefulConformanceAdapter();
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    formRegistryStore,
    resourceShapeAdapter: adapter,
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    enabledResourceShapeKinds: RESOURCE_SHAPE_KINDS,
    resourceShapeModuleRegistry: new MapResourceShapeModuleRegistry({
      "standard-form-reference-host": {
        files: [{ path: "main.tf", text: "terraform {}\n" }],
      },
    }),
    resolveResourceInterfaceWorkspace: async ({ resourceSpaceId }) =>
      resourceSpaceId === "space_1" ? "workspace_1" : undefined,
  });

  const pool: TargetPoolSpec = {
    classes: ["standard-reference-host"],
    targets: [
      {
        name: "in-process-reference-host",
        type: "reference",
        ref: "in-process",
        priority: 100,
        implementations: entries.map((entry) => ({
          shape: entry.kind,
          implementation: `reference_${entry.kind.toLowerCase()}`,
          nativeResourceType: `reference.${entry.kind.toLowerCase()}`,
          providerSource: "registry.opentofu.org/takosumi/reference-host",
          moduleTemplate: "standard-form-reference-host",
          moduleImportAddress: "reference_resource.this",
          moduleOutputs: [
            { name: "id", type: "string" as const },
            { name: "name", type: "string" as const },
            ...(entry.kind === "SQLDatabase"
              ? [{ name: "engine", type: "string" as const }]
              : []),
          ],
          interfaces: STANDARD_HOST_INTERFACES[entry.kind],
        })),
      },
    ],
  };
  await requireOk(
    app.request("/v1/target-pools/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "space_1", spec: pool }),
    }),
    "install reference TargetPool",
  );
  await requireOk(
    app.request("/v1/space-policies/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: "space_1",
        spec: {
          resolution: { lockAfterCreate: true, allowAutoMigration: false },
        },
      }),
    }),
    "install reference SpacePolicy",
  );
  return { app, adapter };
}

const STANDARD_HOST_INTERFACES: Readonly<
  Record<ResourceShapeKind, Readonly<Record<string, "native">>>
> = {
  EdgeWorker: {
    worker_fetch: "native",
    workers: "native",
    resource_connection: "native",
    "object.binding.v1": "native",
    grant_read: "native",
    grant_write: "native",
  },
  ObjectBucket: {
    object_store: "native",
    s3_api: "native",
    signed_url: "native",
  },
  KVStore: { kv_store: "native", runtime_binding: "native" },
  SQLDatabase: { sql: "native", sqlite: "native" },
  Queue: { queue: "native", publish: "native", consume: "native" },
  VectorIndex: {
    vector_index: "native",
    vector_query: "native",
    runtime_binding: "native",
    cosine: "native",
    dot: "native",
  },
  DurableWorkflow: {
    durable_workflow: "native",
    invoke: "native",
    signal: "native",
  },
  ContainerService: { oci_container: "native", public_http: "native" },
  StatefulActorNamespace: {
    stateful_actor_namespace: "native",
    runtime_binding: "native",
    durable_sqlite: "native",
  },
  Schedule: {
    schedule: "native",
    cron: "native",
    invoke: "native",
    resource_connection: "native",
    schedule_trigger: "native",
    grant_invoke: "native",
  },
};

function updatedStandardDesired(
  entry: StandardFormHostMatrixEntry,
): JsonObject {
  const desired = structuredClone(entry.desired);
  switch (entry.kind) {
    case "EdgeWorker":
      desired.compatibilityDate = "2026-07-21";
      break;
    case "ObjectBucket":
      desired.interfaces = ["s3_api", "signed_url"];
      break;
    case "KVStore":
      desired.consistency = "strong";
      break;
    case "SQLDatabase":
      desired.migrationsPath = "migrations";
      break;
    case "Queue":
      desired.delivery = { maxRetries: 3 };
      break;
    case "VectorIndex":
      desired.metric = "dot";
      break;
    case "DurableWorkflow":
      desired.retry = { initialBackoffSeconds: 5, maxAttempts: 4 };
      break;
    case "ContainerService":
      desired.publicHttp = false;
      break;
    case "StatefulActorNamespace":
      desired.migrationTag = "v2";
      break;
    case "Schedule":
      desired.cron = "5 0 * * *";
      break;
  }
  return desired;
}

async function seedDependency(
  app: Awaited<ReturnType<typeof createTakosumiService>>["app"],
  entries: readonly BoundStandardFormHostEntry[],
  kind: ResourceShapeKind,
  name: string,
): Promise<void> {
  const entry = entries.find((candidate) => candidate.kind === kind);
  if (!entry) throw new Error(`standard host matrix omitted ${kind}`);
  await reviewedResourceApply(app, `/v1/resources/${kind}/${name}`, {
    metadata: { space: "space_1" },
    form: entry.identity,
    spec: { ...entry.desired, name },
  });
}

async function reviewedResourceApply(
  app: Awaited<ReturnType<typeof createTakosumiService>>["app"],
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const kind = path.split("/")[3];
  if (!kind) throw new Error(`cannot infer Resource kind from ${path}`);
  const preview = await app.request("/v1/resources/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, kind }),
  });
  if (!preview.ok) {
    throw new Error(`dependency preview failed: ${await preview.text()}`);
  }
  const evidence = (await preview.json()) as {
    planDigest: string;
    quote?: { quoteId: string; quoteDigest: string };
  };
  const apply = await app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...body,
      review: {
        planDigest: evidence.planDigest,
        ...(evidence.quote
          ? {
              quoteId: evidence.quote.quoteId,
              quoteDigest: evidence.quote.quoteDigest,
            }
          : {}),
      },
    }),
  });
  if (!apply.ok)
    throw new Error(`dependency apply failed: ${await apply.text()}`);
}

function assertStandardReport(
  report: TakoformStandardHostRunnerReport,
  entry: BoundStandardFormHostEntry,
  runnerVersion: string,
): void {
  if (
    report.format !== REPORT_FORMAT ||
    report.role !== "host-report" ||
    report.subject !== STANDARD_HOST_REPORT_SUBJECT ||
    report.runnerVersion !== runnerVersion ||
    report.status !== "passed" ||
    canonicalJson(report.identity) !== canonicalJson(entry.identity) ||
    report.positiveFixtures.length !== 1 ||
    report.positiveFixtures[0]?.name !== entry.positiveFixtureName ||
    report.positiveFixtures[0]?.packageFixtureDigest !==
      entry.positivePackageFixtureDigest ||
    report.negativeFixtures.length !== 1 ||
    report.negativeFixtures[0]?.name !== entry.negativeFixtureName ||
    report.negativeFixtures[0]?.packageFixtureDigest !==
      entry.negativePackageFixtureDigest ||
    report.negativeFixtures[0]?.errorCode !== "invalid_argument"
  ) {
    throw new Error(`${entry.kind} standard host report failed exact closure`);
  }
}

function assertMatrix(matrix: StandardFormHostMatrix): void {
  if (
    matrix.format !== "takosumi.takoform-standard-host-matrix@v1" ||
    matrix.status !== "candidate-only" ||
    matrix.definitionVersion !== "1.0.1" ||
    matrix.packageVersion !== "1.0.1"
  ) {
    throw new Error("Takosumi standard host matrix identity drifted");
  }
  assertExactKinds(matrix.entries.map(({ kind }) => kind));
  for (const entry of matrix.entries) {
    if (
      entry.identity.formRef.kind !== entry.kind ||
      entry.identity.formRef.definitionVersion !== "1.0.1" ||
      !SHA256.test(entry.identity.formRef.schemaDigest) ||
      !SHA256.test(entry.identity.packageDigest) ||
      !SHA256.test(entry.desiredDigest) ||
      !SHA256.test(entry.negativeDigest)
    ) {
      throw new Error(
        `Takosumi standard host matrix entry ${entry.kind} is invalid`,
      );
    }
  }
}

function assertPackageSet(packageSet: TakoformStandardPackageSet): void {
  if (
    packageSet.format !== "takoform.standard-package-set@v1" ||
    packageSet.classification !== "structural-candidate" ||
    packageSet.definitionVersion !== "1.0.1" ||
    packageSet.packageVersion !== "1.0.1" ||
    packageSet.admissionStatus !== "external-required"
  ) {
    throw new Error(
      "Takoform standard package set is not the exact 1.0.1 candidate",
    );
  }
  assertExactKinds(packageSet.packages.map(({ kind }) => kind));
}

function assertExactEntrySet(entries: readonly BoundStandardFormHostEntry[]) {
  assertExactKinds(entries.map(({ kind }) => kind));
  const slugs = new Set(entries.map(({ slug }) => slug));
  if (slugs.size !== entries.length)
    throw new Error("standard host slugs are not unique");
}

function assertExactKinds(kinds: readonly ResourceShapeKind[]): void {
  const actual = [...kinds].sort();
  const expected = [...RESOURCE_SHAPE_KINDS].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("standard host candidate must contain exactly ten kinds");
  }
}

function assertReportManifest(manifest: StandardFormHostReportManifest): void {
  if (
    manifest.format !== MANIFEST_FORMAT ||
    manifest.status !== "candidate-only" ||
    manifest.proofType !== STANDARD_HOST_REPORT_PROOF_TYPE ||
    manifest.subject !== STANDARD_HOST_REPORT_SUBJECT ||
    manifest.definitionVersion !== "1.0.1" ||
    manifest.packageVersion !== "1.0.1" ||
    !COMMIT.test(manifest.source.commit) ||
    !COMMIT.test(manifest.takoformSource.commit)
  ) {
    throw new Error("host report manifest identity is invalid");
  }
  assertExactKinds(manifest.reports.map(({ kind }) => kind));
  for (const report of manifest.reports) {
    if (
      !SLUG.test(report.slug) ||
      report.path !== `packages/${report.slug}/host-report.json` ||
      report.bundlePath !==
        `packages/${report.slug}/host-report.sigstore.json` ||
      !SHA256.test(report.digest) ||
      report.identity.formRef.kind !== report.kind
    ) {
      throw new Error(`${report.kind} manifest entry is invalid`);
    }
  }
}

async function writeCreateOnly(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function readRegular(root: string, path: string): Promise<Buffer> {
  const absolute = safeChild(root, path);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`${path} is not a regular file`);
  return await readFile(absolute);
}

async function assertExactFiles(root: string, expected: ReadonlySet<string>) {
  const actual = new Set(await walkFiles(root));
  if (
    canonicalJson([...actual].sort()) !== canonicalJson([...expected].sort())
  ) {
    throw new Error("signed host-report candidate file closure is not exact");
  }
}

async function walkFiles(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("candidate contains a symlink");
    if (entry.isDirectory()) result.push(...(await walkFiles(root, absolute)));
    else if (entry.isFile())
      result.push(relative(root, absolute).split(sep).join("/"));
    else throw new Error("candidate contains a non-regular entry");
  }
  return result;
}

function safeChild(root: string, path: string): string {
  if (path === "" || path.includes("\\"))
    throw new Error(`unsafe path ${path}`);
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`path escapes its root: ${path}`);
  }
  return absolute;
}

function assertOutside(path: string, root: string, label: string): void {
  const fromRoot = relative(root, path);
  if (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== "..")
  ) {
    throw new Error(`output directory must be outside the ${label}`);
  }
}

function assertCommit(value: string, label: string): void {
  if (!COMMIT.test(value))
    throw new Error(`${label} commit must be lowercase 40-hex`);
}

function requireName(value: JsonObject, label: string): string {
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error(`${label} desired fixture has no Resource name`);
  }
  return value.name;
}

function kebab(kind: string): string {
  return kind.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(path: string | URL): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function requireOk(
  response: Promise<Response>,
  label: string,
): Promise<void> {
  const result = await response;
  if (!result.ok) throw new Error(`${label} failed: ${await result.text()}`);
}
