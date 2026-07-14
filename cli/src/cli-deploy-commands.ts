/** Public Run read companions (`logs` / `status`). */

import process from "node:process";
import { optionalStringOption } from "./cli-options.ts";
import { parseJson } from "./cli-util.ts";
import type { CliIo } from "./cli-io.ts";
import { API_V1_PREFIX } from "takosumi-contract/api-surface";

interface RunRecord {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly policyStatus?: string;
}

export async function runDeployLogs(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [runId, ...rest] = args;
  if (!runId) {
    io.stderr("usage: takosumi logs <run-id>");
    return 2;
  }
  const flags = parseFlags(rest);
  const body = (await requestDeployControl({
    options: flags,
    path: `${API_V1_PREFIX}/runs/${encodeURIComponent(runId)}/logs`,
  })) as { diagnostics?: { severity: string; message: string }[] };
  for (const d of body.diagnostics ?? []) {
    io.stdout(`[${d.severity}] ${d.message}`);
  }
  return 0;
}

export async function runDeployStatus(
  args: string[],
  io: CliIo,
): Promise<number> {
  const [runId, ...rest] = args;
  if (!runId) {
    io.stderr("usage: takosumi status <run-id>");
    return 2;
  }
  const flags = parseFlags(rest);
  const run = (await requestDeployControl({
    options: flags,
    path: `${API_V1_PREFIX}/runs/${encodeURIComponent(runId)}`,
  })) as RunRecord;
  io.stdout(`${run.type} ${run.id} ${run.status}`);
  return 0;
}

// --- helpers ---------------------------------------------------------------

async function requestDeployControl(input: {
  options: Record<string, string | boolean>;
  path: string;
  method?: string;
  body?: unknown;
  binary?: Uint8Array;
}): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token =
    optionalStringOption(input.options, "token") ??
    process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method: input.method ?? "GET", headers };
  if (input.binary !== undefined) {
    headers["content-type"] = "application/zstd";
    init.body = input.binary as unknown as BodyInit;
  } else if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(input.body);
  }
  const response = await fetch(
    `${deployControlBase(input.options)}${input.path}`,
    init,
  );
  const text = await response.text();
  const body = text.trim().length > 0 ? parseJson(text) : undefined;
  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } })?.error?.message ??
      `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (body === undefined)
    throw new Error("deploy-control returned an empty response");
  return body;
}

function deployControlBase(options: Record<string, string | boolean>): string {
  const raw =
    optionalStringOption(options, "url") ??
    process.env.TAKOSUMI_DEPLOY_CONTROL_URL;
  if (!raw) {
    throw new Error(
      "deploy-control URL required: pass --url or set TAKOSUMI_DEPLOY_CONTROL_URL",
    );
  }
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (inline !== undefined) {
      flags[key] = inline;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}
