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

test.each(["lost", "incomplete", "legacy-after-upgrade"])("install acknowledgement %s: retain the key for the saved attempt", async (mode) => {
  // Initial identity/PAT and persistence are synthetic. Accounts authentication,
  // the public handler and the Core install coordinator are production code.
  const ledger = new InMemoryOpenTofuControlStore();
  const plans = new InMemoryGitInstallPlanStore(ledger);
  ledger.attachGitInstallPlanStore(plans);
  const { operations } = await createTakosumiService({
    authorizeInterfaceBearer: () => undefined,
    role: "takosumi-api", runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: ledger, gitInstallPlanStore: plans,
  });
  const legacy = mode === "legacy-after-upgrade";
  const workspace = await operations.workspaces.createWorkspace({ handle: "cli-install-recovery", displayName: "CLI install recovery", type: legacy ? "organization" : "personal", ownerUserId: SUBJECT });
  const directPath = "/api/v1/install-plans";
  const path = legacy ? `/api/v1/workspaces/${workspace.id}/install-plans` : directPath;
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
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    paths.push(url.pathname);
    expect(url.origin).toBe(ORIGIN);
    expect(request.method).toBe("POST");
    keyReadyBeforeSend.push(retainedKey(stderr) === request.headers.get("idempotency-key"));
    bodies.push(await request.clone().text());
    // The original server lacks the new route. By the next invocation it
    // is present, which would select an unrelated personal Workspace.
    if (legacy && paths.length === 1 && url.pathname === directPath) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const response = await handleControlRoute({ request, url, store: accounts, operations });
    expect(response).toBeDefined();
    statuses.push(response!.status);
    if (statuses.length === 1) {
      acceptedId = (await response!.json()).installPlan.id;
      if (mode === "incomplete") return Response.json({ installPlan: { phase: "syncing_source" } }, { status: 201 });
      throw new Error("fixture: response lost after coordinator create");
    }
    return response!;
  }) as typeof fetch;
  try {
    const initialArgs = legacy ? [...baseArgs, "--workspace", workspace.id] : baseArgs;
    expect(await runAppInstall(initialArgs, io)).toBe(1);
    expect(paths).toEqual(legacy ? [directPath, path] : [path]);
    expect(stdout).toEqual([]);
    expect(statuses).toEqual([201]);
    expect(keyReadyBeforeSend).toEqual(legacy ? [true, true] : [true]);
    const key = retainedKey(stderr);
    expect(key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(stderr.join("\n")).toContain("--idempotency-key");
    expect(stderr.join("\n")).not.toContain(TOKEN);
    expect(stderr.join("\n")).not.toContain(baseArgs[1]!);
    if (legacy) {
      expect(JSON.parse(stderr[1]!)).toEqual({ kind: "install_attempt_legacy_workspace", workspaceId: workspace.id });
      expect(stderr.join("\n")).toContain("--resume-legacy-workspace");
    }
    stderr.length = 0;
    const replay = [...baseArgs, `--idempotency-key=${key}`, ...(legacy ? ["--resume-legacy-workspace", workspace.id] : [])];
    expect(await runAppInstall(replay, io)).toBe(0);
    expect(paths).toEqual(legacy ? [directPath, path, path] : [path, path]);
    expect(JSON.parse(stdout.join("\n")).installPlan.id).toBe(acceptedId);
    expect(statuses).toEqual([201, 200]);
    expect(bodies.every((body) => body === bodies[0])).toBe(true);
    expect(await plans.listOpenAttempts({ actorSubject: SUBJECT })).toHaveLength(1);
    stdout.length = 0;
    stderr.length = 0;
    expect(await runAppInstall([...replay, "--app-name", "different-intent"], io)).toBe(1);
    expect(statuses.at(-1)).toBe(409);
    expect(await plans.listOpenAttempts({ actorSubject: SUBJECT })).toHaveLength(1);
    expect(stdout).toEqual([]);
    expect(await ledger.listRunsByWorkspace(workspace.id)).toHaveLength(0);
  } finally { globalThis.fetch = original; }
});

test("legacy resume requires a saved key and a single explicit Workspace", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected HTTP"); }) as typeof fetch;
  try {
    const io = { stdout: () => {}, stderr: () => {} };
    for (const flags of [["--resume-legacy-workspace", "ws_old"],
      ["--resume-legacy-workspace", "ws_old", "--workspace", "ws_other", "--idempotency-key", "saved"],
      ["--resume-legacy-workspace", "--idempotency-key", "saved"]]) {
      expect(await runAppInstall([...baseArgs, ...flags], io)).toBe(2);
    }
    expect(calls).toBe(0);
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
