import { readFile } from "node:fs/promises";
import { requestDeployControlApi } from "./cli-deploy-control-api.ts";
import { formActivationsHelpText } from "./cli-help.ts";
import type { CliIo } from "./cli-io.ts";
import {
  booleanOption,
  optionalIntegerOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";

type Options = Record<string, string | boolean>;

export async function runFormActivations(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || args.includes("--help") || args.includes("-h")) {
    io.stdout(formActivationsHelpText());
    return 0;
  }
  try {
    switch (command) {
      case "list":
        return await list(rest, io);
      case "get":
        return await get(rest, io);
      case "create":
        return await create(rest, io);
      case "update":
        return await update(rest, io);
      default:
        io.stderr(`Unknown form-activations command: ${command}`);
        io.stderr(formActivationsHelpText());
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

async function list(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const query = new URLSearchParams();
  const limit = optionalIntegerOption(options, "limit");
  const cursor = optionalStringOption(options, "cursor");
  if (limit !== undefined) query.set("limit", String(limit));
  if (cursor) query.set("cursor", cursor);
  const response = await requestDeployControlApi({
    path: `/v1/form-activations${query.size > 0 ? `?${query}` : ""}`,
    options,
  });
  io.stdout(formatList(response, booleanOption(options, "json")));
  return 0;
}

async function get(args: string[], io: CliIo): Promise<number> {
  const [id, ...optionArgs] = args;
  requireId(id);
  const options = parseOptions(optionArgs);
  const response = await requestDeployControlApi({
    path: activationPath(id),
    options,
  });
  io.stdout(formatActivation(response, booleanOption(options, "json")));
  return 0;
}

async function create(args: string[], io: CliIo): Promise<number> {
  const options = parseOptions(args);
  const response = await requestDeployControlApi({
    path: "/v1/form-activations",
    method: "POST",
    body: await readRequest(options),
    options,
  });
  io.stdout(formatActivation(response, booleanOption(options, "json")));
  return 0;
}

async function update(args: string[], io: CliIo): Promise<number> {
  const [id, ...optionArgs] = args;
  requireId(id);
  const options = parseOptions(optionArgs);
  const response = await requestDeployControlApi({
    path: activationPath(id),
    method: "PATCH",
    body: await readRequest(options),
    options,
  });
  io.stdout(formatActivation(response, booleanOption(options, "json")));
  return 0;
}

async function readRequest(options: Options): Promise<Record<string, unknown>> {
  const path = optionalStringOption(options, "file");
  if (!path) throw new TypeError("--file is required");
  const value = parseJson(await readFile(path, "utf8"));
  if (!isRecord(value))
    throw new TypeError("--file must contain a JSON object");
  return value;
}

function activationPath(id: string): string {
  return `/v1/form-activations/${encodeURIComponent(id)}`;
}

function requireId(value: string | undefined): asserts value is string {
  if (!value || value.startsWith("--")) {
    throw new TypeError("FormActivation id is required");
  }
}

function formatList(value: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(value, null, 2);
  const activations =
    isRecord(value) && Array.isArray(value.activations)
      ? value.activations
      : [];
  if (activations.length === 0) return "No FormActivations found.";
  return [
    "FormActivations:",
    ...activations.map((activation) => `  ${summary(activation)}`),
    `${activations.length} activation(s)`,
  ].join("\n");
}

function formatActivation(value: unknown, asJson: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : summary(value);
}

function summary(value: unknown): string {
  if (!isRecord(value)) return "Invalid FormActivation response";
  const identity = isRecord(value.identity) ? value.identity : {};
  const formRef = isRecord(identity.formRef) ? identity.formRef : {};
  const apiVersion = stringValue(formRef.apiVersion) ?? "unknown-api";
  const kind = stringValue(formRef.kind) ?? "unknown-kind";
  const version = stringValue(formRef.definitionVersion) ?? "unknown-version";
  const revision =
    typeof value.revision === "number" ? String(value.revision) : "?";
  return `${stringValue(value.id) ?? "unknown"}  ${
    stringValue(value.status) ?? "unknown"
  }  r${revision}  ${apiVersion}/${kind}@${version}`;
}
