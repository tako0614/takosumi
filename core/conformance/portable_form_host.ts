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
  portableTypeForShapeKind,
  shapeKindForPortableType,
  TAKOFORM_FORM_HOST_API_VERSION,
  TAKOFORM_FORM_HOST_API_PATH,
  TAKOFORM_FORM_HOST_PROTOCOL,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
} from "takosumi-contract";
import { sha256HexOfStringAsync } from "../shared/runtime/hash.ts";

export interface PortableFormHostConformanceInput {
  readonly endpoint: string;
  readonly token?: string;
  readonly space: string;
  readonly name: string;
  readonly identity: InstalledFormReference;
  readonly desired: JsonObject;
  /** A second schema-valid desired document used to prove an actual update. */
  readonly updatedDesired?: JsonObject;
  /** Exact retained fixture name covered by the lifecycle run. */
  readonly positiveFixtureName?: string;
  /**
   * Retained negative desired-state fixtures that the host must actually
   * reject. The legacy `config` spelling remains input-only during migration;
   * unsupported stages fail closed instead of becoming unexecuted evidence.
   */
  readonly negativeFixtures?: readonly PortableFormHostNegativeFixture[];
  /** When present, the runner also proves exact import replay and cleanup. */
  readonly importNativeId?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The current Takoform package vocabulary calls the input document `desired`.
 * `config` remains accepted only so older callers can be migrated without
 * changing what the host executes; emitted evidence always uses `desired`.
 */
export type PortableFormHostNegativeFixture = Omit<
  StandardFormNegativeFixture,
  "stage"
> & {
  readonly stage: StandardFormNegativeFixture["stage"] | "desired";
};

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
    }[];
    readonly negative: readonly {
      readonly name: string;
      readonly stage: "desired";
      readonly inputDigest: string;
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
  const headers = {
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
  };
  const checks: string[] = [];
  const base = `${endpoint}${TAKOFORM_FORM_HOST_API_PATH}`;
  const exact = exactQuery(input.identity);
  const resourcePath = `${base}/resources/${encodeURIComponent(compatibilityKind(input.identity.type))}/${encodeURIComponent(input.name)}`;
  const body = resourceBody(input, input.name, input.desired);
  const idempotencyScope = (
    await sha256HexOfStringAsync(
      `${installedFormReferenceKey(input.identity)}\n${input.name}`,
    )
  ).slice(0, 32);
  const idempotencyKey = (operation: string) =>
    `conformance-${operation}-${idempotencyScope}`;

  const discovery = await jsonRequest(
    fetcher,
    `${endpoint}${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`,
    { headers },
  );
  if (
    !Array.isArray(discovery.protocols) ||
    !discovery.protocols.includes(TAKOFORM_FORM_HOST_PROTOCOL) ||
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
  const available = asArray(forms.forms).find((item) => {
    if (!isRecord(item)) return false;
    const identity = installedFormReferenceFromPortable(item.identity);
    return (
      identity !== undefined &&
      installedFormReferenceKey(identity) ===
        installedFormReferenceKey(input.identity)
    );
  });
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
    headers: jsonHeaders({ ...headers, "if-none-match": "*" }),
    body: JSON.stringify(body),
  });
  const planDigest = stringAt(preview, "review", "planDigest");
  checks.push("preview");

  const applyRequest = { ...body, review: { planDigest } };
  const mutationHeaders = jsonHeaders({
    ...headers,
    "if-none-match": "*",
    "idempotency-key": idempotencyKey("create"),
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
      "portable apply replay changed canonical identity or serial",
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
    `${endpoint}/v1/resources/${encodeURIComponent(compatibilityKind(input.identity.type))}/${encodeURIComponent(input.name)}?space=${encodeURIComponent(input.space)}`,
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
    schemaDigest: `sha256:${"f".repeat(64)}`,
  };
  await expectError(
    fetcher,
    `${resourcePath}?space=${encodeURIComponent(input.space)}&${exactQuery(substituted)}`,
    { headers },
    409,
    "conflict",
  );
  checks.push("exact-digest-substitution-rejected");

  let version = resource.metadata.resourceVersion;
  if (!version) throw new Error("portable Resource omitted resourceVersion");

  if (input.updatedDesired) {
    const updateBase = resourceBody(input, input.name, input.updatedDesired);
    const updateBody = {
      ...updateBase,
      metadata: {
        ...updateBase.metadata,
        resourceVersion: version,
      },
    };
    const updatePreview = await jsonRequest(
      fetcher,
      `${base}/resources/preview`,
      {
        method: "POST",
        headers: jsonHeaders({ ...headers, "if-match": `"${version}"` }),
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
          "idempotency-key": idempotencyKey("update"),
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
      updated.metadata.resourceVersion === version
    ) {
      throw new Error(
        "portable update did not preserve identity and advance resourceVersion",
      );
    }
    version = updated.metadata.resourceVersion;
    checks.push("update");
  }

  const observation = await jsonRequest(
    fetcher,
    `${resourcePath}/observe?space=${encodeURIComponent(input.space)}&${exact}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "if-match": `"${version}"`,
        "idempotency-key": idempotencyKey("observe"),
      },
    },
  );
  const observationStatus = stringAt(observation, "observation", "status");
  if (
    observationStatus !== "current" &&
    observationStatus !== "drifted" &&
    observationStatus !== "missing"
  ) {
    throw new Error("portable drift check omitted a canonical status");
  }
  checks.push("observe");
  checks.push("drift");
  await jsonRequest(
    fetcher,
    `${resourcePath}/refresh?space=${encodeURIComponent(input.space)}&${exact}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "if-match": `"${version}"`,
        "idempotency-key": idempotencyKey("refresh"),
      },
    },
  );
  checks.push("refresh");

  const events = await jsonRequest(
    fetcher,
    `${endpoint}/v1/resources/${encodeURIComponent(compatibilityKind(input.identity.type))}/${encodeURIComponent(input.name)}/events?space=${encodeURIComponent(input.space)}`,
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
    await runImportConformance(
      { ...input, fetch: fetcher },
      base,
      headers,
      idempotencyKey,
    );
    checks.push("import-idempotency");
  }

  const deleteOptions = {
    method: "DELETE",
    headers: {
      ...headers,
      "if-match": `"${version}"`,
      "idempotency-key": idempotencyKey("delete"),
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
        "idempotency-key": idempotencyKey("delete"),
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
    if (fixture.stage !== "config" && fixture.stage !== "desired") {
      throw new Error(
        `portable host runner does not execute negative fixture stage ${fixture.stage}`,
      );
    }
    if (!/^[a-z][a-z0-9._-]{2,127}$/u.test(fixture.expectedErrorCode)) {
      throw new Error(
        `negative fixture error code is not canonical: ${fixture.expectedErrorCode}`,
      );
    }
    const name = `${input.name}-negative-${report.length + 1}`;
    await expectError(
      fetcher,
      `${base}/resources/preview`,
      {
        method: "POST",
        headers: jsonHeaders({ ...headers, "if-none-match": "*" }),
        body: JSON.stringify(resourceBody(input, name, fixture.input)),
      },
      400,
      fixture.expectedErrorCode,
    );
    report.push({
      name: fixture.name,
      stage: "desired",
      inputDigest: await jsonDigest(fixture.input),
      httpStatus: 400,
      errorCode: fixture.expectedErrorCode,
    });
  }
  return report;
}

async function runImportConformance(
  input: PortableFormHostConformanceInput & {
    readonly fetch: typeof globalThis.fetch;
  },
  base: string,
  headers: Record<string, string>,
  idempotencyKey: (operation: string) => string,
): Promise<void> {
  const name = `${input.name}-import`;
  const path = `${base}/resources/${encodeURIComponent(compatibilityKind(input.identity.type))}/${encodeURIComponent(name)}`;
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
      "idempotency-key": idempotencyKey("import"),
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
        "idempotency-key": idempotencyKey("import-delete"),
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
    kind: compatibilityKind(input.identity.type),
    form: portableFormReference(input.identity),
    metadata: {
      name,
      space: input.space,
    },
    spec: desired,
  };
}

function exactQuery(identity: InstalledFormReference): string {
  return new URLSearchParams({
    apiVersion: TAKOFORM_FORM_HOST_API_VERSION,
    kind: compatibilityKind(identity.type),
    definitionVersion: identity.version,
    schemaDigest: identity.schemaDigest,
    packageDigest: identity.packageDigest,
  }).toString();
}

function portableFormReference(identity: InstalledFormReference) {
  return {
    formRef: {
      apiVersion: TAKOFORM_FORM_HOST_API_VERSION,
      kind: compatibilityKind(identity.type),
      definitionVersion: identity.version,
      schemaDigest: identity.schemaDigest,
    },
    packageDigest: identity.packageDigest,
  };
}

function installedFormReferenceFromPortable(
  value: unknown,
): InstalledFormReference | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.formRef) ||
    value.formRef.apiVersion !== TAKOFORM_FORM_HOST_API_VERSION ||
    typeof value.formRef.kind !== "string" ||
    typeof value.formRef.definitionVersion !== "string" ||
    typeof value.formRef.schemaDigest !== "string" ||
    typeof value.packageDigest !== "string"
  ) {
    return undefined;
  }
  const formRef = value.formRef;
  const type = portableTypeForShapeKind(formRef.kind as string);
  if (!type) return undefined;
  const translated = {
    type,
    version: formRef.definitionVersion,
    schemaDigest: formRef.schemaDigest,
    packageDigest: value.packageDigest,
  };
  return isInstalledFormReference(translated) ? translated : undefined;
}

/** The historical /v1 compatibility facade still speaks PascalCase kinds. */
function compatibilityKind(type: string): string {
  const kind = shapeKindForPortableType(type);
  if (!kind) throw new Error(`portable type ${type} has no compatibility kind`);
  return kind;
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
  if (
    value.apiVersion !== TAKOFORM_FORM_HOST_API_VERSION ||
    typeof value.kind !== "string" ||
    !isRecord(value.metadata) ||
    typeof value.metadata.space !== "string"
  ) {
    throw new Error("portable response lacks the versioned Resource envelope");
  }
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
