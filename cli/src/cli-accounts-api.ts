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
  extraHeaders?: Record<string, string>;
}): Promise<unknown> {
  const headers = accountsApiHeaders(input.options);
  if (input.idempotencyKey) {
    headers["idempotency-key"] = input.idempotencyKey;
  }
  for (const [key, value] of Object.entries(input.extraHeaders ?? {})) {
    headers[key] = value;
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
    throw new AccountsApiError({
      status: response.status,
      body,
      message: accountsApiErrorMessage(body, `HTTP ${response.status}`),
    });
  }
  if (body === undefined) {
    throw new Error("Takosumi Accounts returned an empty response");
  }
  return body;
}

export class AccountsApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(input: { status: number; body: unknown; message: string }) {
    super(input.message);
    this.name = "AccountsApiError";
    this.status = input.status;
    this.body = input.body;
  }
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
