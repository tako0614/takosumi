import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { identityContextFixture, acceptIsolatedIdentityContexts, contextA, contextB } from "../../accounts/service/fixtures/identity-context-fixture.ts";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_ISSUER, AUTH_STAGING_WORKER } from "../../../deploy/accounts-cloudflare/src/staging-target.ts";
import { sha256Text } from "../../../accounts/service/src/encoding.ts";

const salt = "fixture-owner-admission-session-salt";
const serviceId = "fixture-private-hosted-owner";
const require = createRequire(import.meta.url);

test("two actual Workers use the private named admission entry; public credentials and incomplete schema cannot acquire it", async () => {
  const build = async (entry: string) => {
    const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, entry)], target: "browser", format: "esm", external: ["cloudflare:workers"] });
    expect(result.success, result.logs.map(String).join("\n")).toBe(true);
    return await result.outputs[0]!.text();
  };
  const targetDigest = await sha256Text("fixture-fixed-private-target");
  const bindings = {
    TAKOSUMI_ENVIRONMENT: "staging", TAKOSUMI_AUTH_WORKER_NAME: AUTH_STAGING_WORKER, TAKOSUMI_ACCOUNTS_ISSUER: AUTH_STAGING_ISSUER,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
    TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID: serviceId, TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST: targetDigest,
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: salt,
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(AUTH_STAGING_CLIENTS.map((client) => ({ ...client, allowedScopes: ["openid", "email", "offline_access"], tokenEndpointAuthMethod: "client_secret_basic", enabled: true, profile: "shared-account" }))),
    TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
      { providerId: "google", protocol: "oidc", verificationProfile: "google-oidc", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
      { providerId: "github", protocol: "oauth2", verificationProfile: "github-oauth", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
    ]),
    ...Object.fromEntries(["R2_ARTIFACTS", "R2_SOURCE", "R2_STATE", "R2_BACKUPS", "COORDINATION", "RUN_OWNER", "RUNNER"].map((name) => [name, {}])),
    TAKOSUMI_VERSION_METADATA: { id: "fixture-owner-version" },
    ...Object.fromEntries(["TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_HOSTED_STAGE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET"].map((name) => [name, "fixture-secret"])),
  };
  const directory = await mkdtemp(join(tmpdir(), "takosumi-owner-admission-native-"));
  const fixture = await identityContextFixture();
  try {
    const issuerSource = await build("../../../deploy/accounts-cloudflare/src/entry-worker.ts");
    const ownerSource = await build("fixtures/owner-admission-caller.ts");
    const host = await Bun.build({ entrypoints: [resolve(import.meta.dir, "fixtures/owner-admission-native-host.ts")], target: "node", format: "esm" });
    expect(host.success, host.logs.map(String).join("\n")).toBe(true);
    const operation = await acceptIsolatedIdentityContexts(fixture.store, fixture.operation, fixture.now);
    const subjects = [contextA, contextB];
    const seed = { operation, now: fixture.now, contextPlan: await fixture.store.findIdentityMergeContextPlan!(operation.contextPlan!.planId),
      accounts: await Promise.all(subjects.map((subject) => fixture.store.findAccount(subject))),
      emailProofs: await Promise.all(subjects.map((subject) => fixture.store.findAccountEmailProof!(subject))),
      identities: (await Promise.all(subjects.map((subject) => fixture.store.listCanonicalUpstreamIdentities!(subject)))).flat(),
      operationReceipts: await Promise.all([operation.sourceProof!, operation.targetProof!].map((proof) => fixture.store.findIdentityOperationReceipt!(proof.receiptId))),
      contextReceipts: await Promise.all([operation.sourceContextAcceptance!, operation.targetContextAcceptance!].map((receipt) => fixture.store.findIdentityMergeContextReceipt!(receipt.receiptId))),
    };
    const entry = join(directory, "host.mjs"), input = join(directory, "fixture.json");
    await writeFile(entry, await host.outputs[0]!.text(), { mode: 0o600 });
    // Node resolves from the temporary host's location. Supply the installed
    // module URL explicitly; Bun 1.4.0 keeps bare external import specifiers
    // even when an onResolve plugin returns an absolute external path.
    const miniflareModuleUrl = pathToFileURL(require.resolve("miniflare")).href;
    await writeFile(input, JSON.stringify({ fixture: seed, issuerSource, ownerSource, bindings, salt, serviceId, targetDigest, miniflareModuleUrl }), { mode: 0o600 });
    const child = spawn("node", [entry, input], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data) => { stdout += data; }); child.stderr!.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, "SIGTERM"); }, 45_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      expect(code, stderr + stdout).toBe(0);
      const report = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(report).toEqual({ host: "node", assertions: 46, disposed: true });
      if (child.pid) {
        let remains = true;
        try { process.kill(-child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") remains = false; else throw error; }
        expect(remains, "native Node/workerd process group must be closed").toBe(false);
      }
      console.info(JSON.stringify({ event: "owner_admission_native_host", ...report, processGroupClosed: true }));
    } finally {
      clearTimeout(timer);
      if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    }
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
