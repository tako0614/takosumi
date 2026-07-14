import process from "node:process";
import { optionalStringOption } from "./cli-options.ts";
import { isRecord, parseJson, stringValue } from "./cli-util.ts";

export type CliOptions = Record<string, string | boolean>;

/** Shared HTTP boundary for public/operator Takosumi control-plane commands. */
export async function requestDeployControlApi(input: {
  readonly path: string;
  readonly options: CliOptions;
  readonly method?: string;
  readonly body?: unknown;
  readonly allowEmpty?: boolean;
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
