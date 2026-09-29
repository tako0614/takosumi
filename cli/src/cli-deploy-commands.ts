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
  const rawBody = await requestDeployControl({
    options: flags,
    path: `${API_V1_PREFIX}/runs/${encodeURIComponent(runId)}/logs`,
  });
  const body = parseRunLogsResponse(rawBody);
  for (const d of body.diagnostics) {
    io.stdout(`[${d.severity}] ${d.message}`);
  }
  for (const event of body.auditEvents) {
    io.stdout(renderRunAuditEvent(event));
  }
  for (const mint of body.credentialMints) {
    io.stdout(renderCredentialMint(mint));
  }
  if (
    body.diagnostics.length === 0 &&
    body.auditEvents.length === 0 &&
    body.credentialMints.length === 0
  ) {
    io.stdout("No run log entries are available.");
  }
  return 0;
}

interface CliRunDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
}

interface CliRunAuditEvent {
  readonly type: string;
  readonly at: number;
  readonly data?: Record<string, unknown>;
}

interface CliCredentialMint {
  readonly connectionId: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly temporary: boolean;
  readonly ttlEnforced: boolean;
  readonly expiresAt?: string;
  readonly ttlSeconds?: number;
}

interface CliRunLogsResponse {
  readonly diagnostics: readonly CliRunDiagnostic[];
  readonly auditEvents: readonly CliRunAuditEvent[];
  readonly credentialMints: readonly CliCredentialMint[];
}

function parseRunLogsResponse(value: unknown): CliRunLogsResponse {
  if (!isRecord(value)) throw invalidRunLogsResponse();
  const { diagnostics, auditEvents } = value;
  const hasCredentialMints = Object.hasOwn(value, "credentialMints");
  const credentialMints = value.credentialMints;
  if (
    !Array.isArray(diagnostics) ||
    !Array.isArray(auditEvents) ||
    (hasCredentialMints && !Array.isArray(credentialMints))
  ) {
    throw invalidRunLogsResponse();
  }

  const parsedDiagnostics: CliRunDiagnostic[] = [];
  for (const item of diagnostics) {
    if (
      !isRecord(item) ||
      (item.severity !== "info" &&
        item.severity !== "warning" &&
        item.severity !== "error") ||
      typeof item.message !== "string"
    ) {
      throw invalidRunLogsResponse();
    }
    parsedDiagnostics.push({ severity: item.severity, message: item.message });
  }

  const parsedEvents: CliRunAuditEvent[] = [];
  for (const item of auditEvents) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.type !== "string" ||
      typeof item.at !== "number" ||
      !Number.isFinite(item.at) ||
      (item.data !== undefined && !isRecord(item.data))
    ) {
      throw invalidRunLogsResponse();
    }
    parsedEvents.push({
      type: item.type,
      at: item.at,
      ...(isRecord(item.data) ? { data: item.data } : {}),
    });
  }

  const parsedMints: CliCredentialMint[] = [];
  for (const item of Array.isArray(credentialMints) ? credentialMints : []) {
    if (
      !isRecord(item) ||
      typeof item.connectionId !== "string" ||
      typeof item.provider !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.temporary !== "boolean" ||
      typeof item.ttlEnforced !== "boolean" ||
      (item.expiresAt !== undefined && typeof item.expiresAt !== "string") ||
      (item.ttlSeconds !== undefined &&
        (typeof item.ttlSeconds !== "number" || !Number.isFinite(item.ttlSeconds)))
    ) {
      throw invalidRunLogsResponse();
    }
    parsedMints.push({
      connectionId: item.connectionId,
      provider: item.provider,
      createdAt: item.createdAt,
      temporary: item.temporary,
      ttlEnforced: item.ttlEnforced,
      ...(typeof item.expiresAt === "string" ? { expiresAt: item.expiresAt } : {}),
      ...(typeof item.ttlSeconds === "number" ? { ttlSeconds: item.ttlSeconds } : {}),
    });
  }

  return {
    diagnostics: parsedDiagnostics,
    auditEvents: parsedEvents,
    credentialMints: parsedMints,
  };
}

function renderRunAuditEvent(event: CliRunAuditEvent): string {
  const at = formatLogTime(event.at) ?? "time unavailable";
  if (event.type !== "credential.refresh.accepted") {
    const type = /^[a-z][a-z0-9_.-]{0,79}$/.test(event.type)
      ? event.type
      : "unrecognized event";
    return `[event] ${type} at ${at}`;
  }

  const data = event.data ?? {};
  const fields = [
    safeLogField("sequence", data.sequence),
    safeLogField("provider", data.provider),
    safeLogField("connection", data.connectionId),
    safeLogField("expires", data.expiresAt),
  ].filter((field): field is string => field !== undefined);
  return `[event] credential.refresh.accepted at ${at}${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`;
}

function renderCredentialMint(mint: CliCredentialMint): string {
  const at = formatLogTime(mint.createdAt) ?? "time unavailable";
  const fields = [
    safeLogField("provider", mint.provider),
    safeLogField("connection", mint.connectionId),
    `temporary=${mint.temporary ? "yes" : "no"}`,
    `ttl-enforced=${mint.ttlEnforced ? "yes" : "no"}`,
    ...(mint.ttlSeconds !== undefined ? [`ttl=${mint.ttlSeconds}s`] : []),
    ...(mint.expiresAt
      ? [`expires=${formatLogTime(mint.expiresAt) ?? "unavailable"}`]
      : []),
  ].filter((field): field is string => field !== undefined);
  return `[credential mint] at ${at} (${fields.join(", ")})`;
}

function safeLogField(label: string, value: unknown): string | undefined {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
      return undefined;
    }
    return `${label}=${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${label}=${value}`;
  }
  return undefined;
}

function formatLogTime(value: number | string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRunLogsResponse(): Error {
  return new Error("deploy-control returned an invalid run logs response");
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
