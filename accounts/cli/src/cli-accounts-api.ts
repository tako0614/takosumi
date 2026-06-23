import process from "node:process";
import { TAKOSUMI_ACCOUNTS_PAT_SCOPES } from "@takosjp/takosumi-accounts-contract";
import { commaSeparatedOption, optionalStringOption } from "./cli-options.ts";
import { accountsApiErrorMessage, parseJson } from "./cli-util.ts";

export async function requestAccountsApi(input: {
  path: string;
  options: Record<string, string | boolean>;
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
}): Promise<unknown> {
  const headers = accountsApiHeaders(input.options);
  if (input.idempotencyKey) {
    headers["idempotency-key"] = input.idempotencyKey;
  }
  const init: RequestInit = {
    method: input.method ?? "GET",
    headers,
  };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(input.body);
  }
  const response = await fetch(
    `${accountsApiBase(input.options)}${input.path}`,
    init,
  );
  const text = await response.text();
  const body = text.trim().length > 0 ? parseJson(text) : undefined;
  if (!response.ok) {
    throw new Error(accountsApiErrorMessage(body, `HTTP ${response.status}`));
  }
  if (body === undefined) {
    throw new Error("Takosumi Accounts returned an empty response");
  }
  return body;
}

export function accountsApiBase(
  options: Record<string, string | boolean>,
): string {
  const raw =
    optionalStringOption(options, "accountsUrl") ??
    process.env.TAKOSUMI_ACCOUNTS_URL;
  if (raw === undefined || raw === "") {
    throw new Error(
      "operator-selected issuer required: pass --accountsUrl or set " +
        "TAKOSUMI_ACCOUNTS_URL (no implicit takosumi default)",
    );
  }
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function accountsApiHeaders(
  options: Record<string, string | boolean>,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const token =
    optionalStringOption(options, "token") ??
    process.env.TAKOSUMI_ACCOUNTS_TOKEN ??
    process.env.TAKOS_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

export function accountsTokenCreateBody(
  options: Record<string, string | boolean>,
): Record<string, unknown> {
  const name = optionalStringOption(options, "name") ?? "takosumi-cli";
  if (name.trim().length === 0 || name.length > 80) {
    throw new TypeError("--name must be 1-80 characters");
  }
  const scopes = commaSeparatedOption(options, "scope");
  const normalizedScopes = scopes.length > 0 ? scopes : ["read", "write"];
  const allowedScopes = new Set<string>(TAKOSUMI_ACCOUNTS_PAT_SCOPES);
  for (const scope of normalizedScopes) {
    if (!allowedScopes.has(scope)) {
      throw new TypeError(
        `--scope must contain only: ${TAKOSUMI_ACCOUNTS_PAT_SCOPES.join(", ")}`,
      );
    }
  }
  const uniqueScopes = [...new Set(normalizedScopes)];
  const body: Record<string, unknown> = {
    name,
    scopes: uniqueScopes,
  };
  const expiresAt = optionalStringOption(options, "expiresAt");
  if (expiresAt) body.expires_at = expiresAt;
  return body;
}

export function installationStatusPatchBody(
  status: string,
  options: Record<string, string | boolean>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { status };
  const reason = optionalStringOption(options, "reason");
  if (reason) body.reason = reason;
  const mode = optionalStringOption(options, "mode");
  if (mode !== undefined) {
    if (
      mode !== "shared-cell" &&
      mode !== "dedicated" &&
      mode !== "self-hosted"
    ) {
      throw new TypeError(
        "--mode must be one of: shared-cell, dedicated, self-hosted",
      );
    }
    body.mode = mode;
  }
  const operation = optionalStringOption(options, "operation");
  if (operation !== undefined) {
    if (operation !== "materialize" && operation !== "export") {
      throw new TypeError("--operation must be materialize or export");
    }
    body.operation = operation;
  }
  const operationId = optionalStringOption(options, "operationId");
  if (operationId) body.operationId = operationId;
  const runtimeTargetRecordId = optionalStringOption(
    options,
    "runtimeTargetRecordId",
  );
  const runtimeTargetType = optionalStringOption(options, "runtimeTargetType");
  const runtimeTargetId = optionalStringOption(options, "runtimeTargetId");
  if (runtimeTargetType !== undefined) {
    if (
      runtimeTargetType !== "shared-cell" &&
      runtimeTargetType !== "dedicated" &&
      runtimeTargetType !== "self-hosted"
    ) {
      throw new TypeError(
        "--runtime-target-type must be one of: shared-cell, dedicated, self-hosted",
      );
    }
  }
  if (runtimeTargetType && !runtimeTargetId) {
    throw new TypeError(
      "--runtime-target-id is required when --runtime-target-type is provided",
    );
  }
  if (runtimeTargetRecordId && !runtimeTargetId) {
    body.runtimeTargetId = runtimeTargetRecordId;
  }
  if (runtimeTargetId) {
    body.runtimeTarget = {
      ...(runtimeTargetRecordId
        ? { runtimeTargetId: runtimeTargetRecordId }
        : {}),
      ...(runtimeTargetType ? { targetType: runtimeTargetType } : {}),
      targetId: runtimeTargetId,
    };
  }
  const downloadUrl = optionalStringOption(options, "downloadUrl");
  if (downloadUrl) body.downloadUrl = downloadUrl;
  const downloadExpiresAt = optionalStringOption(options, "downloadExpiresAt");
  if (downloadExpiresAt) body.downloadExpiresAt = downloadExpiresAt;
  const archiveDigest = optionalStringOption(options, "archiveDigest");
  if (archiveDigest) body.archiveDigest = archiveDigest;
  const error = optionalStringOption(options, "error");
  if (error) body.error = error;
  return body;
}
