#!/usr/bin/env bun
/**
 * Accounts rate-limit readiness probe.
 *
 * This intentionally targets an unauthenticated, non-mutating Accounts route
 * until the per-source limiter returns 429. It records status counts and
 * Retry-After only; it never needs cookies, bearer tokens, provider keys, or
 * billing credentials.
 */

import process from "node:process";

export const ACCOUNTS_RATE_LIMIT_PROBE_KIND =
  "takosumi.accounts-rate-limit-probe@v1" as const;

const DEFAULT_PATH = "/oauth/authorize";

export interface AccountsRateLimitProbeOptions {
  readonly url: string;
  readonly path: string;
  readonly maxRequests: number;
  readonly intervalMs: number;
  readonly json: boolean;
}

export interface AccountsRateLimitProbeAttempt {
  readonly attempt: number;
  readonly status: number;
  readonly retryAfter?: string;
  readonly contentType?: string;
}

export interface AccountsRateLimitProbeResult {
  readonly kind: typeof ACCOUNTS_RATE_LIMIT_PROBE_KIND;
  readonly status: "passed" | "failed";
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly path: string;
  readonly requestCount: number;
  readonly statusCounts: Readonly<Record<string, number>>;
  readonly firstRateLimited?: AccountsRateLimitProbeAttempt;
  readonly attempts: readonly AccountsRateLimitProbeAttempt[];
  readonly safety: string;
}

interface CliArgs {
  readonly help?: boolean;
  readonly selfTest?: boolean;
  readonly json?: boolean;
  readonly url?: string;
  readonly path?: string;
  readonly maxRequests?: string;
  readonly intervalMs?: string;
}

type FetchLike = typeof fetch;

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(exitCode);
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.selfTest) {
    await runSelfTest();
    return 0;
  }
  const options = resolveOptions(args, process.env);
  const result = await runAccountsRateLimitProbe(options);
  writeResult(result, options);
  return result.status === "passed" ? 0 : 1;
}

export function resolveOptions(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): AccountsRateLimitProbeOptions {
  const url = args.url ?? env.TAKOSUMI_PLATFORM_URL;
  if (!url) throw new Error("--url or TAKOSUMI_PLATFORM_URL is required");
  return {
    url: normalizeBaseUrl(url),
    path: args.path ?? DEFAULT_PATH,
    maxRequests: parsePositiveInteger(args.maxRequests, "--max-requests", 70),
    intervalMs: parsePositiveInteger(args.intervalMs, "--interval-ms", 50),
    json: args.json === true,
  };
}

export async function runAccountsRateLimitProbe(
  options: AccountsRateLimitProbeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<AccountsRateLimitProbeResult> {
  const attempts: AccountsRateLimitProbeAttempt[] = [];
  for (let attempt = 1; attempt <= options.maxRequests; attempt += 1) {
    const response = await fetchImpl(buildProbeUrl(options), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "takosumi-accounts-rate-limit-probe",
      },
      redirect: "manual",
    });
    attempts.push({
      attempt,
      status: response.status,
      retryAfter: response.headers.get("retry-after") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
    });
    if (response.status === 429) break;
    await sleep(options.intervalMs);
  }
  const firstRateLimited = attempts.find((attempt) => attempt.status === 429);
  return {
    kind: ACCOUNTS_RATE_LIMIT_PROBE_KIND,
    status: firstRateLimited ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    serviceUrl: options.url,
    path: options.path,
    requestCount: attempts.length,
    statusCounts: statusCounts(attempts),
    firstRateLimited,
    attempts,
    safety:
      "Unauthenticated Accounts probe only; no provider, billing, customer mutation, cookie, or bearer token is sent.",
  };
}

function buildProbeUrl(options: AccountsRateLimitProbeOptions): string {
  const url = new URL(options.path, `${options.url}/`);
  if (url.pathname === "/oauth/authorize") {
    url.searchParams.set("client_id", "takosumi-readiness-rate-limit-probe");
    url.searchParams.set(
      "redirect_uri",
      `${options.url}/__readiness_rate_limit_probe`,
    );
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid");
    url.searchParams.set("state", `rate-limit-${Date.now()}`);
  }
  return url.toString();
}

function statusCounts(
  attempts: readonly AccountsRateLimitProbeAttempt[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    const key = String(attempt.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => Number(left) - Number(right)),
  );
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = camel(rawKey);
    if (inline !== undefined) {
      args[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args as CliArgs;
}

function camel(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function parsePositiveInteger(
  raw: string | undefined,
  label: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(raw);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/g, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function writeResult(
  result: AccountsRateLimitProbeResult,
  options: AccountsRateLimitProbeOptions,
): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = result.status === "passed" ? "PASS" : "FAIL";
  console.log(`${label} ${result.kind}`);
  console.log(`service: ${result.serviceUrl}`);
  console.log(`path: ${result.path}`);
  console.log(`requests: ${result.requestCount}`);
  console.log(`status counts: ${JSON.stringify(result.statusCounts)}`);
  if (result.firstRateLimited) {
    console.log(
      `rate limited at attempt ${result.firstRateLimited.attempt}, retry-after ${result.firstRateLimited.retryAfter ?? "n/a"}`,
    );
  }
}

async function runSelfTest(): Promise<void> {
  const options = resolveOptions(
    {
      url: "https://app-staging.takosumi.com",
      maxRequests: "4",
      intervalMs: "1",
    },
    {},
  );
  let calls = 0;
  const fakeFetch: FetchLike = (async () => {
    calls += 1;
    const status = calls === 3 ? 429 : 400;
    return new Response("{}", {
      status,
      headers:
        status === 429
          ? { "retry-after": "60", "content-type": "application/json" }
          : { "content-type": "application/json" },
    });
  }) as FetchLike;
  const result = await runAccountsRateLimitProbe(options, fakeFetch);
  if (result.status !== "passed" || result.requestCount !== 3) {
    throw new Error("self-test did not stop at first rate-limit response");
  }
  if (result.statusCounts["400"] !== 2 || result.statusCounts["429"] !== 1) {
    throw new Error("self-test status counts are wrong");
  }
  const serialized = JSON.stringify(result);
  if (/bearer\s+[A-Za-z0-9._-]{10,}|cookie=|token=/iu.test(serialized)) {
    throw new Error("self-test leaked credential-looking text");
  }
  console.log("accounts rate-limit probe self-test passed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/probe-accounts-rate-limit.ts --url <origin> [--json]

Options:
  --url <origin>          or TAKOSUMI_PLATFORM_URL
  --path <path>           default /oauth/authorize
  --max-requests <n>      default 70
  --interval-ms <n>       default 50
  --json                  print JSON only
  --self-test             run offline shape/redaction self-test
`);
}
