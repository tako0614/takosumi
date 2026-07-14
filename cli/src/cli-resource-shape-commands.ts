import { readFile } from "node:fs/promises";
import { isResourceShapeKind } from "takosumi-contract";
import { requestDeployControlApi } from "./cli-deploy-control-api.ts";
import {
  resourcesHelpText,
  spacePoliciesHelpText,
  targetPoolsHelpText,
} from "./cli-help.ts";
import type { CliIo } from "./cli-io.ts";
import {
  booleanOption,
  optionalIntegerOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import { isRecord, stringValue } from "./cli-util.ts";

type Options = Record<string, string | boolean>;

export async function runResources(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (!command || isHelpRequest(args)) {
    io.stdout(resourcesHelpText());
    return 0;
  }
  try {
    switch (command) {
      case "list":
        return await runResourcesList(rest, io);
      case "get":
        return await runResourceGet(rest, io);
      case "events":
        return await runResourceEvents(rest, io);
      case "preview":
        return await runResourcePreview(rest, io);
      case "apply":
        return await runResourceApply(rest, io);
      case "import":
        return await runResourceImport(rest, io);
      case "observe":
        return await runResourceAction("observe", rest, io);
      case "refresh":
        return await runResourceAction("refresh", rest, io);
      case "delete":
        return await runResourceDelete(rest, io);
      default:
        io.stderr(`Unknown resources command: ${command}`);
        io.stderr(resourcesHelpText());
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

export async function runTargetPools(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || isHelpRequest(args)) {
    io.stdout(targetPoolsHelpText());
    return 0;
  }
  try {
    switch (command) {
      case "list":
        return await runTargetPoolsList(rest, io);
      case "get":
        return await runTargetPoolGet(rest, io);
      case "put":
        return await runTargetPoolPut(rest, io);
      case "delete":
        return await runTargetPoolDelete(rest, io);
      default:
        io.stderr(`Unknown target-pools command: ${command}`);
        io.stderr(targetPoolsHelpText());
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

export async function runSpacePolicies(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || isHelpRequest(args)) {
    io.stdout(spacePoliciesHelpText());
    return 0;
  }
  try {
    switch (command) {
      case "list":
        return await runSpacePoliciesList(rest, io);
      case "get":
        return await runSpacePolicyGet(rest, io);
      case "put":
        return await runSpacePolicyPut(rest, io);
      case "delete":
        return await runSpacePolicyDelete(rest, io);
      default:
        io.stderr(`Unknown space-policies command: ${command}`);
        io.stderr(spacePoliciesHelpText());
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

async function runSpacePoliciesList(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: withPageQuery("/v1/space-policies", options),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatSpacePolicyList(response),
  );
  return 0;
}

async function runSpacePolicyGet(args: string[], io: CliIo): Promise<number> {
  const [name, ...optionArgs] = args;
  requireName(name, "SpacePolicy name");
  const options = parseOptions(optionArgs);
  const response = await requestDeployControlApi({
    path: withSpaceQuery(
      `/v1/space-policies/${encodeURIComponent(name)}`,
      options,
    ),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatNamedRecord("SpacePolicy", response, name),
  );
  return 0;
}

async function runSpacePolicyPut(args: string[], io: CliIo): Promise<number> {
  const [name, ...optionArgs] = args;
  requireName(name, "SpacePolicy name");
  const options = parseOptions(optionArgs);
  const response = await requestDeployControlApi({
    path: `/v1/space-policies/${encodeURIComponent(name)}`,
    method: "PUT",
    body: await readJsonObjectOption(options),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatNamedRecord("SpacePolicy", response, name),
  );
  return 0;
}

async function runSpacePolicyDelete(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [name, ...optionArgs] = args;
  requireName(name, "SpacePolicy name");
  const options = parseOptions(optionArgs);
  await requestDeployControlApi({
    path: withSpaceQuery(
      `/v1/space-policies/${encodeURIComponent(name)}`,
      options,
    ),
    method: "DELETE",
    options,
    allowEmpty: true,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson({ deleted: true, name, space: requiredSpace(options) })
      : `SpacePolicy ${name} deleted`,
  );
  return 0;
}

async function runResourcesList(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: withPageQuery("/v1/resources", options),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatResourceList(response),
  );
  return 0;
}

async function runResourceGet(args: string[], io: CliIo): Promise<number> {
  const { kind, name, options } = resourceIdentity(args);
  const response = await requestDeployControlApi({
    path: withSpaceQuery(resourcePath(kind, name), options),
    options,
  });
  io.stdout(formatResourceResult(response, options));
  return 0;
}

async function runResourceEvents(args: string[], io: CliIo): Promise<number> {
  const { kind, name, options } = resourceIdentity(args);
  const response = await requestDeployControlApi({
    path: withPageQuery(`${resourcePath(kind, name)}/events`, options),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatResourceEvents(response),
  );
  return 0;
}

async function runResourcePreview(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: "/v1/resources/preview",
    method: "POST",
    body: await readJsonObjectOption(options),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatResourcePreview(response),
  );
  return 0;
}

async function runResourceApply(args: string[], io: CliIo): Promise<number> {
  const { kind, name, options } = resourceIdentity(args);
  const body = await readJsonObjectOption(options);
  const preview = await requestDeployControlApi({
    path: "/v1/resources/preview",
    method: "POST",
    body,
    options,
  });
  if (!booleanOption(options, "yes")) {
    io.stdout(
      booleanOption(options, "json")
        ? formatJson(preview)
        : formatResourcePreview(preview),
    );
    io.stderr(
      "Review the plan and price, then rerun resources apply with --yes.",
    );
    return 2;
  }
  const response = await requestDeployControlApi({
    path: resourcePath(kind, name),
    method: "PUT",
    body: { ...body, review: deploymentReviewFromPreview(preview) },
    options,
  });
  io.stdout(formatResourceResult(response, options));
  return 0;
}

async function runResourceImport(args: string[], io: CliIo): Promise<number> {
  return await runResourceWrite("POST", "import", args, io);
}

async function runResourceWrite(
  method: "PUT" | "POST",
  suffix: "import" | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  const { kind, name, options } = resourceIdentity(args);
  const base = resourcePath(kind, name);
  const response = await requestDeployControlApi({
    path: suffix ? `${base}/${suffix}` : base,
    method,
    body: await readJsonObjectOption(options),
    options,
  });
  io.stdout(formatResourceResult(response, options));
  return 0;
}

async function runResourceAction(
  action: "observe" | "refresh",
  args: string[],
  io: CliIo,
): Promise<number> {
  const { kind, name, options } = resourceIdentity(args);
  const response = await requestDeployControlApi({
    path: withSpaceQuery(`${resourcePath(kind, name)}/${action}`, options),
    method: "POST",
    options,
  });
  io.stdout(formatResourceResult(response, options));
  return 0;
}

async function runResourceDelete(args: string[], io: CliIo): Promise<number> {
  const { kind, name, options } = resourceIdentity(args);
  const query = new URLSearchParams({ space: requiredSpace(options) });
  if (booleanOption(options, "force")) query.set("force", "true");
  await requestDeployControlApi({
    path: `${resourcePath(kind, name)}?${query.toString()}`,
    method: "DELETE",
    options,
    allowEmpty: true,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson({ deleted: true, kind, name, space: requiredSpace(options) })
      : `Resource ${kind}/${name} deleted`,
  );
  return 0;
}

async function runTargetPoolsList(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: withPageQuery("/v1/target-pools", options),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatTargetPoolList(response),
  );
  return 0;
}

async function runTargetPoolGet(args: string[], io: CliIo): Promise<number> {
  const [name, ...optionArgs] = args;
  requireName(name, "TargetPool name");
  const options = parseOptions(optionArgs);
  const response = await requestDeployControlApi({
    path: withSpaceQuery(
      `/v1/target-pools/${encodeURIComponent(name)}`,
      options,
    ),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatNamedRecord("TargetPool", response, name),
  );
  return 0;
}

async function runTargetPoolPut(args: string[], io: CliIo): Promise<number> {
  const [name, ...optionArgs] = args;
  requireName(name, "TargetPool name");
  const options = parseOptions(optionArgs);
  const response = await requestDeployControlApi({
    path: `/v1/target-pools/${encodeURIComponent(name)}`,
    method: "PUT",
    body: await readJsonObjectOption(options),
    options,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson(response)
      : formatNamedRecord("TargetPool", response, name),
  );
  return 0;
}

async function runTargetPoolDelete(args: string[], io: CliIo): Promise<number> {
  const [name, ...optionArgs] = args;
  requireName(name, "TargetPool name");
  const options = parseOptions(optionArgs);
  await requestDeployControlApi({
    path: withSpaceQuery(
      `/v1/target-pools/${encodeURIComponent(name)}`,
      options,
    ),
    method: "DELETE",
    options,
    allowEmpty: true,
  });
  io.stdout(
    booleanOption(options, "json")
      ? formatJson({ deleted: true, name, space: requiredSpace(options) })
      : `TargetPool ${name} deleted`,
  );
  return 0;
}

function resourceIdentity(args: string[]): {
  readonly kind: string;
  readonly name: string;
  readonly options: Options;
} {
  const [kind, name, ...optionArgs] = args;
  if (!kind || kind.startsWith("--") || !isResourceShapeKind(kind)) {
    throw new TypeError("Resource kind is required and must be a valid token");
  }
  requireName(name, "Resource name");
  return { kind, name, options: parseOptions(optionArgs) };
}

function resourcePath(kind: string, name: string): string {
  return `/v1/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
}

function withSpaceQuery(path: string, options: Options): string {
  return `${path}?${new URLSearchParams({ space: requiredSpace(options) }).toString()}`;
}

function withPageQuery(path: string, options: Options): string {
  const query = new URLSearchParams({ space: requiredSpace(options) });
  const limit = optionalIntegerOption(options, "limit");
  const cursor = optionalStringOption(options, "cursor");
  if (limit !== undefined) query.set("limit", String(limit));
  if (cursor !== undefined) query.set("cursor", cursor);
  return `${path}?${query.toString()}`;
}

function requiredSpace(options: Options): string {
  const space = optionalStringOption(options, "space");
  if (!space) throw new TypeError("--space is required");
  return space;
}

function requireName(
  value: string | undefined,
  label: string,
): asserts value is string {
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${label} is required`);
  }
}

async function readJsonObjectOption(
  options: Options,
): Promise<Record<string, unknown>> {
  const file = optionalStringOption(options, "file");
  if (!file) throw new TypeError("--file is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new TypeError("--file must contain valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new TypeError("--file must contain a JSON object");
  }
  return parsed;
}

function formatResourceResult(response: unknown, options: Options): string {
  if (booleanOption(options, "json")) return formatJson(response);
  const resource =
    isRecord(response) && isRecord(response.resource)
      ? response.resource
      : response;
  if (!isRecord(resource)) return "Resource operation completed";
  const metadata = isRecord(resource.metadata) ? resource.metadata : {};
  const status = isRecord(resource.status) ? resource.status : {};
  const resolution = isRecord(status.resolution) ? status.resolution : {};
  const kind = stringValue(resource.kind) ?? "Resource";
  const name = stringValue(metadata.name) ?? "unknown";
  const lines = [
    `Resource ${kind}/${name}: ${stringValue(status.phase) ?? "unknown"}`,
  ];
  const id = isRecord(response) ? stringValue(response.id) : undefined;
  if (id) lines.push(`  id: ${id}`);
  const target = stringValue(resolution.target);
  if (target) lines.push(`  target: ${target}`);
  const operation = operationSummary(response);
  if (operation) lines.push(`  ${operation}`);
  return lines.join("\n");
}

function operationSummary(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  for (const key of ["import", "observation", "refresh"] as const) {
    const detail = response[key];
    if (!isRecord(detail)) continue;
    const summary = stringValue(detail.summary);
    const runId = stringValue(detail.runId);
    return [summary, runId ? `run ${runId}` : undefined]
      .filter((value): value is string => value !== undefined)
      .join("; ");
  }
  return undefined;
}

function formatResourcePreview(response: unknown): string {
  if (!isRecord(response)) return "Resource preview completed";
  const resource = isRecord(response.resource) ? response.resource : {};
  const metadata = isRecord(resource.metadata) ? resource.metadata : {};
  const lines = [
    `Resource preview ${stringValue(resource.kind) ?? "Resource"}/${
      stringValue(metadata.name) ?? "unknown"
    }`,
  ];
  const target = stringValue(response.selectedTarget);
  const implementation = stringValue(response.selectedImplementation);
  if (target) lines.push(`  target: ${target}`);
  if (implementation) lines.push(`  implementation: ${implementation}`);
  const quote = isRecord(response.quote) ? response.quote : undefined;
  if (quote) {
    const amount = quote.estimatedTotalUsdMicros;
    const currency = stringValue(quote.currency) ?? "USD";
    if (typeof amount === "number" && Number.isSafeInteger(amount)) {
      lines.push(
        `  estimated price: ${currency} ${(amount / 1_000_000).toFixed(6)}`,
      );
    }
    const expiresAt = stringValue(quote.expiresAt);
    if (expiresAt) lines.push(`  quote expires: ${expiresAt}`);
  }
  if (Array.isArray(response.riskNotes)) {
    lines.push(`  risk notes: ${response.riskNotes.length}`);
  }
  return lines.join("\n");
}

function deploymentReviewFromPreview(preview: unknown): Record<string, string> {
  if (!isRecord(preview)) {
    throw new Error("Takosumi Deploy API returned an invalid preview");
  }
  const planDigest = stringValue(preview.planDigest);
  if (!planDigest) {
    throw new Error("Takosumi Deploy API preview omitted planDigest");
  }
  const review: Record<string, string> = { planDigest };
  if (preview.quote !== undefined) {
    if (!isRecord(preview.quote)) {
      throw new Error("Takosumi Deploy API returned invalid quote evidence");
    }
    const quoteId = stringValue(preview.quote.quoteId);
    const quoteDigest = stringValue(preview.quote.quoteDigest);
    if (!quoteId || !quoteDigest) {
      throw new Error("Takosumi Deploy API returned incomplete quote evidence");
    }
    review.quoteId = quoteId;
    review.quoteDigest = quoteDigest;
  }
  return review;
}

function formatResourceList(response: unknown): string {
  const resources = arrayField(response, "resources");
  if (resources.length === 0) return "No Resources found.";
  const lines = ["Resources:"];
  for (const value of resources) {
    if (!isRecord(value)) continue;
    const metadata = isRecord(value.metadata) ? value.metadata : {};
    const status = isRecord(value.status) ? value.status : {};
    lines.push(
      `  ${stringValue(value.kind) ?? "Resource"}/${
        stringValue(metadata.name) ?? "unknown"
      }  ${stringValue(status.phase) ?? "unknown"}`,
    );
  }
  lines.push(`${resources.length} Resource(s)`);
  appendNextCursor(lines, response);
  return lines.join("\n");
}

function formatResourceEvents(response: unknown): string {
  const events = arrayField(response, "events");
  if (events.length === 0) return "No Resource events found.";
  const lines = ["Resource events:"];
  for (const value of events) {
    if (!isRecord(value)) continue;
    const runId = stringValue(value.runId);
    lines.push(
      `  ${stringValue(value.createdAt) ?? "unknown-time"}  ${
        stringValue(value.action) ?? "unknown-action"
      }${runId ? `  run ${runId}` : ""}`,
    );
  }
  lines.push(`${events.length} event(s)`);
  appendNextCursor(lines, response);
  return lines.join("\n");
}

function formatTargetPoolList(response: unknown): string {
  const pools = arrayField(response, "targetPools");
  if (pools.length === 0) return "No TargetPools found.";
  const lines = ["TargetPools:"];
  for (const value of pools) {
    if (!isRecord(value)) continue;
    const spec = isRecord(value.spec) ? value.spec : {};
    const targets = Array.isArray(spec.targets) ? spec.targets.length : 0;
    lines.push(
      `  ${stringValue(value.name) ?? "unknown"}  ${targets} target(s)`,
    );
  }
  lines.push(`${pools.length} TargetPool(s)`);
  appendNextCursor(lines, response);
  return lines.join("\n");
}

function formatSpacePolicyList(response: unknown): string {
  const policies = arrayField(response, "spacePolicies");
  if (policies.length === 0) return "No SpacePolicies found.";
  const lines = ["SpacePolicies:"];
  for (const value of policies) {
    if (!isRecord(value)) continue;
    lines.push(`  ${stringValue(value.name) ?? "unknown"}`);
  }
  lines.push(`${policies.length} SpacePolicy record(s)`);
  appendNextCursor(lines, response);
  return lines.join("\n");
}

function formatNamedRecord(
  kind: "TargetPool" | "SpacePolicy",
  response: unknown,
  fallbackName: string,
): string {
  const record = isRecord(response) ? response : {};
  const name = stringValue(record.name) ?? fallbackName;
  const space = stringValue(record.spaceId);
  return `${kind} ${name}${space ? ` in ${space}` : ""}`;
}

function arrayField(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function appendNextCursor(lines: string[], response: unknown): void {
  if (!isRecord(response)) return;
  const cursor = stringValue(response.nextCursor);
  if (cursor) lines.push(`next cursor: ${cursor}`);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isHelpRequest(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}
