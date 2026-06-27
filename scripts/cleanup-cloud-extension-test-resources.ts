#!/usr/bin/env bun
/**
 * Dry-run-first cleanup for Takosumi Cloud extension smoke resources.
 *
 * The public surface stays Cloudflare-compatible resource names
 * (workers/scripts, KV, D1, R2, Queues, Workflows). Workers for Platforms is an
 * internal backend detail and must not appear in this tool's output.
 */

import process from "node:process";

const DEFAULT_URL = "https://app.takosumi.com";
const DEFAULT_SESSION_TOKEN_FILE =
  "../takosumi-private/.secrets/production/TAKOSUMI_ACCOUNT_SESSION_TOKEN";
const DEFAULT_COMPAT_ACCOUNT_ID = "ts_acc_takosumi_cloud";
const DEFAULT_COMPAT_ZONE_ID = "zone_takosumi_cloud";

export const DEFAULT_CLOUD_EXTENSION_TEST_PREFIXES = [
  "takosumi-rest-",
  "takosumi-e2e-",
  "takosumi-smoke-",
  "takosumi-bind-",
  "takosumi-cloud-compat-provider-",
] as const;

type FetchLike = typeof fetch;

type ResourceKind =
  | "kv"
  | "r2"
  | "d1"
  | "queues"
  | "workflows"
  | "workers_scripts"
  | "workers_routes";

interface CliArgs {
  readonly help?: boolean;
  readonly url?: string;
  readonly sessionTokenFile?: string;
  readonly sessionToken?: string;
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly prefix: readonly string[];
  readonly write?: boolean;
  readonly verifyAfterWrite?: boolean;
  readonly json?: boolean;
}

export interface CloudExtensionTestResourceCleanupOptions {
  readonly url: string;
  readonly sessionToken: string;
  readonly sessionTokenSource: "env" | "file";
  readonly accountId: string;
  readonly zoneId: string;
  readonly prefixes: readonly string[];
  readonly write: boolean;
  readonly verifyAfterWrite: boolean;
  readonly json: boolean;
}

interface ResourceCollection {
  readonly kind: ResourceKind;
  readonly label: string;
  readonly collectionPath: (
    options: CloudExtensionTestResourceCleanupOptions,
  ) => string;
  readonly deletePath: (
    options: CloudExtensionTestResourceCleanupOptions,
    deleteId: string,
  ) => string;
  readonly matchFields: readonly string[];
  readonly deleteFields: readonly string[];
}

export interface CleanupCandidate {
  readonly kind: ResourceKind;
  readonly label: string;
  readonly id: string;
  readonly name: string;
  readonly matchedField: string;
  readonly matchedValue: string;
  readonly deletePath: string;
}

export interface CleanupCollectionResult {
  readonly kind: ResourceKind;
  readonly label: string;
  readonly listPath: string;
  readonly listStatus: number;
  readonly listOk: boolean;
  readonly totalRows: number;
  readonly matchedRows: number;
  readonly candidates: readonly CleanupCandidate[];
  readonly deleted: readonly CleanupDeleteResult[];
  readonly skippedReason?: string;
  readonly error?: string;
}

export interface CleanupDeleteResult {
  readonly id: string;
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
  readonly summary: Record<string, unknown>;
}

export interface CloudExtensionTestResourceCleanupResult {
  readonly kind: "takosumi.cloud-extension-test-resource-cleanup@v1";
  readonly status: "passed" | "failed";
  readonly mode: "dry_run" | "write";
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly prefixes: readonly string[];
  readonly sessionTokenSource: "env" | "file";
  readonly totals: {
    readonly collections: number;
    readonly candidates: number;
    readonly deleted: number;
    readonly failedDeletes: number;
    readonly failedCollections: number;
    readonly remainingCandidates: number;
  };
  readonly collections: readonly CleanupCollectionResult[];
  readonly postWriteVerification?: CloudExtensionTestResourceCleanupVerification;
  readonly safety: string;
}

export interface CloudExtensionTestResourceCleanupVerification {
  readonly candidates: number;
  readonly collections: readonly CleanupCollectionVerification[];
}

export interface CleanupCollectionVerification {
  readonly kind: ResourceKind;
  readonly label: string;
  readonly listStatus: number;
  readonly listOk: boolean;
  readonly totalRows: number;
  readonly matchedRows: number;
  readonly skippedReason?: string;
}

const COLLECTIONS: readonly ResourceCollection[] = [
  {
    kind: "kv",
    label: "KV namespace",
    collectionPath: (options) =>
      `/accounts/${encodeURIComponent(options.accountId)}/storage/kv/namespaces`,
    deletePath: (options, id) =>
      `/accounts/${encodeURIComponent(options.accountId)}/storage/kv/namespaces/${encodeURIComponent(id)}`,
    matchFields: ["title", "name", "id"],
    deleteFields: ["id"],
  },
  {
    kind: "r2",
    label: "R2 bucket",
    collectionPath: (options) =>
      `/accounts/${encodeURIComponent(options.accountId)}/r2/buckets`,
    deletePath: (options, id) =>
      `/accounts/${encodeURIComponent(options.accountId)}/r2/buckets/${encodeURIComponent(id)}`,
    matchFields: ["name", "id"],
    deleteFields: ["name", "id"],
  },
  {
    kind: "d1",
    label: "D1 database",
    collectionPath: (options) =>
      `/accounts/${encodeURIComponent(options.accountId)}/d1/database`,
    deletePath: (options, id) =>
      `/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(id)}`,
    matchFields: ["name", "uuid", "id"],
    deleteFields: ["uuid", "id", "name"],
  },
  {
    kind: "queues",
    label: "Queue",
    collectionPath: (options) =>
      `/accounts/${encodeURIComponent(options.accountId)}/queues`,
    deletePath: (options, id) =>
      `/accounts/${encodeURIComponent(options.accountId)}/queues/${encodeURIComponent(id)}`,
    matchFields: ["queue_name", "name", "id"],
    deleteFields: ["id", "queue_id", "queue_name", "name"],
  },
  {
    kind: "workflows",
    label: "Workflow",
    collectionPath: (options) =>
      `/accounts/${encodeURIComponent(options.accountId)}/workflows`,
    deletePath: (options, id) =>
      `/accounts/${encodeURIComponent(options.accountId)}/workflows/${encodeURIComponent(id)}`,
    matchFields: ["workflow_name", "name", "id", "script_name"],
    deleteFields: ["workflow_name", "name", "id"],
  },
  {
    kind: "workers_routes",
    label: "Workers route",
    collectionPath: (options) =>
      `/zones/${encodeURIComponent(options.zoneId)}/workers/routes`,
    deletePath: (options, id) =>
      `/zones/${encodeURIComponent(options.zoneId)}/workers/routes/${encodeURIComponent(id)}`,
    matchFields: ["pattern", "script", "script_name", "id"],
    deleteFields: ["id"],
  },
  {
    kind: "workers_scripts",
    label: "Workers script",
    collectionPath: (options) =>
      `/accounts/${encodeURIComponent(options.accountId)}/workers/scripts`,
    deletePath: (options, id) =>
      `/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(id)}`,
    matchFields: ["script_name", "name", "id"],
    deleteFields: ["script_name", "name", "id"],
  },
] as const;

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(exitCode);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const options = await resolveOptions(args, process.env);
  const result = await runCloudExtensionTestResourceCleanup(options);
  printResult(result, options);
  return result.status === "passed" ? 0 : 1;
}

export async function resolveOptions(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): Promise<CloudExtensionTestResourceCleanupOptions> {
  const url = normalizeBaseUrl(
    args.url ?? env.TAKOSUMI_PLATFORM_URL ?? DEFAULT_URL,
  );
  const accountId =
    optionalString(
      args.accountId ?? env.TAKOSUMI_CLOUDFLARE_COMPAT_ACCOUNT_ID,
    ) ?? DEFAULT_COMPAT_ACCOUNT_ID;
  const zoneId =
    optionalString(args.zoneId ?? env.TAKOSUMI_CLOUDFLARE_COMPAT_ZONE_ID) ??
    DEFAULT_COMPAT_ZONE_ID;
  const prefixes =
    args.prefix.length > 0
      ? args.prefix.map((prefix) => {
          const trimmed = prefix.trim();
          if (!trimmed) throw new Error("--prefix cannot be empty");
          return trimmed;
        })
      : [...DEFAULT_CLOUD_EXTENSION_TEST_PREFIXES];
  const explicitToken = optionalString(
    args.sessionToken ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN,
  );
  if (explicitToken) {
    return {
      url,
      sessionToken: explicitToken,
      sessionTokenSource: "env",
      accountId,
      zoneId,
      prefixes,
      write: args.write === true,
      verifyAfterWrite: args.verifyAfterWrite !== false,
      json: args.json === true,
    };
  }

  const tokenFile =
    optionalString(
      args.sessionTokenFile ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE,
    ) ??
    ((await Bun.file(DEFAULT_SESSION_TOKEN_FILE).exists())
      ? DEFAULT_SESSION_TOKEN_FILE
      : undefined);
  if (!tokenFile) {
    throw new Error(
      "--session-token-file, --session-token, TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE, or TAKOSUMI_ACCOUNT_SESSION_TOKEN is required",
    );
  }
  const token = (await Bun.file(tokenFile).text()).trim();
  if (!token) throw new Error("session token file is empty");
  return {
    url,
    sessionToken: token,
    sessionTokenSource: "file",
    accountId,
    zoneId,
    prefixes,
    write: args.write === true,
    verifyAfterWrite: args.verifyAfterWrite !== false,
    json: args.json === true,
  };
}

export async function runCloudExtensionTestResourceCleanup(
  options: CloudExtensionTestResourceCleanupOptions,
  fetchImpl: FetchLike = fetch,
): Promise<CloudExtensionTestResourceCleanupResult> {
  const collections: CleanupCollectionResult[] = [];
  for (const collection of COLLECTIONS) {
    collections.push(await processCollection(collection, options, fetchImpl));
  }
  const candidates = collections.reduce(
    (sum, collection) => sum + collection.matchedRows,
    0,
  );
  const deleted = collections.reduce(
    (sum, collection) =>
      sum + collection.deleted.filter((result) => result.ok).length,
    0,
  );
  const failedDeletes = collections.reduce(
    (sum, collection) =>
      sum + collection.deleted.filter((result) => !result.ok).length,
    0,
  );
  const failedCollections = collections.filter(
    (collection) =>
      !collection.listOk &&
      collection.skippedReason !== "collection_unavailable",
  ).length;
  const postWriteVerification =
    options.write && options.verifyAfterWrite
      ? await verifyRemainingCandidates(options, fetchImpl)
      : undefined;
  const remainingCandidates = options.write
    ? (postWriteVerification?.candidates ?? 0)
    : candidates;
  return {
    kind: "takosumi.cloud-extension-test-resource-cleanup@v1",
    status:
      failedDeletes === 0 &&
      failedCollections === 0 &&
      (!options.write || remainingCandidates === 0)
        ? "passed"
        : "failed",
    mode: options.write ? "write" : "dry_run",
    generatedAt: new Date().toISOString(),
    serviceUrl: options.url,
    accountId: options.accountId,
    zoneId: options.zoneId,
    prefixes: options.prefixes,
    sessionTokenSource: options.sessionTokenSource,
    totals: {
      collections: collections.length,
      candidates,
      deleted,
      failedDeletes,
      failedCollections,
      remainingCandidates,
    },
    collections,
    ...(postWriteVerification ? { postWriteVerification } : {}),
    safety:
      "Only resources whose public Cloudflare-compatible names match the configured Takosumi test prefixes are candidates. Dry-run is default; DELETE is sent only with --write.",
  };
}

async function processCollection(
  collection: ResourceCollection,
  options: CloudExtensionTestResourceCleanupOptions,
  fetchImpl: FetchLike,
): Promise<CleanupCollectionResult> {
  const listPath = collection.collectionPath(options);
  try {
    const response = await fetchImpl(compatUrl(options, listPath), {
      headers: requestHeaders(options),
    });
    const body = await readJson(response);
    const envelope = record(body);
    const rows =
      response.ok && envelope.success !== false
        ? extractRows(envelope.result)
        : [];
    const candidates = selectCleanupCandidates(
      collection,
      options,
      rows,
      options.prefixes,
    );
    const deleted = options.write
      ? await deleteCandidates(options, fetchImpl, candidates)
      : [];
    const collectionUnavailable =
      !response.ok && (response.status === 404 || response.status === 501);
    return {
      kind: collection.kind,
      label: collection.label,
      listPath,
      listStatus: response.status,
      listOk: response.ok && envelope.success !== false,
      totalRows: rows.length,
      matchedRows: candidates.length,
      candidates,
      deleted,
      skippedReason: collectionUnavailable
        ? "collection_unavailable"
        : options.write
          ? undefined
          : "dry_run",
    };
  } catch (error) {
    return {
      kind: collection.kind,
      label: collection.label,
      listPath,
      listStatus: 0,
      listOk: false,
      totalRows: 0,
      matchedRows: 0,
      candidates: [],
      deleted: [],
      error: sanitizeError(error),
    };
  }
}

export function selectCleanupCandidates(
  collection: ResourceCollection,
  options: Pick<
    CloudExtensionTestResourceCleanupOptions,
    "accountId" | "zoneId"
  >,
  rows: readonly Record<string, unknown>[],
  prefixes: readonly string[],
): readonly CleanupCandidate[] {
  const candidates: CleanupCandidate[] = [];
  for (const row of rows) {
    const match = firstPrefixedField(row, collection.matchFields, prefixes);
    if (!match) continue;
    const deleteId = firstStringField(row, collection.deleteFields);
    if (!deleteId) continue;
    const name =
      firstStringField(row, collection.matchFields) ?? match.value ?? deleteId;
    candidates.push({
      kind: collection.kind,
      label: collection.label,
      id: deleteId,
      name,
      matchedField: match.field,
      matchedValue: match.value,
      deletePath: collection.deletePath(
        {
          url: "",
          sessionToken: "",
          sessionTokenSource: "env",
          accountId: options.accountId,
          zoneId: options.zoneId,
          prefixes,
          write: false,
          verifyAfterWrite: false,
          json: false,
        },
        deleteId,
      ),
    });
  }
  return candidates;
}

async function deleteCandidates(
  options: CloudExtensionTestResourceCleanupOptions,
  fetchImpl: FetchLike,
  candidates: readonly CleanupCandidate[],
): Promise<readonly CleanupDeleteResult[]> {
  const deleted: CleanupDeleteResult[] = [];
  for (const candidate of candidates) {
    const response = await fetchImpl(compatUrl(options, candidate.deletePath), {
      method: "DELETE",
      headers: requestHeaders(options),
    });
    const body = await readJson(response);
    const envelope = record(body);
    deleted.push({
      id: candidate.id,
      path: candidate.deletePath,
      status: response.status,
      ok: response.ok && envelope.success !== false,
      summary: summarizeEnvelope(body),
    });
  }
  return deleted;
}

async function verifyRemainingCandidates(
  options: CloudExtensionTestResourceCleanupOptions,
  fetchImpl: FetchLike,
): Promise<CloudExtensionTestResourceCleanupVerification> {
  const verifyOptions: CloudExtensionTestResourceCleanupOptions = {
    ...options,
    write: false,
    verifyAfterWrite: false,
  };
  const collections = await Promise.all(
    COLLECTIONS.map((collection) =>
      processCollection(collection, verifyOptions, fetchImpl),
    ),
  );
  return {
    candidates: collections.reduce(
      (sum, collection) => sum + collection.matchedRows,
      0,
    ),
    collections: collections.map((collection) => ({
      kind: collection.kind,
      label: collection.label,
      listStatus: collection.listStatus,
      listOk: collection.listOk,
      totalRows: collection.totalRows,
      matchedRows: collection.matchedRows,
      ...(collection.skippedReason
        ? { skippedReason: collection.skippedReason }
        : {}),
    })),
  };
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: {
    help?: boolean;
    url?: string;
    sessionTokenFile?: string;
    sessionToken?: string;
    accountId?: string;
    zoneId?: string;
    prefix: string[];
    write?: boolean;
    verifyAfterWrite?: boolean;
    json?: boolean;
  } = { prefix: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--url":
        args.url = takeValue(argv, ++index, arg);
        break;
      case "--session-token-file":
        args.sessionTokenFile = takeValue(argv, ++index, arg);
        break;
      case "--session-token":
        args.sessionToken = takeValue(argv, ++index, arg);
        break;
      case "--account-id":
        args.accountId = takeValue(argv, ++index, arg);
        break;
      case "--zone-id":
        args.zoneId = takeValue(argv, ++index, arg);
        break;
      case "--prefix":
        args.prefix.push(takeValue(argv, ++index, arg));
        break;
      case "--write":
        args.write = true;
        break;
      case "--no-verify":
        args.verifyAfterWrite = false;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function takeValue(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requestHeaders(
  options: CloudExtensionTestResourceCleanupOptions,
): Record<string, string> {
  return {
    authorization: `Bearer ${options.sessionToken}`,
    accept: "application/json",
  };
}

function compatUrl(
  options: CloudExtensionTestResourceCleanupOptions,
  path: string,
): string {
  return `${options.url}/compat/cloudflare/client/v4${path}`;
}

function extractRows(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) return input.map(record);
  const value = record(input);
  for (const key of [
    "resources",
    "items",
    "buckets",
    "databases",
    "queues",
    "workflows",
    "scripts",
    "routes",
  ]) {
    const child = value[key];
    if (Array.isArray(child)) return child.map(record);
  }
  return [];
}

function firstPrefixedField(
  row: Record<string, unknown>,
  fields: readonly string[],
  prefixes: readonly string[],
): { readonly field: string; readonly value: string } | null {
  for (const field of fields) {
    const value = row[field];
    if (typeof value !== "string") continue;
    if (prefixes.some((prefix) => value.startsWith(prefix))) {
      return { field, value };
    }
  }
  return null;
}

function firstStringField(
  row: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { nonJsonBody: true, status: response.status };
  }
}

function summarizeEnvelope(input: unknown): Record<string, unknown> {
  const body = record(input);
  const errors = Array.isArray(body.errors)
    ? body.errors.map((error) => {
        const row = record(error);
        return {
          code: row.code,
          message: typeof row.message === "string" ? "redacted" : undefined,
        };
      })
    : [];
  return {
    success: body.success,
    errors,
  };
}

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function optionalString(input: string | undefined): string | undefined {
  const value = input?.trim();
  return value ? value : undefined;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

function printResult(
  result: CloudExtensionTestResourceCleanupResult,
  options: CloudExtensionTestResourceCleanupOptions,
): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Takosumi Cloud extension test resource cleanup (${result.mode})`,
  );
  console.log(`service: ${result.serviceUrl}`);
  console.log(`prefixes: ${result.prefixes.join(", ")}`);
  console.log(
    `candidates: ${result.totals.candidates}, deleted: ${result.totals.deleted}, failed collections: ${result.totals.failedCollections}`,
  );
  if (result.postWriteVerification) {
    console.log(
      `post-write remaining candidates: ${result.postWriteVerification.candidates}`,
    );
  }
  for (const collection of result.collections) {
    console.log(
      `- ${collection.label}: status ${collection.listStatus}, matched ${collection.matchedRows}/${collection.totalRows}`,
    );
    for (const candidate of collection.candidates) {
      console.log(`  ${candidate.name} -> ${candidate.deletePath}`);
    }
  }
  if (!options.write && result.totals.candidates > 0) {
    console.log("Run again with --write to delete only the listed candidates.");
  }
}

function printHelp(): void {
  console.log(`Usage:
  bun run cleanup:cloud-extension-test-resources -- [options]

Default mode is dry-run. It only lists Takosumi smoke/test resources.

Options:
  --url <origin>                 default: ${DEFAULT_URL}
  --session-token-file <path>    default: ${DEFAULT_SESSION_TOKEN_FILE} when present
  --session-token <token>        or TAKOSUMI_ACCOUNT_SESSION_TOKEN
  --account-id <id>              default: ${DEFAULT_COMPAT_ACCOUNT_ID}
  --zone-id <id>                 default: ${DEFAULT_COMPAT_ZONE_ID}
  --prefix <prefix>              repeatable; overrides default Takosumi test prefixes
  --write                        send DELETE requests for listed candidates
  --no-verify                    skip post-write re-list verification
  --json                         print JSON only
`);
}
