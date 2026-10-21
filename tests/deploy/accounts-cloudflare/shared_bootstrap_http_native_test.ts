import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_ISSUER, AUTH_STAGING_WORKER } from "../../../deploy/accounts-cloudflare/src/staging-target.ts";

const require = createRequire(import.meta.url);
/** Bound only this test's newly spawned group. Successful native hosts exit
 * through dispose; a broken fixture cannot outlive Bun's own test timeout. */
async function runOwnedChild(command: string, args: string[], timeoutMs: number, env = process.env) {
  const child = spawn(command, args, { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const signalOwnedGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    signalOwnedGroup("SIGTERM");
    escalation = setTimeout(() => signalOwnedGroup("SIGKILL"), 2_000);
  }, timeoutMs);
  try { return { code: await closed, stdout, stderr, timedOut }; }
  finally {
    clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    if (child.exitCode === null && child.signalCode === null) {
      signalOwnedGroup("SIGKILL");
      await closed;
    }
  }
}

const clients = AUTH_STAGING_CLIENTS.map((client) => ({ ...client, allowedScopes: ["openid", "email", "offline_access"], tokenEndpointAuthMethod: "client_secret_basic", enabled: true, profile: "shared-account" }));
const bindings = {
  TAKOSUMI_ENVIRONMENT: "staging",
  TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: "true",
  TAKOSUMI_AUTH_WORKER_NAME: AUTH_STAGING_WORKER,
  TAKOSUMI_ACCOUNTS_ISSUER: AUTH_STAGING_ISSUER,
  TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
  TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
  TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
  TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY: "takoserver.hosted.staging-test.v1",
  TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(clients),
  TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
    { providerId: "google", protocol: "oidc", verificationProfile: "google-oidc", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
    { providerId: "github", protocol: "oauth2", verificationProfile: "github-oauth", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
  ]),
  TAKOSUMI_VERSION_METADATA: { id: "fixture-bootstrap-native" },
  ...Object.fromEntries(["R2_ARTIFACTS", "R2_SOURCE", "R2_STATE", "R2_BACKUPS", "COORDINATION", "RUN_OWNER", "RUNNER"].map((name) => [name, {}])),
  ...Object.fromEntries(["TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT", "TAKOSUMI_ACCOUNTS_HOSTED_STAGE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET", "TAKOSUMI_SECRET_STORE_PASSPHRASE", "TAKOSUMI_DEPLOY_CONTROL_TOKEN"].map((name) => [name, "fixture-only-not-a-real-secret-32-bytes"])),
};

for (const mode of ["baseline","disconnect","organization"]) test(`native default Accounts HTTP bootstrap ${mode} preserves its original lifetime`, async () => {
  const signingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", signingKey.privateKey);
  const fixtureBindings = { ...bindings, TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(privateJwk) };
  const directory = await mkdtemp(join(tmpdir(), "takosumi-bootstrap-http-native-"));
  try {
    const buildRunner = join(directory, "build.mjs");
    await writeFile(buildRunner, `import { readFile, writeFile } from "node:fs/promises";\nconst input = JSON.parse(await readFile(process.argv[2], "utf8"));\nconst result = await Bun.build({ entrypoints: [input.entrypoint], root: input.root, target: input.target, format: "esm", external: input.external ?? [] });\nif (!result.success) { console.error(JSON.stringify({ stage: input.stage, success: false, logs: result.logs.map(String) })); process.exitCode = 1; } else if (!result.outputs[0]) { console.error(JSON.stringify({ stage: input.stage, success: false, failure: "build_output_missing" })); process.exitCode = 1; } else { await writeFile(input.outfile, new Uint8Array(await result.outputs[0].arrayBuffer())); console.log(JSON.stringify({ stage: input.stage, success: true, outputWritten: true })); }\n`, { mode: 0o600 });
    const build = async (stage: string, entrypoint: string, target: "browser" | "node", outfile: string, external: string[] = []) => {
      const input = join(directory, `${stage}.json`);
      await writeFile(input, JSON.stringify({ stage, entrypoint, root: resolve(import.meta.dir, "../../.."), target, outfile, external }), { mode: 0o600 });
      const buildEnv = { ...process.env };
      delete buildEnv.TMPDIR;
      const result = await runOwnedChild(process.execPath, [buildRunner, input], 20_000, buildEnv);
      expect(result.timedOut, `${stage} build deadline`).toBe(false);
      expect(result.code, `${stage} build failed\n${result.stderr}${result.stdout}`).toBe(0);
    };
    const workerPath = resolve(import.meta.dir, "fixtures/shared-bootstrap-http-native-worker.ts");
    const hostPath = resolve(import.meta.dir, "fixtures/shared-bootstrap-http-native-host.ts");
    const workerBundle = join(directory, "worker.mjs"), hostBundle = join(directory, "host.mjs"), input = join(directory, "fixture.json");
    await build("worker", workerPath, "browser", workerBundle, ["cloudflare:workers"]);
    await build("host", hostPath, "node", hostBundle);
    await writeFile(input, JSON.stringify({ mode, workerSource: await readFile(workerBundle, "utf8"), bindings: fixtureBindings, issuer: AUTH_STAGING_ISSUER, compatibilityDate: "2026-04-01", miniflareModuleUrl: pathToFileURL(require.resolve("miniflare")).href }), { mode: 0o600 });
    const { code, stdout, stderr, timedOut } = await runOwnedChild("node", [hostBundle, input], 60_000);
    expect(timedOut, "owned native host deadline").toBe(false);
    expect(code, stderr + stdout).toBe(0);
    const phaseRows = (stderr + stdout).split("\n").flatMap((line) => {
      const start = line.indexOf('{"event":"request_phase"');
      if (start < 0) return [];
      try { return [JSON.parse(line.slice(start)) as {route:string;phase:string;outcome:string}]; } catch { return []; }
    });
    const bootstrapRows = phaseRows.filter((row) => row.route === "/api/v1/account/shared-workspaces/bootstrap");
    for (const phase of ["issuer_schema","accounts_init","allowlist","shared_workspace_auth","shared_workspace_dispatch"]) {
      expect(bootstrapRows.some((row) => row.phase === phase && row.outcome === "started")).toBe(true);
      expect(bootstrapRows.some((row) => row.phase === phase && row.outcome === "fulfilled")).toBe(true);
    }
    if (mode === "disconnect") expect(bootstrapRows.some((row) => row.phase === "shared_workspace_dispatch" && row.outcome === "pending")).toBe(true);
    if (mode === "organization") {
      const organizationRows = phaseRows.filter((row) => row.route === "/api/v1/account/shared-workspaces/{workspaceId}/billing-organization");
      for (const phase of ["issuer_schema", "accounts_init", "allowlist", "shared_workspace_auth", "shared_workspace_dispatch"]) {
        expect(organizationRows.some((row) => row.phase === phase && row.outcome === "started")).toBe(true);
        expect(organizationRows.some((row) => row.phase === phase && row.outcome === "fulfilled")).toBe(true);
      }
    }
    const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(report).toMatchObject({ schema: "accounts.bootstrap.native.fixture.v1", localSyntheticD1: true, authorityOrStagingQualification: false, ...(mode === "disconnect" ? {readOnlyFollowupStatus:200,gateFinished:true} : {responseStatus: 200, terminalOracleQualified: true}) });
    if (mode === "organization") expect(report).toMatchObject({ organization: { status: 200, exactShape: true, durableOriginalMatches: true, bindingRows: 1, intentRows: 1, method: "GET" } });
    console.info(JSON.stringify({ event: "accounts_bootstrap_native_baseline", ...report }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);
