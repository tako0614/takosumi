import process from "node:process";
import { readFile } from "node:fs/promises";
import {
  booleanOption,
  optionalStringOption,
  parseOptions,
} from "./cli-options.ts";
import {
  connectionsCreateCloudflareHelpText,
  connectionsCreateGenericEnvHelpText,
  connectionsHelpText,
  connectionsListHelpText,
  connectionsRevokeHelpText,
  connectionsTestHelpText,
} from "./cli-help.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";
import type { CliIo } from "./cli-io.ts";
import {
  CONNECTIONS_GENERIC_ENV_PROVIDER_PATH,
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
  if (command === "set-cloudflare-token") {
    return await runConnectionsCreateCloudflareToken(rest, io);
  }
  if (command === "create-generic-env") {
    return await runConnectionsCreateGenericEnv(rest, io);
  }
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

export async function runConnectionsCreateCloudflareToken(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(connectionsCreateCloudflareHelpText());
    return 0;
  }
  try {
    const body = await cloudflareTokenConnectionBody(options);
    const response = await requestDeployControlApi({
      path: `${CONNECTIONS_PATH}/cloudflare/token`,
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

export async function runConnectionsCreateGenericEnv(
  args: string[],
  io: CliIo,
): Promise<number> {
  const options = parseOptions(args);
  if (options.help) {
    io.stdout(connectionsCreateGenericEnvHelpText());
    return 0;
  }
  try {
    const body = await genericEnvProviderConnectionBody(options);
    const response = await requestDeployControlApi({
      path: CONNECTIONS_GENERIC_ENV_PROVIDER_PATH,
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

async function requestDeployControlApi(input: {
  path: string;
  options: Record<string, string | boolean>;
  method?: string;
  body?: unknown;
  allowEmpty?: boolean;
}): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token =
    optionalStringOption(input.options, "token") ??
    process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method: input.method ?? "GET", headers };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(input.body);
  }
  const response = await fetch(
    `${deployControlApiBase(input.options)}${input.path}`,
    init,
  );
  const text = await response.text();
  const body = text.trim().length > 0 ? parseJson(text) : undefined;
  if (!response.ok) {
    throw new Error(
      deployControlApiErrorMessage(body, `HTTP ${response.status}`),
    );
  }
  if (body === undefined) {
    if (input.allowEmpty) return {};
    throw new Error("Takosumi deploy-control returned an empty response");
  }
  return body;
}

function deployControlApiBase(
  options: Record<string, string | boolean>,
): string {
  const raw =
    optionalStringOption(options, "url") ??
    optionalStringOption(options, "deployControlUrl") ??
    process.env.TAKOSUMI_DEPLOY_CONTROL_URL ??
    process.env.TAKOSUMI_ACCOUNTS_URL;
  if (!raw) {
    throw new Error(
      "operator-selected deploy-control URL required: pass --url or set " +
        "TAKOSUMI_DEPLOY_CONTROL_URL",
    );
  }
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function cloudflareTokenConnectionBody(
  options: Record<string, string | boolean>,
): Promise<Record<string, unknown>> {
  const values = await valuesFromOptions(options, {
    singleFileOption: "apiTokenFile",
    singleEnvName: "CLOUDFLARE_API_TOKEN",
  });
  const scopeHints: Record<string, string> = {};
  const accountId = optionalStringOption(options, "accountId");
  if (accountId) scopeHints.accountId = accountId;
  const zoneId = optionalStringOption(options, "zoneId");
  if (zoneId) scopeHints.zoneId = zoneId;
  return connectionBody(options, {
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    authMethod: "static_secret",
    values,
    scopeHints,
  });
}

export async function genericEnvProviderConnectionBody(
  options: Record<string, string | boolean>,
): Promise<Record<string, unknown>> {
  const provider = optionalStringOption(options, "provider");
  if (!provider) throw new TypeError("--provider is required");
  const spaceId = optionalStringOption(options, "space");
  if (!spaceId) throw new TypeError("--space is required");
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
    spaceId,
    kind: "generic_env_provider",
    authMethod: "static_secret",
    scope: "space",
    ...(displayName ? { displayName } : {}),
    ...(Object.keys(scopeHints).length > 0 ? { scopeHints } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    values,
    ...(files.length > 0 ? { files } : {}),
  };
}

function connectionBody(
  options: Record<string, string | boolean>,
  base: {
    provider: string;
    kind: string;
    authMethod: string;
    values: Record<string, string>;
    scopeHints?: Record<string, string>;
  },
): Record<string, unknown> {
  const scope = optionalStringOption(options, "scope");
  if (scope && scope !== "operator") {
    throw new TypeError("operator CLI only accepts --scope operator");
  }
  if (optionalStringOption(options, "space")) {
    throw new TypeError(
      "operator CLI does not create Space-owned Provider Connection backing material",
    );
  }
  const displayName = optionalStringOption(options, "displayName");
  const expiresAt = optionalStringOption(options, "expiresAt");
  return {
    provider: base.provider,
    kind: base.kind,
    authMethod: base.authMethod,
    scope: "operator",
    ...(displayName ? { displayName } : {}),
    ...(base.scopeHints && Object.keys(base.scopeHints).length > 0
      ? { scopeHints: base.scopeHints }
      : {}),
    ...(expiresAt ? { expiresAt } : {}),
    values: base.values,
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
  single?: { singleFileOption: string; singleEnvName: string },
): Promise<Record<string, string>> {
  const valuesFile = optionalStringOption(options, "valuesFile");
  const singleFile = single
    ? optionalStringOption(options, single.singleFileOption)
    : undefined;
  if (valuesFile && singleFile) {
    throw new TypeError(
      "--values-file cannot be combined with provider token file options",
    );
  }
  if (single && singleFile) {
    const value = (await readFile(singleFile, "utf8")).trim();
    if (!value)
      throw new TypeError(`--${kebab(single.singleFileOption)} is empty`);
    return { [single.singleEnvName]: value };
  }
  if (!valuesFile) {
    throw new TypeError(
      single
        ? `--values-file or --${kebab(single.singleFileOption)} is required`
        : "--values-file is required",
    );
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

function deployControlApiErrorMessage(
  value: unknown,
  fallback: string,
): string {
  if (!isRecord(value)) return fallback;
  if (isRecord(value.error)) {
    return (
      stringValue(value.error.message) ??
      stringValue(value.error_description) ??
      stringValue(value.error.code) ??
      fallback
    );
  }
  return (
    stringValue(value.error_description) ??
    stringValue(value.message) ??
    stringValue(value.error) ??
    fallback
  );
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
