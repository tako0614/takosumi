#!/usr/bin/env bun
/** GET-only incident correlation. Never serialize credentials, bodies or raw errors. */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readOwnerPrivateTextFile } from "./lib/private-evidence-file.ts";

const KIND = "takosumi.request-latency-sample@v1";
const PROGRESS_KIND = "takosumi.request-latency-progress@v1";
const STAGING_ORIGIN = "https://app-staging.takosumi.com";
const BODY_LIMIT_BYTES = 1024 * 1024;
const TIMING_NAMES = new Set([
  "tk_accounts_init",
  "tk_control_auth",
  "tk_control_init",
  "tk_control_dispatch",
]);

export interface RequestLatencyProbeOptions {
  readonly environment: "staging" | "local";
  readonly url: string;
  readonly path: string;
  readonly samples: number;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

export interface RequestLatencySample {
  readonly kind: typeof KIND;
  readonly sample: number;
  readonly probeId: string;
  readonly environment: "staging" | "local";
  readonly client: "node-http";
  readonly route: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outcome:
    | "response"
    | "http_error"
    | "redirect_refused"
    | "timeout"
    | "body_limit"
    | "network_error"
    | "body_error";
  readonly phase: "headers" | "body";
  readonly status?: number;
  readonly cfRay?: string;
  readonly serverTiming: Readonly<Record<string, number>>;
  /** Elapsed time from request start, rather than exclusive stage durations. */
  readonly milestones: Readonly<{
    dnsMs?: number;
    tcpMs?: number;
    tlsMs?: number;
    headersMs?: number;
    bodyMs?: number;
  }>;
}

/** At most two records per sample, available before its final result. */
export interface RequestLatencyProgress {
  readonly kind: typeof PROGRESS_KIND;
  readonly sample: number;
  readonly probeId: string;
  readonly environment: "staging" | "local";
  readonly client: "node-http";
  readonly route: string;
  readonly startedAt: string;
  readonly at: string;
  readonly elapsedMs: number;
  readonly phase: "headers" | "body";
  readonly status?: number;
  readonly cfRay?: string;
  readonly versionId?: string;
}

export function resolveLatencyProbeOptions(
  args: Readonly<Record<string, string>>,
): RequestLatencyProbeOptions {
  const environment = args.environment;
  if (environment !== "staging" && environment !== "local") {
    throw new Error("explicit staging or local environment required");
  }
  const options = {
    environment,
    url: args.url,
    path: args.path ?? "/.well-known/takosumi",
    samples: integerOption(args.samples, 12, 1, 70),
    timeoutMs: integerOption(args["timeout-ms"], 130_000, 1, 150_000),
    intervalMs: integerOption(args["interval-ms"], 250, 0, 5_000),
  } satisfies RequestLatencyProbeOptions;
  validateTarget(options);
  return options;
}

function integerOption(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error("invalid bounded integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("invalid bounded integer");
  }
  return value;
}

function validateTarget(options: RequestLatencyProbeOptions): {
  url: URL;
  route: string;
} {
  const origin = new URL(options.url);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("plain origin required");
  }
  if (options.environment === "staging") {
    if (origin.origin !== STAGING_ORIGIN)
      throw new Error("staging target mismatch");
  } else if (
    options.environment !== "local" ||
    origin.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)
  ) {
    throw new Error("loopback target required");
  }
  let route: string;
  if (
    [
      "/.well-known/takosumi",
      "/.well-known/openid-configuration",
      "/api/v1/views/workspaces.v1",
    ].includes(options.path)
  ) {
    route = options.path;
  } else if (/^\/api\/v1\/runs\/[A-Za-z0-9_-]{1,128}$/u.test(options.path)) {
    route = "/api/v1/runs/:runId";
  } else {
    throw new Error("read-only route required without query or fragment");
  }
  if (
    !Number.isSafeInteger(options.samples) ||
    options.samples < 1 ||
    options.samples > 70 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 150_000 ||
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 0 ||
    options.intervalMs > 5_000
  ) {
    throw new Error("probe bounds invalid");
  }
  return { url: new URL(options.path, origin), route };
}

function safeMetadata(
  response: IncomingMessage,
): Pick<RequestLatencySample, "cfRay" | "serverTiming"> {
  const ray = response.headers["cf-ray"];
  const cfRay =
    typeof ray === "string" && /^[0-9a-f]{16}-[A-Z]{3}$/u.test(ray)
      ? ray
      : undefined;
  const raw = response.headers["server-timing"];
  const serverTiming: Record<string, number> = {};
  if (typeof raw === "string" && raw.length <= 1024) {
    for (const part of raw.split(",")) {
      const match = /^\s*([a-z_]+);dur=(\d+(?:\.\d+)?)\s*$/u.exec(part);
      if (!match || !TIMING_NAMES.has(match[1])) continue;
      const duration = Number(match[2]);
      if (Number.isFinite(duration) && duration <= 600_000)
        serverTiming[match[1]] = duration;
    }
  }
  return { cfRay, serverTiming };
}

export async function probeRequestLatency(
  options: RequestLatencyProbeOptions,
  sample: number,
  token?: string,
  onProgress?: (progress: RequestLatencyProgress) => void,
): Promise<RequestLatencySample> {
  const { url, route } = validateTarget(options);
  if (
    token !== undefined &&
    (!token || token.length > 16_384 || /[\s\x00-\x1f\x7f]/u.test(token))
  ) {
    throw new Error("invalid bearer input");
  }
  const startedAt = new Date().toISOString();
  const probeId = randomBytes(8).toString("hex");
  const start = performance.now();
  const elapsed = () => Math.round((performance.now() - start) * 10) / 10;
  return await new Promise<RequestLatencySample>((resolveSample) => {
    let done = false;
    let phase: "headers" | "body" = "headers";
    let response: IncomingMessage | undefined;
    let metadata: Pick<RequestLatencySample, "cfRay" | "serverTiming"> = {
      serverTiming: {},
    };
    const emitProgress = (): void => {
      if (!onProgress) return;
      try {
        const version = response?.headers["x-takosumi-version-id"];
        onProgress({
          kind: PROGRESS_KIND,
          sample,
          probeId,
          environment: options.environment,
          client: "node-http",
          route,
          startedAt,
          at: new Date().toISOString(),
          elapsedMs: elapsed(),
          phase,
          status: response?.statusCode,
          cfRay: metadata.cfRay,
          ...(typeof version === "string" &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(version)
            ? { versionId: version }
            : {}),
        });
      } catch {
        // Observability must not change the request outcome or its deadline.
      }
    };
    const milestones: {
      dnsMs?: number;
      tcpMs?: number;
      tlsMs?: number;
      headersMs?: number;
      bodyMs?: number;
    } = {};
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "takosumi-request-latency-probe",
      "x-takosumi-request-probe-id": probeId,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        headers,
        agent: false,
      },
    );
    const finish = (outcome: RequestLatencySample["outcome"]): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveSample({
        kind: KIND,
        sample,
        probeId,
        environment: options.environment,
        client: "node-http",
        route,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: elapsed(),
        outcome,
        phase,
        status: response?.statusCode,
        ...metadata,
        milestones: { ...milestones },
      });
      // Stop both header and body I/O. No automatic retry or redirect is allowed.
      response?.destroy();
      request.destroy();
    };
    const timer = setTimeout(() => finish("timeout"), options.timeoutMs);
    request.once("socket", (socket) => {
      socket.once("lookup", () => {
        milestones.dnsMs = elapsed();
      });
      socket.once("connect", () => {
        milestones.tcpMs = elapsed();
      });
      socket.once("secureConnect", () => {
        milestones.tlsMs = elapsed();
      });
    });
    request.once("error", () => finish("network_error"));
    request.once("response", (incoming) => {
      response = incoming;
      if (done) {
        incoming.destroy();
        return;
      }
      phase = "body";
      milestones.headersMs = elapsed();
      metadata = safeMetadata(incoming);
      const status = incoming.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        finish("redirect_refused");
        return;
      }
      emitProgress();
      let bytes = 0;
      incoming.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > BODY_LIMIT_BYTES) finish("body_limit");
      });
      incoming.once("aborted", () => finish("body_error"));
      incoming.once("error", () => finish("body_error"));
      incoming.once("end", () => {
        milestones.bodyMs = elapsed();
        finish(status >= 200 && status < 300 ? "response" : "http_error");
      });
    });
    emitProgress();
    request.end();
  });
}

export async function runRequestLatencyProbe(
  options: RequestLatencyProbeOptions,
  emit: (sample: RequestLatencySample) => void,
  token?: string,
  onProgress?: (progress: RequestLatencyProgress) => void,
): Promise<number> {
  validateTarget(options);
  let exitCode = 0;
  for (let sample = 1; sample <= options.samples; sample += 1) {
    const result = await probeRequestLatency(options, sample, token, onProgress);
    emit(result);
    if (result.outcome !== "response") exitCode = 1;
    if (sample < options.samples && options.intervalMs) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, options.intervalMs),
      );
    }
  }
  return exitCode;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(`Usage: bun scripts/probe-request-latency.ts --environment staging --url ${STAGING_ORIGIN} [--path /api/v1/runs/<id>] [--token-file /private/token] [--samples 12] [--timeout-ms 130000] [--interval-ms 250] [--progress]
Local fixtures: --environment local --url http://127.0.0.1:<port>
Output: one allowlisted JSON sample per GET; route IDs, credentials, bodies and raw errors are omitted.
With --progress: at most two allowlisted JSON progress rows per sample on stderr, while headers or body are pending; final stdout is unchanged.
Limits: 1..70 sequential samples, 1..150000ms total deadline per sample, 0..5000ms interval, 1MiB discarded body.
Exit: 0 only when every sample completes with 2xx; 1 on timeout/HTTP/transport failure; 2 on invalid input.`);
    return 0;
  }
  try {
    const args: Record<string, string> = {};
    let progress = false;
    const names = new Set([
      "environment",
      "url",
      "path",
      "token-file",
      "samples",
      "timeout-ms",
      "interval-ms",
    ]);
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === "--progress") {
        if (progress) throw new Error("duplicate progress argument");
        progress = true;
        continue;
      }
      const key = argv[index].slice(2);
      const value = argv[index + 1];
      if (
        !argv[index].startsWith("--") ||
        !names.has(key) ||
        key in args ||
        value === undefined ||
        value.startsWith("--")
      ) {
        throw new Error("invalid argument");
      }
      args[key] = value;
      index += 1;
    }
    const options = resolveLatencyProbeOptions(args);
    const token = args["token-file"]
      ? (
          await readOwnerPrivateTextFile(args["token-file"], {
            sourceRoots: [resolve(import.meta.dir, "..")],
            maxBytes: 16_384,
            label: "probe credential",
          })
        ).trim()
      : undefined;
    return await runRequestLatencyProbe(
      options,
      (sample) => console.log(JSON.stringify(sample)),
      token,
      progress ? (row) => console.error(JSON.stringify(row)) : undefined,
    );
  } catch {
    console.error(
      "latency probe: invalid arguments or private input (details omitted)",
    );
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
