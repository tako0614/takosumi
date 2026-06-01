interface Options {
  readonly workersDevUrl: string | null;
  readonly customDomainUrl: string;
  readonly expectedIssuer: string;
  readonly timeoutMs: number;
  readonly failOnNotReady: boolean;
}

interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly error?: string;
  readonly body?: unknown;
}

function parseArgs(args: string[], env = process.env): Options {
  let workersDevUrl = env.TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL ?? null;
  let customDomainUrl = env.TAKOSUMI_ACCOUNTS_CUSTOM_DOMAIN_URL ??
    "https://accounts.takosumi.com";
  let expectedIssuer = env.TAKOSUMI_ACCOUNTS_EXPECTED_ISSUER ??
    "https://accounts.takosumi.com";
  let timeoutMs = Number(env.TAKOSUMI_ACCOUNTS_PROBE_TIMEOUT_MS ?? "10000");
  let failOnNotReady = env.TAKOSUMI_ACCOUNTS_PROBE_FAIL_ON_NOT_READY === "1";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--workers-dev-url") {
      workersDevUrl = requiredValue(args, ++index, arg);
    } else if (arg === "--custom-domain-url") {
      customDomainUrl = requiredValue(args, ++index, arg);
    } else if (arg === "--expected-issuer") {
      expectedIssuer = requiredValue(args, ++index, arg);
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(requiredValue(args, ++index, arg));
    } else if (arg === "--fail-on-not-ready") {
      failOnNotReady = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new TypeError(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("--timeout-ms must be a positive integer");
  }

  return {
    workersDevUrl: workersDevUrl ? normalizeBaseUrl(workersDevUrl) : null,
    customDomainUrl: normalizeBaseUrl(customDomainUrl),
    expectedIssuer: normalizeBaseUrl(expectedIssuer),
    timeoutMs,
    failOnNotReady,
  };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`expected an absolute URL, received ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`expected an HTTP(S) URL, received ${value}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function probeJson(
  baseUrl: string,
  path: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  const url = `${baseUrl}${path}`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeTarget(
  baseUrl: string,
  expectedIssuer: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const health = await probeJson(baseUrl, "/healthz", timeoutMs);
  const oidc = await probeJson(
    baseUrl,
    "/.well-known/openid-configuration",
    timeoutMs,
  );
  const issuer = typeof oidc.body === "object" && oidc.body !== null &&
      "issuer" in oidc.body && typeof oidc.body.issuer === "string"
    ? oidc.body.issuer
    : null;
  const persistence = typeof health.body === "object" && health.body !== null &&
      "persistence" in health.body &&
      typeof health.body.persistence === "string"
    ? health.body.persistence
    : null;
  const ok = health.ok && oidc.ok && issuer === expectedIssuer &&
    persistence === "d1+r2";
  return {
    baseUrl,
    ok,
    health,
    oidc: {
      ...oidc,
      issuer,
      issuerMatches: issuer === expectedIssuer,
    },
    persistence,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workersDev = options.workersDevUrl
    ? await probeTarget(
      options.workersDevUrl,
      options.expectedIssuer,
      options.timeoutMs,
    )
    : null;
  const customDomain = await probeTarget(
    options.customDomainUrl,
    options.expectedIssuer,
    options.timeoutMs,
  );
  const ok = (workersDev === null || Boolean(workersDev.ok)) &&
    Boolean(customDomain.ok);
  const report = {
    kind: "takosumi.cloudflare-accounts-probe@v1",
    checkedAt: new Date().toISOString(),
    ok,
    readyForLaunch: Boolean(customDomain.ok),
    expectedIssuer: options.expectedIssuer,
    workersDev,
    customDomain,
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.failOnNotReady && !report.ok) process.exit(1);
}

function printHelp(): void {
  console.log(
    `Usage: bun run deploy:accounts-cloudflare:probe -- [options]

Options:
  --workers-dev-url <url>     Optional Workers.dev URL to probe.
  --custom-domain-url <url>   Custom-domain URL. Defaults to https://accounts.takosumi.com.
  --expected-issuer <url>     Expected OIDC issuer. Defaults to https://accounts.takosumi.com.
  --timeout-ms <ms>           Per-request timeout. Defaults to 10000.
  --fail-on-not-ready         Exit non-zero when either target is not ready.
`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
import process from "node:process";
