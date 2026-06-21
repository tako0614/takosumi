/**
 * `takosumi deploy` — the wrangler-deploy-style local-directory deploy.
 *
 * Unlike the dashboard, the CLI can read the operator's local working
 * directory: it tars the OpenTofu Capsule, uploads it to the control plane as an
 * upload SourceSnapshot, then asks `/api/v1/deploy` to resolve/create the
 * Installation and plan the snapshot. The heavy work (Capsule Gate / plan /
 * apply) stays server-side in the runner; the CLI only bundles, uploads, and
 * follows the resulting Run.
 */

import process from "node:process";
import { spawn } from "node:child_process";
import { optionalStringOption, stringOption } from "./cli-options.ts";
import { parseJson } from "./cli-util.ts";
import type { CliIo } from "./cli-io.ts";
import { DEPLOY_PATH } from "takosumi-contract/deploy";
import { SPACE_UPLOADS_PATH } from "takosumi-contract/sources";
import { API_V1_PREFIX } from "takosumi-contract/api-surface";
import type {
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
} from "takosumi-contract/connections";
import type { Space } from "takosumi-contract/spaces";

interface UploadSnapshot {
  readonly id: string;
  readonly archiveDigest: string;
  readonly archiveSizeBytes: number;
}

interface DeployResult {
  readonly installation: { readonly id: string; readonly name: string };
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly type: string;
  };
  readonly planRun?: {
    readonly id: string;
    readonly status: string;
    readonly type: string;
  };
  readonly applyRun?: {
    readonly id: string;
    readonly status: string;
    readonly type: string;
  };
  readonly created: boolean;
  readonly status?: string;
}

interface RunRecord {
  readonly id: string;
  readonly status: string;
  readonly type: string;
  readonly policyStatus?: string;
}

const TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "waiting_approval",
]);

export async function runDeploy(
  args: string[],
  io: CliIo,
  options: { planOnly: boolean },
): Promise<number> {
  const { dir, flags } = splitDirArgs(args);
  const space = requireFlag(flags, "space", "--space @space");
  const name =
    optionalStringOption(flags, "name") ?? defaultNameFromSpace(space);
  const targetSpace = await resolveTargetSpace(flags, space);
  const environment = optionalStringOption(flags, "environment");
  const vars = collectVars(flags);
  const providerConnections = collectProviderConnections(flags);

  io.stdout(`packaging ${dir} …`);
  const archive = await tarZstd(dir);

  io.stdout(`uploading ${archive.byteLength} bytes to ${targetSpace.label} …`);
  const uploadBody = (await requestDeployControl({
    options: flags,
    method: "POST",
    path: SPACE_UPLOADS_PATH(targetSpace.spaceId),
    binary: archive,
  })) as { snapshot: UploadSnapshot };
  const snapshot = uploadBody.snapshot;
  io.stdout(`snapshot ${snapshot.id} (${snapshot.archiveDigest})`);

  const deploy = (await requestDeployControl({
    options: flags,
    method: "POST",
    path: DEPLOY_PATH,
    body: {
      spaceId: targetSpace.spaceId,
      name,
      ...(environment ? { environment } : {}),
      snapshotId: snapshot.id,
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      ...(providerConnections.length > 0 ? { providerConnections } : {}),
      ...(options.planOnly ? { planOnly: true } : { autoApprove: true }),
    },
  })) as DeployResult;
  io.stdout(
    `${deploy.created ? "created" : "updated"} installation ${deploy.installation.id} (${deploy.installation.name})`,
  );

  const followRun = deploy.applyRun ?? deploy.planRun ?? deploy.run;
  let run = await pollRun(flags, followRun.id, io);
  io.stdout(
    `run ${run.id} ${run.status}${run.policyStatus ? ` (policy: ${run.policyStatus})` : ""}`,
  );
  if (options.planOnly || deploy.applyRun) {
    return run.status === "succeeded" || run.status === "waiting_approval"
      ? 0
      : 1;
  }
  if (run.status === "failed" || run.status === "cancelled") return 1;
  if (run.status === "waiting_approval") {
    await requestDeployControl({
      options: flags,
      method: "POST",
      path: `${API_V1_PREFIX}/runs/${encodeURIComponent(run.id)}/approve`,
      body: { reason: "takosumi deploy auto-apply" },
    });
  }
  const apply = (await requestDeployControl({
    options: flags,
    method: "POST",
    path: `${API_V1_PREFIX}/runs/${encodeURIComponent(run.id)}/apply`,
    body: {},
  })) as { readonly run?: RunRecord; readonly applyRun?: RunRecord };
  const applyRun = apply.applyRun ?? apply.run;
  if (!applyRun) throw new Error("deploy-control apply returned no run");
  run = await pollRun(flags, applyRun.id, io);
  io.stdout(
    `run ${run.id} ${run.status}${run.policyStatus ? ` (policy: ${run.policyStatus})` : ""}`,
  );
  return run.status === "succeeded" ? 0 : 1;
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

async function pollRun(
  flags: Record<string, string | boolean>,
  runId: string,
  io: CliIo,
): Promise<RunRecord> {
  let last = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const run = (await requestDeployControl({
      options: flags,
      path: `${API_V1_PREFIX}/runs/${encodeURIComponent(runId)}`,
    })) as RunRecord;
    if (run.status !== last) {
      io.stdout(`  ${run.status}`);
      last = run.status;
    }
    if (TERMINAL.has(run.status)) return run;
    await sleep(2000);
  }
  throw new Error(`run ${runId} did not reach a terminal state`);
}

function tarZstd(dir: string): Promise<Uint8Array> {
  // System `tar --zstd` keeps the CLI dependency-free and produces the exact
  // `source.tar.zst` shape the runner container restores.
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["--zstd", "-cf", "-", "-C", dir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `tar --zstd failed (exit ${code}): ${Buffer.concat(errChunks).toString().trim()}`,
          ),
        );
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
  });
}

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

function splitDirArgs(args: string[]): {
  dir: string;
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flagArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    flagArgs.push(arg);
    if (arg.includes("=")) continue;
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flagArgs.push(next);
      index += 1;
    }
  }
  return { dir: positional[0] ?? ".", flags: parseFlags(flagArgs) };
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

function collectVars(
  flags: Record<string, string | boolean>,
): Record<string, string> {
  // `--var key=value` may be repeated; the small flag parser keeps the last, so
  // accept a comma-joined `--var k1=v1,k2=v2` form too.
  const out: Record<string, string> = {};
  const raw = optionalStringOption(flags, "var");
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [k, ...v] = pair.split("=");
    if (k && v.length > 0) out[k.trim()] = v.join("=");
  }
  return out;
}

function collectProviderConnections(
  flags: Record<string, string | boolean>,
): InstallationProviderConnectionBindings {
  const raw = optionalStringOption(flags, "provider");
  if (!raw) return [];
  const connections: InstallationProviderConnectionBinding[] = [];
  for (const pair of raw.split(",")) {
    const [providerRaw, ...targetParts] = pair.split("=");
    const provider = providerRaw?.trim();
    const target = targetParts.join("=").trim();
    if (!provider || !target) {
      throw new Error("--provider must be provider=providerConnectionId");
    }
    connections.push({
      provider,
      alias: "main",
      connectionId: target,
    });
  }
  return connections;
}

function requireFlag(
  flags: Record<string, string | boolean>,
  key: string,
  hint: string,
): string {
  const value = optionalStringOption(flags, key);
  if (!value) throw new Error(`missing required ${hint}`);
  return value.replace(/^@/, "");
}

async function resolveTargetSpace(
  flags: Record<string, string | boolean>,
  space: string,
): Promise<{ spaceId: string; label: string }> {
  if (space.startsWith("space_")) {
    return { spaceId: space, label: space };
  }
  const handle = space.replace(/^@/, "");
  const body = (await requestDeployControl({
    options: flags,
    path: `${API_V1_PREFIX}/spaces`,
  })) as { spaces?: readonly Space[] };
  const spaces = Array.isArray(body.spaces) ? body.spaces : [];
  const match = spaces.find((candidate) => candidate.handle === handle);
  if (!match) {
    throw new Error(
      `space @${handle} was not found in the authenticated session; pass --space space_... or create/join that Space`,
    );
  }
  return { spaceId: match.id, label: `@${match.handle}` };
}

function defaultNameFromSpace(space: string): string {
  void space;
  return "app";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void stringOption;
