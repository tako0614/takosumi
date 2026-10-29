import process from "node:process";
import { optionalStringOption } from "./cli-options.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";

export type CliOptions = Record<string, string | boolean>;

export class DeployControlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DeployControlApiError";
  }
}

/** Shared HTTP boundary for public/operator Takosumi control-plane commands. */
export async function requestDeployControlApi(input: {
  readonly path: string;
  readonly options: CliOptions;
  readonly method?: string;
  readonly body?: unknown;
  readonly allowEmpty?: boolean;
  readonly auth?: "deploy-control" | "accounts";
  readonly extraHeaders?: Readonly<Record<string, string>>;
}): Promise<unknown> {
  const headers = new Headers({ accept: "application/json" });
  const token =
    optionalStringOption(input.options, "token") ??
    (input.auth === "accounts"
      ? process.env.TAKOSUMI_ACCOUNT_TOKEN
      : process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN);
  if (input.auth === "accounts" && !token) {
    throw new Error(
      "Accounts PAT required: pass --token or set TAKOSUMI_ACCOUNT_TOKEN",
    );
  }
  if (token) headers.set("authorization", `Bearer ${token}`);
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    headers.set(name, value);
  }

  const init: RequestInit = { method: input.method ?? "GET", headers };
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(input.body);
  }

  const response = await fetch(
    `${deployControlApiBase(input.options)}${input.path}`,
    init,
  );
  const text = await response.text();
  let body: unknown;
  if (text.trim().length > 0) {
    try {
      body = parseJson(text);
    } catch (error) {
      if (response.ok) throw error;
    }
  }
  if (!response.ok) {
    throw new DeployControlApiError(
      deployControlApiErrorMessage(body, `HTTP ${response.status}`),
      response.status,
      isRecord(body) ? (isRecord(body.error) ? stringValue(body.error.code) : stringValue(body.error)) : undefined,
    );
  }
  if (body === undefined) {
    if (input.allowEmpty) return {};
    throw new Error("Takosumi deploy-control returned an empty response");
  }
  return body;
}

export function deployControlApiBase(options: CliOptions): string {
  const raw =
    optionalStringOption(options, "url") ??
    optionalStringOption(options, "deployControlUrl") ??
    process.env.TAKOSUMI_DEPLOY_CONTROL_URL;
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
