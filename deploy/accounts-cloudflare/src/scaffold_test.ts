import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import process from "node:process";

const cloudflareRoot = new URL("../", import.meta.url);
const textDecoder = new TextDecoder();

type CommandOptions = {
  args?: readonly string[];
  clearEnv?: boolean;
  env?: Record<string, string>;
  stderr?: "piped";
  stdout?: "piped";
};

type CommandOutput = {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type TestCommand = {
  output(): Promise<CommandOutput>;
};

type TestHttpServer = {
  addr: { hostname: string; port: number };
  shutdown(): Promise<void>;
};

function bunCommand(options: CommandOptions): TestCommand {
  return command(process.execPath, {
    ...options,
    args: stripRuntimeRunArgs(options.args ?? []),
  });
}

function command(executable: string, options: CommandOptions): TestCommand {
  return {
    output: () => runCommand(executable, options),
  };
}

async function runCommand(
  executable: string,
  options: CommandOptions,
): Promise<CommandOutput> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...(options.args ?? [])], {
      env: options.clearEnv
        ? options.env ?? {}
        : { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function stripRuntimeRunArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  let reachedEntrypoint = false;
  for (let index = args[0] === "run" ? 1 : 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!reachedEntrypoint && (
      arg === "-A" ||
      arg.startsWith("--allow-") ||
      arg.startsWith("--deny-") ||
      arg.startsWith("--unstable")
    )) {
      continue;
    }
    if (!reachedEntrypoint && (
      arg === "--config" ||
      arg === "--cert" ||
      arg === "--import-map" ||
      arg === "--node-modules-dir"
    )) {
      index += 1;
      continue;
    }
    reachedEntrypoint = true;
    result.push(arg);
  }
  return result;
}

async function readTextFile(file: string | URL): Promise<string> {
  return await readFile(file, "utf8");
}

async function makeTempFile(options: { suffix?: string } = {}): Promise<string> {
  const dir = await mkdtemp(pathJoin(tmpdir(), "takosumi-accounts-cloudflare-test-"));
  const file = pathJoin(dir, `tmp${options.suffix ?? ""}`);
  await writeFile(file, "");
  return file;
}

async function removePath(
  target: string,
  options: { recursive?: boolean } = {},
): Promise<void> {
  await rm(target, { recursive: options.recursive ?? false, force: true });
}

function serveTest(
  options: { hostname?: string; port?: number; onListen?: () => void },
  fetch: (request: Request) => Response | Promise<Response>,
): TestHttpServer {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port ?? 0,
    fetch,
  });
  options.onListen?.();
  return {
    addr: { hostname: server.hostname, port: server.port },
    async shutdown() {
      server.stop(true);
    },
  };
}

test("Cloudflare Accounts scaffold is Worker-only with D1 and R2 bindings", async () => {
  const wrangler = await readTextFile(
    new URL("wrangler.toml", cloudflareRoot),
  );

  assert.match(wrangler, /\[\[d1_databases\]\]/);
  assert.match(wrangler, /binding = "TAKOSUMI_ACCOUNTS_DB"/);
  assert.match(wrangler, /\[\[r2_buckets\]\]/);
  assert.match(wrangler, /binding = "TAKOSUMI_ACCOUNTS_EXPORTS"/);
  assert.match(wrangler, /TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS/);
  assert.match(wrangler, /no_bundle = true/);
  assert.match(wrangler, /bun build --target browser/);
  assert.doesNotMatch(wrangler, /\[\[containers\]\]/);
  assert.doesNotMatch(wrangler, /\[\[durable_objects\.bindings\]\]/);
  assert.doesNotMatch(wrangler, /new_sqlite_classes/);
});

test("Cloudflare Accounts scaffold docs describe direct Worker routes", async () => {
  const readme = await readTextFile(
    new URL("README.md", cloudflareRoot),
  );

  assert.match(readme, /Worker-only/);
  assert.match(readme, /D1AccountsStore/);
  assert.match(readme, /R2-backed\s+metadata export worker/);
  assert.match(readme, /deploy:accounts-cloudflare:render-config/);
  assert.match(readme, /deploy:accounts-cloudflare:probe/);
  assert.match(readme, /deploy:accounts-cloudflare:ensure-dns/);
  assert.match(readme, /takosumi\.cloudflare-dns-record-plan@v1/);
  assert.match(readme, /deploy:accounts-cloudflare:probe[\s\S]*--fail-on-not-ready/);
  assert.match(readme, /TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME/);
  assert.match(readme, /TAKOSUMI_ACCOUNTS_INSTALLER_URL/);
  assert.match(
    readme,
    /TAKOSUMI_ACCOUNTS_D1_DATABASE_ID=<uuid>[\s\S]+TAKOSUMI_ACCOUNTS_INSTALLER_URL=https:\/\/<takosumi-installer-host>[\s\S]+deploy:accounts-cloudflare:render-config/,
  );
  assert.match(
    readme,
    /Both deploy tasks first run `deploy:accounts-cloudflare:validate-config`/,
  );
  assert.match(readme, /rejects placeholder D1 UUIDs/);
  assert.match(readme, /TAKOSUMI_ACCOUNTS_INSTALLER_TOKEN/);
  assert.match(readme, /cloudflareApiBaseUrlDefault|live default/);
  assert.match(readme, /readyForLaunch:false/);
  assert.match(readme, /createEphemeralAccountsHandler/);
  assert.match(
    readme,
    /does not require KV,\s+Pages,\s+Durable Object,\s+or Container permissions/,
  );
  assert.match(
    readme,
    /wrangler r2 bucket create takosumi-accounts-exports/,
  );
  assert.match(readme, /No container runtime package/);
  assert.doesNotMatch(readme, /Cloudflare Container/);
  assert.doesNotMatch(readme, /Workers KV Storage:Edit/);
  assert.doesNotMatch(readme, /Pages:Edit/);
});

test("Cloudflare Accounts deploy tasks use the rendered config by default", async () => {
  const packageJson = JSON.parse(
    await readTextFile(new URL("../../package.json", cloudflareRoot)),
  ) as { scripts?: Record<string, string> };
  const tasks = packageJson.scripts ?? {};
  const deployTask = tasks["deploy:accounts-cloudflare"] ?? "";
  const dryRunTask = tasks["deploy:accounts-cloudflare:dryrun"] ?? "";
  const templateTask = tasks["deploy:accounts-cloudflare:template"] ?? "";
  const validateTask = tasks["deploy:accounts-cloudflare:validate-config"] ?? "";

  assert.match(
    validateTask,
    /validate-rendered-config\.ts/,
  );
  assert.match(
    deployTask,
    /deploy:accounts-cloudflare:validate-config[\s\S]+\.wrangler\/takosumi-accounts\.deploy\.toml/,
  );
  assert.match(
    dryRunTask,
    /deploy:accounts-cloudflare:validate-config[\s\S]+\.wrangler\/takosumi-accounts\.deploy\.toml/,
  );
  assert.match(
    templateTask,
    /deploy\/accounts-cloudflare\/wrangler\.toml/,
  );
});

test("Cloudflare rendered config validation rejects template placeholders", async () => {
  const script = new URL(
    "scripts/validate-rendered-config.ts",
    cloudflareRoot,
  ).pathname;
  const command = bunCommand( {
    args: [
      "run",
      "--allow-read",
      script,
      "--config",
      new URL("wrangler.toml", cloudflareRoot).pathname,
    ],
    stderr: "piped",
    stdout: "piped",
  });
  const result = await command.output();
  const stderr = textDecoder.decode(result.stderr);
  assert.equal(result.code, 1, stderr);
  const report = JSON.parse(textDecoder.decode(result.stdout)) as {
    ok?: boolean;
    errors?: string[];
    configDigest?: string;
    d1BindingPresent?: boolean;
    d1DatabaseIdPlaceholder?: boolean;
    r2BindingPresent?: boolean;
    containerConfigured?: boolean;
    durableObjectPersistenceConfigured?: boolean;
    managedOfferingAccessClosed?: boolean;
  };
  assert.equal(report.ok, false);
  assert.match(report.configDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.d1BindingPresent, true);
  assert.equal(report.d1DatabaseIdPlaceholder, true);
  assert.equal(report.r2BindingPresent, true);
  assert.equal(report.containerConfigured, false);
  assert.equal(report.durableObjectPersistenceConfigured, false);
  assert.equal(report.managedOfferingAccessClosed, true);
  assert(
    report.errors?.some((error) => error.includes("placeholder UUID")),
  );
  assert(
    report.errors?.some((error) =>
      error.includes("TAKOSUMI_ACCOUNTS_INSTALLER_URL")
    ),
  );
});

test("Cloudflare probe reports launch-ready D1/R2 Accounts endpoints", async () => {
  const fixture = serveProbeFixture({
    issuer: "https://accounts.takosumi.com",
    persistence: "d1+r2",
  });
  try {
    const result = await runProbe({
      customDomainUrl: fixture.url,
      expectedIssuer: "https://accounts.takosumi.com",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.report.kind,
      "takosumi.cloudflare-accounts-probe@v1",
    );
    assert.equal(result.report.ok, true);
    assert.equal(result.report.readyForLaunch, true);
    assert.equal(result.report.customDomain?.persistence, "d1+r2");
    assert.equal(result.report.customDomain?.oidc?.issuerMatches, true);
  } finally {
    await fixture.server.shutdown();
  }
});

test("Cloudflare probe reports issuer and persistence blockers", async () => {
  const issuerMismatch = serveProbeFixture({
    issuer: "https://wrong.example.test",
    persistence: "d1+r2",
  });
  try {
    const result = await runProbe({
      customDomainUrl: issuerMismatch.url,
      expectedIssuer: "https://accounts.takosumi.com",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.report.ok, false);
    assert.equal(result.report.readyForLaunch, false);
    assert.equal(result.report.customDomain?.oidc?.issuerMatches, false);
  } finally {
    await issuerMismatch.server.shutdown();
  }

  const persistenceMismatch = serveProbeFixture({
    issuer: "https://accounts.takosumi.com",
    persistence: "memory",
  });
  try {
    const result = await runProbe({
      customDomainUrl: persistenceMismatch.url,
      expectedIssuer: "https://accounts.takosumi.com",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.report.ok, false);
    assert.equal(result.report.readyForLaunch, false);
    assert.equal(result.report.customDomain?.persistence, "memory");
  } finally {
    await persistenceMismatch.server.shutdown();
  }
});

test("Cloudflare probe can fail the shell when not launch-ready", async () => {
  const fixture = serveProbeFixture({
    issuer: "https://accounts.takosumi.com",
    persistence: "memory",
  });
  try {
    const result = await runProbe({
      customDomainUrl: fixture.url,
      expectedIssuer: "https://accounts.takosumi.com",
      failOnNotReady: true,
    });
    assert.equal(result.code, 1);
    assert.equal(result.report.ok, false);
  } finally {
    await fixture.server.shutdown();
  }
});

test("Cloudflare DNS script prints a tokenless proxied CNAME plan", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const command = bunCommand( {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      script,
      "--record-name",
      "accounts.takosumi.com",
      "--target",
      "takosumi-accounts.example.workers.dev",
    ],
    stderr: "piped",
    stdout: "piped",
  });
  const result = await command.output();
  const stderr = textDecoder.decode(result.stderr);
  assert.equal(result.code, 0, stderr);
  const report = JSON.parse(textDecoder.decode(result.stdout)) as {
    kind?: string;
    ok?: boolean;
    cloudflareApiBaseUrlDefault?: boolean;
    plannedRecord?: {
      type?: string;
      name?: string;
      content?: string;
      proxied?: boolean;
    };
  };
  assert.equal(
    report.kind,
    "takosumi.cloudflare-dns-record-plan@v1",
  );
  assert.equal(report.ok, true);
  assert.equal(report.cloudflareApiBaseUrlDefault, true);
  assert.equal(report.plannedRecord?.type, "CNAME");
  assert.equal(report.plannedRecord?.name, "accounts.takosumi.com");
  assert.equal(
    report.plannedRecord?.content,
    "takosumi-accounts.example.workers.dev",
  );
  assert.equal(report.plannedRecord?.proxied, true);
});

test("Cloudflare DNS script requires an explicit CNAME target", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const command = bunCommand( {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      script,
      "--record-name",
      "accounts.takosumi.com",
    ],
    clearEnv: true,
    stderr: "piped",
    stdout: "piped",
  });
  const result = await command.output();
  const stderr = textDecoder.decode(result.stderr);
  assert.equal(result.code, 1);
  assert.match(
    stderr,
    /--target or TAKOSUMI_ACCOUNTS_WORKERS_DEV_HOSTNAME is required/,
  );
});

function serveProbeFixture(input: {
  issuer: string;
  persistence: string;
}): { url: string; server: TestHttpServer } {
  const server = serveTest({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, persistence: input.persistence });
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer: input.issuer });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    server,
  };
}

async function runProbe(input: {
  customDomainUrl: string;
  expectedIssuer: string;
  failOnNotReady?: boolean;
}): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  report: {
    kind?: string;
    ok?: boolean;
    readyForLaunch?: boolean;
    customDomain?: {
      persistence?: string | null;
      oidc?: { issuerMatches?: boolean };
    };
  };
}> {
  const script = new URL("scripts/probe.ts", cloudflareRoot).pathname;
  const command = bunCommand( {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      script,
      "--custom-domain-url",
      input.customDomainUrl,
      "--expected-issuer",
      input.expectedIssuer,
      "--timeout-ms",
      "1000",
      ...(input.failOnNotReady ? ["--fail-on-not-ready"] : []),
    ],
    clearEnv: true,
    stderr: "piped",
    stdout: "piped",
  });
  const output = await command.output();
  const stdout = textDecoder.decode(output.stdout);
  const stderr = textDecoder.decode(output.stderr);
  return {
    code: output.code,
    stdout,
    stderr,
    report: JSON.parse(stdout),
  };
}

test("Cloudflare DNS script derives the CNAME target from Workers.dev URL env", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const command = bunCommand( {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      script,
      "--record-name",
      "accounts.takosumi.com",
    ],
    clearEnv: true,
    env: {
      TAKOSUMI_ACCOUNTS_WORKERS_DEV_URL:
        "https://takosumi-accounts.example.workers.dev",
    },
    stderr: "piped",
    stdout: "piped",
  });
  const result = await command.output();
  const stderr = textDecoder.decode(result.stderr);
  assert.equal(result.code, 0, stderr);
  const report = JSON.parse(textDecoder.decode(result.stdout)) as {
    plannedRecord?: { content?: string };
  };
  assert.equal(
    report.plannedRecord?.content,
    "takosumi-accounts.example.workers.dev",
  );
});

test("Cloudflare DNS script reports missing checked CNAME as not ok", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const server = serveTest(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        return Response.json({ success: true, result: [] });
      }
      return Response.json(
        { success: false, errors: [{ code: "unexpected-test-route" }] },
        { status: 404 },
      );
    },
  );
  try {
    const apiBaseUrl =
      `http://${server.addr.hostname}:${server.addr.port}/client/v4`;
    const command = bunCommand( {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        script,
        "--zone-id",
        "zone-test",
        "--record-name",
        "accounts.takosumi.com",
        "--target",
        "takosumi-accounts.example.workers.dev",
        "--check",
      ],
      clearEnv: true,
      env: {
        CLOUDFLARE_API_TOKEN: "test-token",
        TAKOSUMI_CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      },
      stderr: "piped",
      stdout: "piped",
    });
    const result = await command.output();
    const stderr = textDecoder.decode(result.stderr);
    assert.equal(result.code, 0, stderr);
    const report = JSON.parse(textDecoder.decode(result.stdout)) as {
      ok?: boolean;
      action?: string;
      recordLookup?: { success?: boolean; recordCount?: number };
    };
    assert.equal(report.ok, false);
    assert.equal(report.action, "create");
    assert.equal(report.recordLookup?.success, true);
    assert.equal(report.recordLookup?.recordCount, 0);
  } finally {
    await server.shutdown();
  }
});

test("Cloudflare DNS script can fail when checked CNAME is missing", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const server = serveTest(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        return Response.json({ success: true, result: [] });
      }
      return Response.json(
        { success: false, errors: [{ code: "unexpected-test-route" }] },
        { status: 404 },
      );
    },
  );
  try {
    const apiBaseUrl =
      `http://${server.addr.hostname}:${server.addr.port}/client/v4`;
    const command = bunCommand( {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        script,
        "--zone-id",
        "zone-test",
        "--record-name",
        "accounts.takosumi.com",
        "--target",
        "takosumi-accounts.example.workers.dev",
        "--check",
        "--fail-on-not-ready",
      ],
      clearEnv: true,
      env: {
        CLOUDFLARE_API_TOKEN: "test-token",
        TAKOSUMI_CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      },
      stderr: "piped",
      stdout: "piped",
    });
    const result = await command.output();
    const report = JSON.parse(textDecoder.decode(result.stdout)) as {
      ok?: boolean;
      action?: string;
    };
    assert.equal(result.code, 1);
    assert.equal(report.ok, false);
    assert.equal(report.action, "create");
  } finally {
    await server.shutdown();
  }
});

test("Cloudflare DNS script reports DNS permission hints", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const server = serveTest(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        return Response.json(
          { success: false, errors: [{ code: 10000 }] },
          { status: 403 },
        );
      }
      return Response.json(
        { success: false, errors: [{ code: "unexpected-test-route" }] },
        { status: 404 },
      );
    },
  );
  try {
    const apiBaseUrl =
      `http://${server.addr.hostname}:${server.addr.port}/client/v4`;
    const command = bunCommand( {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        script,
        "--zone-id",
        "zone-test",
        "--record-name",
        "accounts.takosumi.com",
        "--target",
        "takosumi-accounts.example.workers.dev",
        "--check",
        "--fail-on-not-ready",
      ],
      clearEnv: true,
      env: {
        CLOUDFLARE_API_TOKEN: "test-token",
        TAKOSUMI_CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      },
      stderr: "piped",
      stdout: "piped",
    });
    const result = await command.output();
    const report = JSON.parse(textDecoder.decode(result.stdout)) as {
      ok?: boolean;
      zoneId?: string;
      recordLookup?: {
        status?: number;
        errorCodes?: unknown[];
        permissionHint?: {
          phase?: string;
          reason?: string;
          requiredPermission?: string;
          credential?: string;
        };
      };
    };
    assert.equal(result.code, 1);
    assert.equal(report.ok, false);
    assert.equal(report.zoneId, undefined);
    assert.equal(report.recordLookup?.status, 403);
    assert.deepEqual(report.recordLookup?.errorCodes, [10000]);
    assert.equal(report.recordLookup?.permissionHint?.phase, "recordLookup");
    assert.equal(
      report.recordLookup?.permissionHint?.reason,
      "cloudflare-dns-permission-required",
    );
    assert.match(
      report.recordLookup?.permissionHint?.requiredPermission ?? "",
      /Zone:DNS Read/,
    );
    assert.equal(
      report.recordLookup?.permissionHint?.credential,
      "CLOUDFLARE_API_TOKEN or CF_API_TOKEN",
    );
  } finally {
    await server.shutdown();
  }
});

test("Cloudflare DNS script refuses apply when record lookup fails", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  let writeCount = 0;
  const server = serveTest(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        request.method === "GET" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        return Response.json(
          { success: false, errors: [{ code: 10000 }] },
          { status: 403 },
        );
      }
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        (request.method === "POST" || request.method === "PUT") &&
        url.pathname.startsWith("/client/v4/zones/zone-test/dns_records")
      ) {
        writeCount += 1;
        return Response.json({ success: true, result: {} });
      }
      return Response.json(
        { success: false, errors: [{ code: "unexpected-test-route" }] },
        { status: 404 },
      );
    },
  );
  try {
    const apiBaseUrl =
      `http://${server.addr.hostname}:${server.addr.port}/client/v4`;
    const command = bunCommand( {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        script,
        "--zone-id",
        "zone-test",
        "--record-name",
        "accounts.takosumi.com",
        "--target",
        "takosumi-accounts.example.workers.dev",
        "--apply",
      ],
      clearEnv: true,
      env: {
        CLOUDFLARE_API_TOKEN: "test-token",
        TAKOSUMI_CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      },
      stderr: "piped",
      stdout: "piped",
    });
    const result = await command.output();
    const report = JSON.parse(textDecoder.decode(result.stdout)) as {
      ok?: boolean;
      action?: string;
      applySkipped?: string;
      upsert?: unknown;
      recordLookup?: { status?: number; permissionHint?: { phase?: string } };
    };
    assert.equal(result.code, 1);
    assert.equal(report.ok, false);
    assert.equal(report.action, "lookup-failed");
    assert.match(report.applySkipped ?? "", /Zone:DNS Read/);
    assert.equal(report.recordLookup?.status, 403);
    assert.equal(report.recordLookup?.permissionHint?.phase, "recordLookup");
    assert.equal(report.upsert, undefined);
    assert.equal(writeCount, 0);
  } finally {
    await server.shutdown();
  }
});

test("Cloudflare DNS script reports matching checked CNAME as ok", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const server = serveTest(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        return Response.json({
          success: true,
          result: [{
            id: "record-test",
            type: "CNAME",
            name: "accounts.takosumi.com",
            content: "takosumi-accounts.example.workers.dev",
            proxied: true,
            ttl: 1,
          }],
        });
      }
      return Response.json(
        { success: false, errors: [{ code: "unexpected-test-route" }] },
        { status: 404 },
      );
    },
  );
  try {
    const apiBaseUrl =
      `http://${server.addr.hostname}:${server.addr.port}/client/v4`;
    const command = bunCommand( {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        script,
        "--zone-id",
        "zone-test",
        "--record-name",
        "accounts.takosumi.com",
        "--target",
        "takosumi-accounts.example.workers.dev",
        "--check",
      ],
      clearEnv: true,
      env: {
        CLOUDFLARE_API_TOKEN: "test-token",
        TAKOSUMI_CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      },
      stderr: "piped",
      stdout: "piped",
    });
    const result = await command.output();
    const stderr = textDecoder.decode(result.stderr);
    assert.equal(result.code, 0, stderr);
    const report = JSON.parse(textDecoder.decode(result.stdout)) as {
      ok?: boolean;
      action?: string;
      zoneId?: string;
      zoneResolved?: boolean;
      cloudflareApiBaseUrl?: string;
      cloudflareApiBaseUrlDefault?: boolean;
      existingRecord?: { id?: string; content?: string; proxied?: boolean };
    };
    assert.equal(report.ok, true);
    assert.equal(report.zoneResolved, true);
    assert.equal(report.zoneId, undefined);
    assert.equal(report.cloudflareApiBaseUrl, apiBaseUrl);
    assert.equal(report.cloudflareApiBaseUrlDefault, false);
    assert.equal(report.action, "none");
    assert.equal(report.existingRecord?.id, undefined);
    assert.equal(
      report.existingRecord?.content,
      "takosumi-accounts.example.workers.dev",
    );
    assert.equal(report.existingRecord?.proxied, true);
  } finally {
    await server.shutdown();
  }
});

test("Cloudflare DNS script applies a missing proxied CNAME", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const server = serveTest(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        request.method === "GET" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        return Response.json({ success: true, result: [] });
      }
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        request.method === "POST" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.type, "CNAME");
        assert.equal(body.name, "accounts.takosumi.com");
        assert.equal(
          body.content,
          "takosumi-accounts.example.workers.dev",
        );
        assert.equal(body.proxied, true);
        assert.equal(body.ttl, 1);
        return Response.json({
          success: true,
          result: { id: "created-record" },
        });
      }
      return Response.json(
        { success: false, errors: [{ code: "unexpected-test-route" }] },
        { status: 404 },
      );
    },
  );
  try {
    const apiBaseUrl =
      `http://${server.addr.hostname}:${server.addr.port}/client/v4`;
    const command = bunCommand( {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        script,
        "--zone-id",
        "zone-test",
        "--record-name",
        "accounts.takosumi.com",
        "--target",
        "takosumi-accounts.example.workers.dev",
        "--apply",
      ],
      clearEnv: true,
      env: {
        CLOUDFLARE_API_TOKEN: "test-token",
        TAKOSUMI_CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      },
      stderr: "piped",
      stdout: "piped",
    });
    const result = await command.output();
    const stderr = textDecoder.decode(result.stderr);
    assert.equal(result.code, 0, stderr);
    const report = JSON.parse(textDecoder.decode(result.stdout)) as {
      ok?: boolean;
      mode?: string;
      action?: string;
      upsert?: { status?: number; success?: boolean };
    };
    assert.equal(report.ok, true);
    assert.equal(report.mode, "apply");
    assert.equal(report.action, "create");
    assert.equal(report.upsert?.status, 200);
    assert.equal(report.upsert?.success, true);
  } finally {
    await server.shutdown();
  }
});

test("Cloudflare DNS script applies a drifted proxied CNAME update", async () => {
  const script = new URL("scripts/ensure-dns.ts", cloudflareRoot).pathname;
  const server = serveTest(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        request.method === "GET" &&
        url.pathname === "/client/v4/zones/zone-test/dns_records"
      ) {
        return Response.json({
          success: true,
          result: [{
            id: "record-test",
            type: "CNAME",
            name: "accounts.takosumi.com",
            content: "old-target.example.com",
            proxied: false,
            ttl: 1,
          }],
        });
      }
      if (
        request.headers.get("authorization") === "Bearer test-token" &&
        request.method === "PUT" &&
        url.pathname ===
          "/client/v4/zones/zone-test/dns_records/record-test"
      ) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(
          body.content,
          "takosumi-accounts.example.workers.dev",
        );
        assert.equal(body.proxied, true);
        return Response.json({
          success: true,
          result: { id: "record-test" },
        });
      }
      return Response.json(
        { success: false, errors: [{ code: "unexpected-test-route" }] },
        { status: 404 },
      );
    },
  );
  try {
    const apiBaseUrl =
      `http://${server.addr.hostname}:${server.addr.port}/client/v4`;
    const command = bunCommand( {
      args: [
        "run",
        "--allow-net",
        "--allow-env",
        script,
        "--zone-id",
        "zone-test",
        "--record-name",
        "accounts.takosumi.com",
        "--target",
        "takosumi-accounts.example.workers.dev",
        "--apply",
      ],
      clearEnv: true,
      env: {
        CLOUDFLARE_API_TOKEN: "test-token",
        TAKOSUMI_CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      },
      stderr: "piped",
      stdout: "piped",
    });
    const result = await command.output();
    const stderr = textDecoder.decode(result.stderr);
    assert.equal(result.code, 0, stderr);
    const report = JSON.parse(textDecoder.decode(result.stdout)) as {
      ok?: boolean;
      mode?: string;
      action?: string;
      zoneId?: string;
      zoneResolved?: boolean;
      existingRecord?: { id?: string; content?: string; proxied?: boolean };
      upsert?: { status?: number; success?: boolean };
    };
    assert.equal(report.ok, true);
    assert.equal(report.zoneResolved, true);
    assert.equal(report.zoneId, undefined);
    assert.equal(report.mode, "apply");
    assert.equal(report.action, "update");
    assert.equal(report.existingRecord?.id, undefined);
    assert.equal(report.existingRecord?.content, "old-target.example.com");
    assert.equal(report.existingRecord?.proxied, false);
    assert.equal(report.upsert?.status, 200);
    assert.equal(report.upsert?.success, true);
  } finally {
    await server.shutdown();
  }
});

test("Cloudflare render-config writes an ignored deploy config with real D1 binding", async () => {
  const output = await makeTempFile({ suffix: ".toml" });
  await removePath(output);
  const script = new URL("scripts/render-config.ts", cloudflareRoot).pathname;
  const databaseId = "804a6bce-5c37-4792-be3f-0c2d87cc5a6e";
  const installerUrl = "https://installer.takosumi.com";
  const command = bunCommand( {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      script,
      "--database-id",
      databaseId,
      "--installer-url",
      installerUrl,
      "--output",
      output,
      "--workers-dev",
    ],
    stderr: "piped",
    stdout: "piped",
  });
  const result = await command.output();
  const stderr = textDecoder.decode(result.stderr);
  assert.equal(result.code, 0, stderr);

  try {
    const rendered = await readTextFile(output);
    assert.match(rendered, new RegExp(`database_id = "${databaseId}"`));
    assert.match(
      rendered,
      new RegExp(`TAKOSUMI_ACCOUNTS_INSTALLER_URL = "${installerUrl}"`),
    );
    assert.match(rendered, /workers_dev = true/);
    assert.match(rendered, /main = ".*takosumi-accounts-worker\.mjs"/);
    assert.doesNotMatch(rendered, /^\[\[routes\]\]/m);
    assert.match(rendered, /binding = "TAKOSUMI_ACCOUNTS_DB"/);
    assert.match(rendered, /binding = "TAKOSUMI_ACCOUNTS_EXPORTS"/);
  } finally {
    await removePath(output, { recursive: true });
  }
});

test("Cloudflare rendered config validation accepts a live-shaped rendered config", async () => {
  const output = await makeTempFile({ suffix: ".toml" });
  await removePath(output);
  const renderScript = new URL("scripts/render-config.ts", cloudflareRoot)
    .pathname;
  const validateScript = new URL(
    "scripts/validate-rendered-config.ts",
    cloudflareRoot,
  ).pathname;
  const databaseId = "804a6bce-5c37-4792-be3f-0c2d87cc5a6e";
  const installerUrl = "https://installer.takosumi.com";
  const render = await bunCommand( {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      renderScript,
      "--database-id",
      databaseId,
      "--installer-url",
      installerUrl,
      "--output",
      output,
      "--workers-dev",
    ],
    stderr: "piped",
    stdout: "piped",
  }).output();
  assert.equal(render.code, 0, textDecoder.decode(render.stderr));

  try {
    const validate = await bunCommand( {
      args: [
        "run",
        "--allow-read",
        validateScript,
        "--config",
        output,
      ],
      stderr: "piped",
      stdout: "piped",
    }).output();
    assert.equal(validate.code, 0, textDecoder.decode(validate.stderr));
    const report = JSON.parse(textDecoder.decode(validate.stdout)) as {
      ok?: boolean;
      errors?: string[];
      configDigest?: string;
      mainPointsAtWorkerBundle?: boolean;
      managedOfferingAccessClosed?: boolean;
      d1BindingPresent?: boolean;
      d1DatabaseBlockPresent?: boolean;
      d1DatabaseIdPresent?: boolean;
      d1DatabaseIdValid?: boolean;
      d1DatabaseIdPlaceholder?: boolean;
      r2BindingPresent?: boolean;
      r2BucketBlockPresent?: boolean;
      installerUrlPresent?: boolean;
      installerUrlValid?: boolean;
      installerUrlPlaceholder?: boolean;
      containerConfigured?: boolean;
      durableObjectPersistenceConfigured?: boolean;
      workersDev?: boolean | null;
      routeConfigured?: boolean;
    };
    assert.equal(report.ok, true);
    assert.deepEqual(report.errors, []);
    assert.match(report.configDigest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.mainPointsAtWorkerBundle, true);
    assert.equal(report.managedOfferingAccessClosed, true);
    assert.equal(report.d1BindingPresent, true);
    assert.equal(report.d1DatabaseBlockPresent, true);
    assert.equal(report.d1DatabaseIdPresent, true);
    assert.equal(report.d1DatabaseIdValid, true);
    assert.equal(report.d1DatabaseIdPlaceholder, false);
    assert.equal(report.r2BindingPresent, true);
    assert.equal(report.r2BucketBlockPresent, true);
    assert.equal(report.installerUrlPresent, true);
    assert.equal(report.installerUrlValid, true);
    assert.equal(report.installerUrlPlaceholder, false);
    assert.equal(report.containerConfigured, false);
    assert.equal(report.durableObjectPersistenceConfigured, false);
    assert.equal(report.workersDev, true);
    assert.equal(report.routeConfigured, false);
  } finally {
    await removePath(output, { recursive: true });
  }
});

test("Cloudflare render-config can keep Workers.dev while attaching routes", async () => {
  const output = await makeTempFile({ suffix: ".toml" });
  await removePath(output);
  const script = new URL("scripts/render-config.ts", cloudflareRoot).pathname;
  const databaseId = "804a6bce-5c37-4792-be3f-0c2d87cc5a6e";
  const installerUrl = "https://installer.takosumi.com";
  const command = bunCommand( {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      script,
      "--database-id",
      databaseId,
      "--installer-url",
      installerUrl,
      "--output",
      output,
      "--workers-dev-with-routes",
    ],
    stderr: "piped",
    stdout: "piped",
  });
  const result = await command.output();
  const stderr = textDecoder.decode(result.stderr);
  assert.equal(result.code, 0, stderr);

  try {
    const rendered = await readTextFile(output);
    assert.match(rendered, /workers_dev = true/);
    assert.match(rendered, /^\[\[routes\]\]/m);
    assert.match(rendered, /pattern = "accounts\.takosumi\.com\/\*"/);
    assert.match(rendered, new RegExp(`database_id = "${databaseId}"`));
  } finally {
    await removePath(output, { recursive: true });
  }
});
