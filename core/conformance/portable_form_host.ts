import type {
  InstalledFormReference,
  JsonObject,
  StandardFormNegativeFixture,
  StandardFormConformanceProof,
  TakoformResource,
} from "takosumi-contract";
import {
  installedFormReferenceKey,
  isInstalledFormReference,
  TAKOFORM_FORM_HOST_API_PATH,
  TAKOFORM_FORM_HOST_API_VERSION,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
} from "takosumi-contract";
import {
  canonicalJson as rfc8785CanonicalJson,
  type CanonicalJsonValue,
} from "../adapters/takoform/canonical_json.ts";
import { sha256HexOfStringAsync } from "../shared/runtime/hash.ts";

export interface PortableFormHostConformanceInput {
  readonly endpoint: string;
  readonly token?: string;
  readonly space: string;
  readonly name: string;
  readonly identity: InstalledFormReference;
  readonly desired: JsonObject;
  /**
   * A distinct, valid desired document for the same Resource identity. When
   * supplied, the runner proves an ETag-fenced update rather than treating a
   * create replay as update evidence.
   */
  readonly updatedDesired?: JsonObject;
  /** Exact retained fixture name covered by the lifecycle run. */
  readonly positiveFixtureName?: string;
  /**
   * SHA-256 of the exact retained package fixture file executed as desired.
   * Standard-admission serialization requires this package readback binding.
   */
  readonly positivePackageFixtureDigest?: string;
  /**
   * Retained negative fixtures that the host must actually reject. The v1
   * runner currently admits desired-state fixtures only; unsupported stages
   * fail closed rather than being copied into evidence without execution.
   */
  readonly negativeFixtures?: readonly StandardFormNegativeFixture[];
  /** Exact retained package fixture-file SHA-256 keyed by negative name. */
  readonly negativePackageFixtureDigests?: Readonly<Record<string, string>>;
  /** When present, the runner also proves exact import replay and cleanup. */
  readonly importNativeId?: string;
  /**
   * Optional host/backend-specific setup invoked immediately before the
   * read-only drift observation. The callback may mutate only the already
   * created native test object; the runner still decides success exclusively
   * from the portable host observation response.
   */
  readonly beforeDriftObserve?: (context: {
    readonly canonicalResourceId: string;
    readonly resourceVersion: string;
  }) => void | Promise<void>;
  /** Require the portable observe response to report actual backend drift. */
  readonly expectDrift?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PortableFormHostConformanceReport {
  readonly apiVersion: "takosumi.portable-form-host-conformance/v1";
  readonly identity: InstalledFormReference;
  readonly endpointOrigin: string;
  readonly status: "passed";
  readonly checks: readonly string[];
  readonly fixtures: {
    readonly positive: readonly {
      readonly name: string;
      readonly inputDigest: string;
      readonly packageFixtureDigest?: string;
    }[];
    readonly negative: readonly {
      readonly name: string;
      readonly stage: "desired";
      readonly inputDigest: string;
      readonly packageFixtureDigest?: string;
      readonly httpStatus: 400;
      readonly errorCode: string;
    }[];
  };
  readonly canonicalResourceId: string;
  readonly evidenceDigest: string;
}

/**
 * Black-box host runner. It exercises the neutral facade and then reads the
 * existing Takosumi compatibility projection solely to prove both facades
 * converge on the same canonical Resource and audit rows.
 */
export async function runPortableFormHostConformance(
  input: PortableFormHostConformanceInput,
): Promise<PortableFormHostConformanceReport> {
  const endpoint = input.endpoint.replace(/\/+$/u, "");
  const fetcher = input.fetch ?? globalThis.fetch;
  const positiveFixtureName = input.positiveFixtureName ?? "canonical";
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(positiveFixtureName)) {
    throw new Error(
      `positive fixture name is not canonical: ${positiveFixtureName}`,
    );
  }
  assertDesiredName(input.desired, input.name, "desired");
  if (input.updatedDesired) {
    assertDesiredName(input.updatedDesired, input.name, "updated desired");
    if (canonicalJson(input.updatedDesired) === canonicalJson(input.desired)) {
      throw new Error(
        "updated desired fixture must differ from create desired",
      );
    }
  }
  const headers = {
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
  };
  const checks: string[] = [];
  const base = `${endpoint}${TAKOFORM_FORM_HOST_API_PATH}`;
  const exact = exactQuery(input.identity);
  const resourcePath = `${base}/resources/${encodeURIComponent(input.identity.formRef.kind)}/${encodeURIComponent(input.name)}`;
  const body = resourceBody(input, input.name, input.desired);

  const discovery = await jsonRequest(
    fetcher,
    `${endpoint}${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`,
    { headers },
  );
  if (
    !Array.isArray(discovery.api_versions) ||
    !discovery.api_versions.includes(TAKOFORM_FORM_HOST_API_VERSION) ||
    !isRecord(discovery.features) ||
    discovery.features.service_forms !== true
  ) {
    throw new Error("portable discovery does not advertise the exact Form API");
  }
  checks.push("discovery");

  const forms = await jsonRequest(
    fetcher,
    `${base}/forms?space=${encodeURIComponent(input.space)}&${exact}`,
    { headers },
  );
  const available = asArray(forms.forms).find(
    (item) =>
      isRecord(item) &&
      isInstalledFormReference(item.identity) &&
      installedFormReferenceKey(item.identity) ===
        installedFormReferenceKey(input.identity),
  );
  if (!isRecord(available) || available.availableToPrincipal !== true) {
    throw new Error("exact Form is not available to the conformance principal");
  }
  checks.push("exact-availability");

  const fixtureReport = await runNegativeFixtures(
    input,
    fetcher,
    base,
    headers,
  );
  if (fixtureReport.length > 0) checks.push("negative-fixtures");

  const preview = await jsonRequest(fetcher, `${base}/resources/preview`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });
  const planDigest = stringAt(preview, "review", "planDigest");
  checks.push("preview");

  const applyRequest = { ...body, review: { planDigest } };
  const mutationHeaders = jsonHeaders({
    ...headers,
    "if-none-match": "*",
    "idempotency-key": "conformance-create-1",
  });
  const applied = await jsonRequest(fetcher, resourcePath, {
    method: "PUT",
    headers: mutationHeaders,
    body: JSON.stringify(applyRequest),
  });
  const resource = asTakoformResource(applied);
  const canonicalResourceId = resource.id;
  if (!canonicalResourceId)
    throw new Error("portable apply omitted canonical Resource id");
  checks.push("apply");

  const replay = asTakoformResource(
    await jsonRequest(fetcher, resourcePath, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify(applyRequest),
    }),
  );
  if (
    replay.id !== canonicalResourceId ||
    replay.metadata.resourceVersion !== resource.metadata.resourceVersion
  ) {
    throw new Error(
      "portable apply replay changed canonical identity or generation",
    );
  }
  checks.push("apply-idempotency");

  const readPath = `${resourcePath}?space=${encodeURIComponent(input.space)}&${exact}`;
  const read = asTakoformResource(
    await jsonRequest(fetcher, readPath, { headers }),
  );
  if (read.id !== canonicalResourceId)
    throw new Error("portable read identity changed");
  checks.push("read");

  const compatibility = await jsonRequest(
    fetcher,
    `${endpoint}/v1/resources/${encodeURIComponent(input.identity.formRef.kind)}/${encodeURIComponent(input.name)}?space=${encodeURIComponent(input.space)}`,
    { headers },
  );
  if (
    compatibility.id !== canonicalResourceId ||
    installedFormReferenceKey(
      compatibility.form as unknown as InstalledFormReference,
    ) !== installedFormReferenceKey(input.identity)
  ) {
    throw new Error(
      "compatibility facade does not project the canonical Resource row",
    );
  }
  checks.push("canonical-resource-parity");

  const substituted = {
    ...input.identity,
    formRef: {
      ...input.identity.formRef,
      schemaDigest: `sha256:${"f".repeat(64)}`,
    },
  };
  await expectError(
    fetcher,
    `${resourcePath}?space=${encodeURIComponent(input.space)}&${exactQuery(substituted)}`,
    { headers },
    409,
    "form_identity_conflict",
  );
  checks.push("exact-digest-substitution-rejected");

  let version = resource.metadata.resourceVersion;
  if (!version) throw new Error("portable Resource omitted resourceVersion");

  if (input.updatedDesired) {
    const updateBody = resourceBody(input, input.name, input.updatedDesired);
    const updatePreview = await jsonRequest(
      fetcher,
      `${base}/resources/preview`,
      {
        method: "POST",
        headers: jsonHeaders(headers),
        body: JSON.stringify(updateBody),
      },
    );
    const updatePlanDigest = stringAt(updatePreview, "review", "planDigest");
    const updated = asTakoformResource(
      await jsonRequest(fetcher, resourcePath, {
        method: "PUT",
        headers: jsonHeaders({
          ...headers,
          "if-match": `"${version}"`,
          "idempotency-key": "conformance-update-1",
        }),
        body: JSON.stringify({
          ...updateBody,
          review: { planDigest: updatePlanDigest },
        }),
      }),
    );
    if (
      updated.id !== canonicalResourceId ||
      !updated.metadata.resourceVersion ||
      updated.metadata.resourceVersion === version ||
      canonicalJson(updated.spec) !== canonicalJson(input.updatedDesired)
    ) {
      throw new Error(
        "portable update changed canonical identity, omitted a new resourceVersion, or did not retain desired state",
      );
    }
    const updateReplay = asTakoformResource(
      await jsonRequest(fetcher, resourcePath, {
        method: "PUT",
        headers: jsonHeaders({
          ...headers,
          "if-match": `"${version}"`,
          "idempotency-key": "conformance-update-1",
        }),
        body: JSON.stringify({
          ...updateBody,
          review: { planDigest: updatePlanDigest },
        }),
      }),
    );
    if (
      updateReplay.id !== canonicalResourceId ||
      updateReplay.metadata.resourceVersion !==
        updated.metadata.resourceVersion ||
      canonicalJson(updateReplay.spec) !== canonicalJson(input.updatedDesired)
    ) {
      throw new Error("portable update replay changed canonical state");
    }
    version = updated.metadata.resourceVersion;
    checks.push("update", "update-idempotency");
  }

  if (input.beforeDriftObserve && input.expectDrift !== true) {
    throw new Error("beforeDriftObserve requires expectDrift=true");
  }
  if (input.expectDrift === true && !input.beforeDriftObserve) {
    throw new Error(
      "expectDrift=true requires an explicit beforeDriftObserve setup",
    );
  }
  if (input.beforeDriftObserve) {
    await input.beforeDriftObserve({
      canonicalResourceId,
      resourceVersion: version,
    });
  }
  const observation = await jsonRequest(
    fetcher,
    `${resourcePath}/observe?space=${encodeURIComponent(input.space)}&${exact}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "if-match": `"${version}"`,
        "idempotency-key": "conformance-observe-1",
      },
    },
  );
  if (input.expectDrift === true) {
    if (stringAt(observation, "observation", "status") !== "drifted") {
      throw new Error("portable observe did not report expected backend drift");
    }
    checks.push("drift");
  }
  checks.push("observe");
  await jsonRequest(
    fetcher,
    `${resourcePath}/refresh?space=${encodeURIComponent(input.space)}&${exact}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "if-match": `"${version}"`,
        "idempotency-key": "conformance-refresh-1",
      },
    },
  );
  checks.push("refresh");

  const events = await jsonRequest(
    fetcher,
    `${endpoint}/v1/resources/${encodeURIComponent(input.identity.formRef.kind)}/${encodeURIComponent(input.name)}/events?space=${encodeURIComponent(input.space)}`,
    { headers },
  );
  const actions = new Set(
    asArray(events.events)
      .filter(isRecord)
      .map((event) => event.action)
      .filter((action): action is string => typeof action === "string"),
  );
  for (const required of [
    "resource.apply.succeeded",
    "resource.observe.succeeded",
    "resource.refresh.succeeded",
  ]) {
    if (!actions.has(required))
      throw new Error(`canonical audit lacks ${required}`);
  }
  checks.push("canonical-audit-parity");

  if (input.importNativeId) {
    await runImportConformance({ ...input, fetch: fetcher }, base, headers);
    checks.push("import-idempotency");
  }

  const deleteOptions = {
    method: "DELETE",
    headers: {
      ...headers,
      "if-match": `"${version}"`,
      "idempotency-key": "conformance-delete-1",
    },
  } as const;
  await emptyRequest(fetcher, readPath, deleteOptions, 204);
  await emptyRequest(
    fetcher,
    readPath,
    {
      method: "DELETE",
      headers: {
        ...headers,
        "if-match": `"${version}"`,
        "idempotency-key": "conformance-delete-1",
      },
    },
    204,
  );
  checks.push("delete-idempotency");

  const unsigned = {
    apiVersion: "takosumi.portable-form-host-conformance/v1" as const,
    identity: input.identity,
    endpointOrigin: new URL(endpoint).origin,
    status: "passed" as const,
    checks,
    fixtures: {
      positive: [
        {
          name: positiveFixtureName,
          inputDigest: await jsonDigest(input.desired),
          ...(input.positivePackageFixtureDigest
            ? {
                packageFixtureDigest: assertSha256Digest(
                  input.positivePackageFixtureDigest,
                  "positive package fixture",
                ),
              }
            : {}),
        },
      ],
      negative: fixtureReport,
    },
    canonicalResourceId,
  };
  return {
    ...unsigned,
    evidenceDigest: `sha256:${await sha256HexOfStringAsync(canonicalJson(unsigned))}`,
  };
}

/**
 * Exact retained report shape consumed by Takoform's standard-admission
 * verifier. Creation is deliberately fail closed: repo-only or partial host
 * runs cannot be serialized as complete admission evidence.
 */
export interface TakoformStandardHostRunnerReport {
  readonly format: "takoform.standard-runner-report@v1";
  readonly role: "host-report";
  readonly subject: string;
  readonly runnerVersion: string;
  readonly identity: InstalledFormReference;
  readonly status: "passed";
  readonly executionEvidence: Omit<
    PortableFormHostConformanceReport,
    "evidenceDigest"
  >;
  readonly executionEvidenceDigest: string;
  readonly lifecycle: {
    readonly create: true;
    readonly read: true;
    readonly update: true;
    readonly delete: true;
    readonly import: true;
    readonly observe: true;
    readonly refresh: true;
    readonly drift: true;
  };
  readonly positiveFixtures: readonly {
    readonly name: string;
    readonly packageFixtureDigest: string;
    readonly effectiveInputDigest: string;
    readonly passed: true;
  }[];
  readonly negativeFixtures: readonly {
    readonly name: string;
    readonly packageFixtureDigest: string;
    readonly effectiveInputDigest: string;
    readonly errorCode: string;
    readonly passed: true;
  }[];
}

export async function portableStandardHostRunnerReport(
  report: PortableFormHostConformanceReport,
  options: {
    /**
     * Source-bound runner version retained by the signed report lane. Local
     * callers keep the compatibility default; release evidence supplies an
     * exact reviewed source identity.
     */
    readonly runnerVersion?: string;
  } = {},
): Promise<{
  readonly report: TakoformStandardHostRunnerReport;
  readonly canonical: string;
  readonly evidenceDigest: string;
  readonly proof: StandardFormConformanceProof;
}> {
  const runnerVersion = options.runnerVersion ?? "1.1.0";
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(runnerVersion)) {
    throw new Error("standard host runnerVersion must be a canonical semver");
  }
  const requiredChecks = [
    "apply",
    "read",
    "update",
    "delete-idempotency",
    "import-idempotency",
    "observe",
    "refresh",
    "drift",
  ] as const;
  const completed = new Set(report.checks);
  const missing = requiredChecks.filter((check) => !completed.has(check));
  if (missing.length > 0) {
    throw new Error(
      `portable host run cannot become standard-admission evidence; missing ${missing.join(", ")}`,
    );
  }
  if (
    report.fixtures.positive.length === 0 ||
    report.fixtures.negative.length === 0
  ) {
    throw new Error(
      "portable host run cannot become standard-admission evidence without positive and negative fixtures",
    );
  }
  const nonPortableNegative = report.fixtures.negative.find(
    ({ errorCode }) => errorCode !== "invalid_argument",
  );
  if (nonPortableNegative) {
    throw new Error(
      `portable host run cannot become standard-admission evidence; negative fixture ${nonPortableNegative.name} returned ${nonPortableNegative.errorCode} instead of invalid_argument`,
    );
  }
  const unboundPositive = report.fixtures.positive.find(
    ({ packageFixtureDigest }) => !packageFixtureDigest,
  );
  const unboundNegative = report.fixtures.negative.find(
    ({ packageFixtureDigest }) => !packageFixtureDigest,
  );
  if (unboundPositive || unboundNegative) {
    throw new Error(
      "portable host run cannot become standard-admission evidence without exact retained package fixture digests",
    );
  }
  const { evidenceDigest: executionEvidenceDigest, ...executionEvidence } =
    report;
  const standardReport: TakoformStandardHostRunnerReport = {
    format: "takoform.standard-runner-report@v1",
    role: "host-report",
    subject: `host:${report.endpointOrigin}`,
    runnerVersion,
    identity: report.identity,
    status: "passed",
    executionEvidence,
    executionEvidenceDigest,
    lifecycle: {
      create: true,
      read: true,
      update: true,
      delete: true,
      import: true,
      observe: true,
      refresh: true,
      drift: true,
    },
    positiveFixtures: report.fixtures.positive.map(
      ({ name, packageFixtureDigest, inputDigest }) => ({
        name,
        packageFixtureDigest: packageFixtureDigest!,
        effectiveInputDigest: inputDigest,
        passed: true,
      }),
    ),
    negativeFixtures: report.fixtures.negative.map(
      ({ name, errorCode, packageFixtureDigest, inputDigest }) => ({
        name,
        packageFixtureDigest: packageFixtureDigest!,
        effectiveInputDigest: inputDigest,
        errorCode,
        passed: true,
      }),
    ),
  };
  const canonical = rfc8785CanonicalJson(
    standardReport as unknown as CanonicalJsonValue,
  );
  const evidenceDigest = `sha256:${await sha256HexOfStringAsync(canonical)}`;
  return {
    report: standardReport,
    canonical,
    evidenceDigest,
    proof: {
      subject: standardReport.subject,
      runnerVersion: standardReport.runnerVersion,
      identity: standardReport.identity,
      status: standardReport.status,
      positiveFixtures: standardReport.positiveFixtures.map(({ name }) => name),
      negativeFixtures: standardReport.negativeFixtures.map(({ name }) => name),
      evidenceDigest,
    },
  };
}

export function portableHostConformanceProof(
  report: PortableFormHostConformanceReport,
): StandardFormConformanceProof {
  return {
    subject: `host:${report.endpointOrigin}`,
    runnerVersion: "1.0.0",
    identity: report.identity,
    status: "passed",
    positiveFixtures: report.fixtures.positive.map((fixture) => fixture.name),
    negativeFixtures: report.fixtures.negative.map((fixture) => fixture.name),
    evidenceDigest: report.evidenceDigest,
  };
}

async function runNegativeFixtures(
  input: PortableFormHostConformanceInput,
  fetcher: typeof globalThis.fetch,
  base: string,
  headers: Record<string, string>,
): Promise<
  readonly {
    readonly name: string;
    readonly stage: "desired";
    readonly inputDigest: string;
    readonly packageFixtureDigest?: string;
    readonly httpStatus: 400;
    readonly errorCode: string;
  }[]
> {
  const fixtures = input.negativeFixtures ?? [];
  const names = new Set<string>();
  const report: {
    name: string;
    stage: "desired";
    inputDigest: string;
    packageFixtureDigest?: string;
    httpStatus: 400;
    errorCode: string;
  }[] = [];
  for (const fixture of fixtures) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(fixture.name)) {
      throw new Error(
        `negative fixture name is not canonical: ${fixture.name}`,
      );
    }
    if (names.has(fixture.name)) {
      throw new Error(`duplicate negative fixture name: ${fixture.name}`);
    }
    names.add(fixture.name);
    if (fixture.stage !== "desired") {
      throw new Error(
        `portable host runner does not execute negative fixture stage ${fixture.stage}`,
      );
    }
    if (!/^[a-z][a-z0-9._-]{2,127}$/u.test(fixture.expectedErrorCode)) {
      throw new Error(
        `negative fixture error code is not canonical: ${fixture.expectedErrorCode}`,
      );
    }
    const name = fixture.input.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(
        `negative fixture ${fixture.name} must contain its exact Resource spec.name`,
      );
    }
    await expectError(
      fetcher,
      `${base}/resources/preview`,
      {
        method: "POST",
        headers: jsonHeaders(headers),
        body: JSON.stringify(resourceBody(input, name, fixture.input)),
      },
      400,
      fixture.expectedErrorCode,
    );
    report.push({
      name: fixture.name,
      stage: "desired",
      inputDigest: await jsonDigest(fixture.input),
      ...(input.negativePackageFixtureDigests?.[fixture.name]
        ? {
            packageFixtureDigest: assertSha256Digest(
              input.negativePackageFixtureDigests[fixture.name]!,
              `negative package fixture ${fixture.name}`,
            ),
          }
        : {}),
      httpStatus: 400,
      errorCode: fixture.expectedErrorCode,
    });
  }
  return report;
}

function assertSha256Digest(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} digest is not a canonical SHA-256 digest`);
  }
  return value;
}

async function runImportConformance(
  input: PortableFormHostConformanceInput & {
    readonly fetch: typeof globalThis.fetch;
  },
  base: string,
  headers: Record<string, string>,
): Promise<void> {
  const name = `${input.name}-import`;
  const path = `${base}/resources/${encodeURIComponent(input.identity.formRef.kind)}/${encodeURIComponent(name)}`;
  const desired = { ...input.desired, name };
  const body = {
    ...resourceBody(input, name, desired),
    nativeId: input.importNativeId,
  };
  const mutation = {
    method: "POST",
    headers: jsonHeaders({
      ...headers,
      "if-none-match": "*",
      "idempotency-key": "conformance-import-1",
    }),
    body: JSON.stringify(body),
  } as const;
  const imported = await jsonRequest(input.fetch, `${path}/import`, mutation);
  await jsonRequest(input.fetch, `${path}/import`, mutation);
  const version = stringAt(imported, "resource", "metadata", "resourceVersion");
  await emptyRequest(
    input.fetch,
    `${path}?space=${encodeURIComponent(input.space)}&${exactQuery(input.identity)}`,
    {
      method: "DELETE",
      headers: {
        ...headers,
        "if-match": `"${version}"`,
        "idempotency-key": "conformance-import-delete-1",
      },
    },
    204,
  );
}

function resourceBody(
  input: PortableFormHostConformanceInput,
  name: string,
  desired: JsonObject,
) {
  return {
    apiVersion: TAKOFORM_FORM_HOST_API_VERSION,
    kind: input.identity.formRef.kind,
    form: input.identity,
    metadata: { name, space: input.space },
    spec: desired,
  };
}

function assertDesiredName(
  desired: JsonObject,
  expected: string,
  label: string,
): void {
  if (desired.name !== expected) {
    throw new Error(`${label} must preserve Resource spec.name ${expected}`);
  }
}

function exactQuery(identity: InstalledFormReference): string {
  return new URLSearchParams({
    apiVersion: identity.formRef.apiVersion,
    kind: identity.formRef.kind,
    definitionVersion: identity.formRef.definitionVersion,
    schemaDigest: identity.formRef.schemaDigest,
    packageDigest: identity.packageDigest,
  }).toString();
}

async function jsonRequest(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, init);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `${init.method ?? "GET"} ${url} failed: ${JSON.stringify(body)}`,
    );
  return body;
}

async function emptyRequest(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  status: number,
): Promise<void> {
  const response = await fetcher(url, init);
  if (response.status !== status)
    throw new Error(
      `${init.method ?? "GET"} ${url} returned ${response.status}`,
    );
}

async function expectError(
  fetcher: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  status: number,
  code: string,
): Promise<void> {
  const response = await fetcher(url, init);
  const body = (await response.json()) as { error?: { code?: string } };
  if (response.status !== status || body.error?.code !== code) {
    throw new Error(
      `expected ${status}/${code}, got ${response.status}/${body.error?.code ?? "none"}`,
    );
  }
}

function asTakoformResource(value: Record<string, unknown>): TakoformResource {
  if (!isRecord(value.metadata))
    throw new Error("portable response lacks Resource metadata");
  return value as unknown as TakoformResource;
}

function stringAt(value: unknown, ...path: string[]): string {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) throw new Error(`response lacks ${path.join(".")}`);
    current = current[key];
  }
  if (typeof current !== "string")
    throw new Error(`response lacks ${path.join(".")}`);
  return current;
}

function jsonHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers, "content-type": "application/json" };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function jsonDigest(value: unknown): Promise<string> {
  return `sha256:${await sha256HexOfStringAsync(canonicalJson(value))}`;
}
