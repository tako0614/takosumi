import { readFile } from "node:fs/promises";
import {
  booleanOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import {
  connectionsCreateHelpText,
  connectionsHelpText,
  connectionsListHelpText,
  connectionsRevokeHelpText,
  connectionsTestHelpText,
} from "./cli-help.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";
import type { CliIo } from "./cli-io.ts";
import { requestDeployControlApi } from "./cli-deploy-control-api.ts";
import {
  CONNECTIONS_PATH,
  type CreateConnectionFile,
} from "takosumi-contract/connections";

export async function runConnections(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    io.stdout(connectionsHelpText());
    return 0;
  }
  if (command === "list") return await runConnectionsList(rest, io);
  if (command === "create") return await runConnectionsCreate(rest, io);
  if (command === "test") return await runConnectionsTest(rest, io);
  if (command === "revoke") return await runConnectionsRevoke(rest, io);
  io.stderr(`Unknown connections command: ${command}`);
  io.stderr(connectionsHelpText());
  return 2;
}

export async function runConnectionsList(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(connectionsListHelpText());
    return 0;
  }
  try {
    const response = await requestDeployControlApi({
      path: CONNECTIONS_PATH,
      options,
    });
    io.stdout(formatConnectionsList(response, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runConnectionsCreate(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(connectionsCreateHelpText());
    return 0;
  }
  try {
    const body = await connectionCreateBody(options);
    const response = await requestDeployControlApi({
      path: CONNECTIONS_PATH,
      method: "POST",
      body,
      options,
    });
    io.stdout(formatConnectionCreate(response, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return error instanceof TypeError ? 2 : 1;
  }
}

export async function runConnectionsTest(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [connectionId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(connectionsTestHelpText());
    return 0;
  }
  if (!connectionId || connectionId.startsWith("--")) {
    io.stderr("connection id is required");
    return 2;
  }
  try {
    const response = await requestDeployControlApi({
      path: `${CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}/test`,
      method: "POST",
      body: {},
      options,
    });
    io.stdout(formatConnectionTest(response, booleanOption(options, "json")));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runConnectionsRevoke(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [connectionId, ...rest] = args;
  const options = parseOptions(rest);
  if (options.help) {
    io.stdout(connectionsRevokeHelpText());
    return 0;
  }
  if (!connectionId || connectionId.startsWith("--")) {
    io.stderr("connection id is required");
    return 2;
  }
  try {
    await requestDeployControlApi({
      path: `${CONNECTIONS_PATH}/${encodeURIComponent(connectionId)}/revoke`,
      method: "POST",
      body: {},
      options,
      allowEmpty: true,
    });
    io.stdout(
      booleanOption(options, "json")
        ? JSON.stringify({ revoked: true, connectionId }, null, 2)
        : `Connection ${connectionId} revoked`,
    );
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function connectionCreateBody(
  options: Record<string, string | boolean>,
): Promise<Record<string, unknown>> {
  const provider = optionalStringOption(options, "provider");
  if (!provider) throw new TypeError("--provider is required");
  if (provider.split("/").length < 3) {
    throw new TypeError("--provider must be a fully-qualified provider source");
  }
  const recipeId = optionalStringOption(options, "recipe");
  if (!recipeId) throw new TypeError("--recipe is required");
  const authMode = optionalStringOption(options, "authMode");
  if (!authMode) throw new TypeError("--auth-mode is required");
  const secretPartition = optionalStringOption(options, "secretPartition");
  if (!secretPartition) throw new TypeError("--secret-partition is required");
  const workspaceId = optionalStringOption(options, "workspace");
  const requestedScope = optionalStringOption(options, "scope");
  const scope = requestedScope ?? (workspaceId ? "workspace" : "operator");
  if (scope !== "workspace" && scope !== "operator") {
    throw new TypeError("--scope must be workspace or operator");
  }
  if (scope === "workspace" && !workspaceId) {
    throw new TypeError("--workspace is required for --scope workspace");
  }
  if (scope === "operator" && workspaceId) {
    throw new TypeError("--workspace cannot be combined with --scope operator");
  }
  const values = await optionalValuesFromOptions(options);
  const files = await filesFromOptions(options);
  if (Object.keys(values).length === 0 && files.length === 0) {
    throw new TypeError("--values-file or --files-file is required");
  }
  const displayName = optionalStringOption(options, "displayName");
  const expiresAt = optionalStringOption(options, "expiresAt");
  const scopeHints = await scopeHintsFromOptions(options);
  return {
    provider,
    ...(workspaceId ? { workspaceId } : {}),
    credentialRecipe: {
      id: recipeId,
      authMode,
      secretPartition,
    },
    scope,
    ...(displayName ? { displayName } : {}),
    ...(Object.keys(scopeHints).length > 0 ? { scopeHints } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    values,
    ...(files.length > 0 ? { files } : {}),
  };
}

async function optionalValuesFromOptions(
  options: Record<string, string | boolean>,
): Promise<Record<string, string>> {
  const valuesFile = optionalStringOption(options, "valuesFile");
  if (!valuesFile) return {};
  return await valuesFromOptions(options);
}

async function valuesFromOptions(
  options: Record<string, string | boolean>,
): Promise<Record<string, string>> {
  const valuesFile = optionalStringOption(options, "valuesFile");
  if (!valuesFile) {
    throw new TypeError("--values-file is required");
  }
  const parsed = parseJson(await readFile(valuesFile, "utf8"));
  if (!isRecord(parsed))
    throw new TypeError("--values-file must contain a JSON object");
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(
        `--values-file field ${key} must be a non-empty string`,
      );
    }
    output[key] = value;
  }
  if (Object.keys(output).length === 0) {
    throw new TypeError("--values-file must contain at least one value");
  }
  return output;
}

async function filesFromOptions(
  options: Record<string, string | boolean>,
): Promise<readonly CreateConnectionFile[]> {
  const filesFile = optionalStringOption(options, "filesFile");
  if (!filesFile) return [];
  const parsed = parseJson(await readFile(filesFile, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new TypeError("--files-file must contain a JSON array");
  }
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`--files-file entry ${index} must be an object`);
    }
    const path = stringValue(entry.path);
    const content = stringValue(entry.content);
    if (!path) {
      throw new TypeError(`--files-file entry ${index}.path is required`);
    }
    if (content === undefined) {
      throw new TypeError(`--files-file entry ${index}.content is required`);
    }
    const modeValue = entry.mode;
    const mode =
      modeValue === undefined
        ? undefined
        : typeof modeValue === "number" && Number.isInteger(modeValue)
          ? modeValue
          : undefined;
    if (modeValue !== undefined && mode === undefined) {
      throw new TypeError(
        `--files-file entry ${index}.mode must be an integer`,
      );
    }
    const envName = stringValue(entry.envName);
    return {
      path,
      content,
      ...(mode !== undefined ? { mode } : {}),
      ...(envName ? { envName } : {}),
    };
  });
}

async function scopeHintsFromOptions(
  options: Record<string, string | boolean>,
): Promise<Record<string, string>> {
  const scopeHintsFile = optionalStringOption(options, "scopeHintsFile");
  if (!scopeHintsFile) return {};
  const parsed = parseJson(await readFile(scopeHintsFile, "utf8"));
  if (!isRecord(parsed)) {
    throw new TypeError("--scope-hints-file must contain a JSON object");
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(
        `--scope-hints-file field ${key} must be a non-empty string`,
      );
    }
    output[key] = value;
  }
  return output;
}

function formatConnectionsList(response: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(response, null, 2);
  const connections =
    isRecord(response) && Array.isArray(response.connections)
      ? response.connections
      : [];
  if (connections.length === 0) return "No connections found.";
  const lines = ["Connections:"];
  for (const value of connections) {
    if (!isRecord(value)) continue;
    lines.push(
      `  ${stringValue(value.id) ?? "unknown"}  ${
        stringValue(value.scope) ?? "unknown-scope"
      }  ${stringValue(value.provider) ?? "unknown-provider"}  ${
        stringValue(value.status) ?? "unknown-status"
      }`,
    );
  }
  lines.push(`${connections.length} connection(s)`);
  return lines.join("\n");
}

function formatConnectionCreate(response: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response) || !isRecord(response.connection)) {
    return "Connection create response is missing connection details.";
  }
  const connection = response.connection;
  return [
    `Connection ${stringValue(connection.id) ?? "unknown"} created`,
    `  scope: ${stringValue(connection.scope) ?? "unknown"}`,
    `  provider: ${stringValue(connection.provider) ?? "unknown"}`,
    `  status: ${stringValue(connection.status) ?? "unknown"}`,
    `  env names: ${envNames(connection).join(", ") || "none"}`,
  ].join("\n");
}

function formatConnectionTest(response: unknown, asJson: boolean): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response))
    return "Connection test response is missing details.";
  return [
    `Connection test: ${stringValue(response.status) ?? "unknown"}`,
    ...(stringValue(response.detail)
      ? [`  detail: ${stringValue(response.detail)}`]
      : []),
  ].join("\n");
}

function envNames(connection: Record<string, unknown>): readonly string[] {
  return Array.isArray(connection.envNames)
    ? connection.envNames.filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      )
    : [];
}
