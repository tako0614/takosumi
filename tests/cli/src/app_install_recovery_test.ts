import { expect, test } from "bun:test";
import { handleControlRoute } from "../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { runAppInstall } from "../../../cli/src/cli-apps-commands.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { InMemoryGitInstallPlanStore } from "../../../core/domains/install-plans/store.ts";

const ORIGIN = "https://takosumi.example.test";
const TOKEN = "synthetic-install-recovery-pat";
const SUBJECT = "tsub_install_recovery";
const baseArgs = ["--git", "https://git.example.test/team/app.git", "--ref", "main", "--url", ORIGIN, "--token", TOKEN, "--json"];

function retainedKey(lines: string[]): string | undefined {
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value.kind === "install_attempt_key" && typeof value.idempotencyKey === "string") return value.idempotencyKey;
    } catch { /* Ordinary error diagnostics are not receipts. */ }
  }
}

test("lost install ACK retains a pre-dispatch key and manual replay returns the same actual attempt", async () => {
  // Initial identity/PAT and persistence are synthetic. Accounts authentication,
  // the public handler and the Core install coordinator are production code.
  const ledger = new InMemoryOpenTofuControlStore();
  const plans = new InMemoryGitInstallPlanStore(ledger);
  ledger.attachGitInstallPlanStore(plans);
  const { operations } = await createTakosumiService({
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger, gitInstallPlanStore: plans,
  });
  const workspace = await operations.workspaces.createWorkspace({ handle: "cli-install-recovery", displayName: "CLI install recovery", type: "personal", ownerUserId: SUBJECT });
  const accounts = new InMemoryAccountsStore();
  const now = Date.now();
  accounts.saveAccount({ subject: SUBJECT, createdAt: now, updatedAt: now });
  accounts.savePersonalAccessToken(TOKEN, {
    tokenId: "pat_install_recovery", tokenPrefix: "synthetic", subject: SUBJECT,
    name: "Install recovery", scopes: ["read", "write"], createdAt: now, expiresAt: now + 600_000,
  });
  const original = globalThis.fetch;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) };
  const statuses: number[] = [];
  const bodies: string[] = [];
  const keyReadyBeforeSend: boolean[] = [];
  let acceptedId = "";
  let calls = 0;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(`${ORIGIN}/api/v1/install-plans`);
    expect(request.method).toBe("POST");
    keyReadyBeforeSend.push(retainedKey(stderr) === request.headers.get("idempotency-key"));
    bodies.push(await request.clone().text());
    calls++;
    const response = await handleControlRoute({ request, url: new URL(request.url), store: accounts, operations });
    expect(response).toBeDefined();
    statuses.push(response!.status);
    if (calls === 1) {
      acceptedId = (await response!.json()).installPlan.id;
      throw new Error("fixture: response lost after coordinator create");
    }
    return response!;
  }) as typeof fetch;
  try {
    expect(await runAppInstall(baseArgs, io)).toBe(1);
    expect(calls).toBe(1); // The CLI never retries a POST automatically.
    expect(stdout).toEqual([]);
    expect(statuses).toEqual([201]);
    expect(keyReadyBeforeSend).toEqual([true]);
    const key = retainedKey(stderr);
    expect(key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stderr.join("\n")).not.toContain(TOKEN);
    expect(stderr.join("\n")).not.toContain(baseArgs[1]!);
    stderr.length = 0;
    expect(await runAppInstall([...baseArgs, `--idempotency-key=${key}`], io)).toBe(0);
    expect(JSON.parse(stdout.join("\n")).installPlan.id).toBe(acceptedId);
    expect(statuses).toEqual([201, 200]);
    expect(bodies[1]).toBe(bodies[0]);
    expect(await plans.listOpenAttempts({ actorSubject: SUBJECT })).toHaveLength(1);
    stdout.length = 0;
    stderr.length = 0;
    expect(await runAppInstall([...baseArgs, `--idempotency-key=${key}`, "--app-name", "different-intent"], io)).toBe(1);
    expect(statuses.at(-1)).toBe(409);
    expect(await plans.listOpenAttempts({ actorSubject: SUBJECT })).toHaveLength(1);
    expect(stdout).toEqual([]);
    expect(await ledger.listRunsByWorkspace(workspace.id)).toHaveLength(0);
  } finally { globalThis.fetch = original; }
});

for (const key of ["retained=attempt=01", "--flag=value=="]) {
  test(`install preserves an exact inline key: ${key}`, async () => {
    const original = globalThis.fetch;
    const stderr: string[] = [];
    const stdout: string[] = [];
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls++;
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(key);
      expect(retainedKey(stderr)).toBe(key);
      return Response.json({ installPlan: { id: "ip_retained", phase: "syncing_source" } }, { status: 201 });
    }) as typeof fetch;
    try {
      expect(await runAppInstall([...baseArgs, `--idempotency-key=${key}`], { stdout: line => stdout.push(line), stderr: line => stderr.push(line) })).toBe(0);
      expect(calls).toBe(1);
      expect(JSON.parse(stdout.join("\n")).installPlan.id).toBe("ip_retained");
    } finally { globalThis.fetch = original; }
  });
}

for (const invalid of ["", "bad\nkey", " key", "x".repeat(257)]) {
  test("invalid install keys are refused before output or HTTP", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const stderr: string[] = [];
    globalThis.fetch = (async () => { calls++; throw new Error("unexpected HTTP"); }) as typeof fetch;
    try {
      expect(await runAppInstall([...baseArgs, `--idempotency-key=${invalid}`], { stdout: () => {}, stderr: line => stderr.push(line) })).toBe(2);
      expect(calls).toBe(0);
      expect(retainedKey(stderr)).toBeUndefined();
    } finally { globalThis.fetch = original; }
  });
}
