import type {
  InstalledFormReference,
  JsonObject,
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
import { sha256HexOfStringAsync } from "../shared/runtime/hash.ts";

export interface PortableFormHostConformanceInput {
  readonly endpoint: string;
  readonly token?: string;
  readonly space: string;
  readonly name: string;
  readonly identity: InstalledFormReference;
  readonly desired: JsonObject;
  /** When present, the runner also proves exact import replay and cleanup. */
  readonly importNativeId?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PortableFormHostConformanceReport {
  readonly apiVersion: "takosumi.portable-form-host-conformance/v1";
  readonly identity: InstalledFormReference;
  readonly endpointOrigin: string;
  readonly status: "passed";
  readonly checks: readonly string[];
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

  const version = resource.metadata.resourceVersion;
  if (!version) throw new Error("portable Resource omitted resourceVersion");
  await jsonRequest(
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
    canonicalResourceId,
  };
  return {
    ...unsigned,
    evidenceDigest: `sha256:${await sha256HexOfStringAsync(canonicalJson(unsigned))}`,
  };
}

export function portableHostConformanceProof(
  report: PortableFormHostConformanceReport,
  fixtureNames: {
    readonly positive: readonly string[];
    readonly negative: readonly string[];
  },
): StandardFormConformanceProof {
  return {
    subject: `host:${report.endpointOrigin}`,
    runnerVersion: "1.0.0",
    identity: report.identity,
    status: "passed",
    positiveFixtures: fixtureNames.positive,
    negativeFixtures: fixtureNames.negative,
    evidenceDigest: report.evidenceDigest,
  };
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
