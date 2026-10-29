import { expect, test } from "bun:test";
import { main } from "../../../cli/src/main.ts";
import { requestDeployControlApi } from "../../../cli/src/cli-deploy-control-api.ts";

const quietIo = {
  stdout: (_line: string) => {},
  stderr: (_line: string) => {},
};

test("apps install creates a workspace-less attempt through the new route", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ installPlan: { id: "ip_new", phase: "syncing_source" } }, { status: 201 });
  }) as typeof fetch;
  const stdout: string[] = [];
  try {
    expect(await main([
      "apps", "install", "--git", "https://git.example.test/team/app.git",
      "--ref", "main", "--path", "deploy", "--app-name", "Weather",
      "--environment", "staging", "--url", "https://takosumi.example.test", "--json",
      "--token", "account-pat",
    ], { stdout: (line) => stdout.push(line), stderr: quietIo.stderr })).toBe(0);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/install-plans");
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer account-pat");
    expect(await requests[0]!.json()).toEqual({
      mode: "attempt",
      source: { url: "https://git.example.test/team/app.git", ref: "main", path: "deploy" },
      capsule: { name: "Weather", environment: "staging" },
    });
    expect(JSON.parse(stdout.join("\n")).installPlan.id).toBe("ip_new");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps install preserves a user idempotency key on the legacy 404 fallback", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    paths.push(url.pathname);
    if (paths.length === 1) return new Response("route missing", { status: 404 });
    return Response.json({ installPlan: { id: "ip_legacy", phase: "syncing_source" } }, { status: 201 });
  }) as typeof fetch;
  try {
    expect(await main([
      "apps", "install", "--git", "https://git.example.test/team/app.git",
      "--workspace", "ws_legacy", "--url", "https://takosumi.example.test",
      "--token", "account-pat", "--idempotency-key", "retry-key-7",
    ], quietIo)).toBe(0);
    expect(paths).toEqual([
      "/api/v1/install-plans",
      "/api/v1/workspaces/ws_legacy/install-plans",
    ]);
    expect(requests.map((request) => request.headers.get("idempotency-key"))).toEqual([
      "retry-key-7",
      "retry-key-7",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps install without a workspace reports 404 without retrying a legacy route", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response("route missing", { status: 404 });
  }) as typeof fetch;
  const stderr: string[] = [];
  try {
    expect(await main([
      "apps", "install", "--git", "https://git.example.test/team/app.git",
      "--url", "https://takosumi.example.test", "--token", "account-pat",
    ], { stdout: quietIo.stdout, stderr: (line) => stderr.push(line) })).toBe(1);
    expect(requests).toBe(1);
    expect(stderr.join("\n")).toContain("Workspace-less app install is not available");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps install never falls back on non-404 errors", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({ error: { message: "denied" } }, { status: 403 });
  }) as typeof fetch;
  const stderr: string[] = [];
  try {
    expect(await main([
      "apps", "install", "--git", "https://git.example.test/team/app.git",
      "--workspace", "ws_legacy", "--url", "https://takosumi.example.test", "--token", "account-pat",
    ], { stdout: quietIo.stdout, stderr: (line) => stderr.push(line) })).toBe(1);
    expect(requests).toBe(1);
    expect(stderr).toEqual(["denied"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps list without a workspace does not retry a legacy route on 404", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({ error: { message: "missing" } }, { status: 404 });
  }) as typeof fetch;
  try {
    expect(await main(["apps", "list", "--url", "https://takosumi.example.test", "--token", "account-pat"], quietIo)).toBe(1);
    expect(requests).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps list uses the legacy route only after a 404 and explicit workspace", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const pathname = new URL(String(input)).pathname;
    paths.push(pathname);
    if (paths.length === 1) return Response.json({ error: { message: "missing" } }, { status: 404 });
    return Response.json({ installedApps: [{ capsuleId: "cap_1", name: "Weather", state: "installed" }], complete: true });
  }) as typeof fetch;
  try {
    expect(await main(["apps", "list", "--workspace", "ws_legacy", "--url", "https://takosumi.example.test", "--token", "account-pat"], quietIo)).toBe(0);
    expect(paths).toEqual([
      "/api/v1/apps",
      "/api/v1/workspaces/ws_legacy/installed-apps",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps list follows nextCursor on the apps route and combines both pages", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return requests.length === 1
      ? Response.json({ apps: [{ capsuleId: "cap_1" }], nextCursor: "cursor 2" })
      : Response.json({ apps: [{ capsuleId: "cap_2" }] });
  }) as typeof fetch;
  const stdout: string[] = [];
  try {
    expect(await main([
      "apps", "list", "--url", "https://takosumi.example.test", "--token", "account-pat", "--json",
    ], { stdout: (line) => stdout.push(line), stderr: quietIo.stderr })).toBe(0);
    expect(requests.map((request) => new URL(request.url).pathname + new URL(request.url).search)).toEqual([
      "/api/v1/apps",
      "/api/v1/apps?cursor=cursor%202",
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer account-pat",
      "Bearer account-pat",
    ]);
    const result = JSON.parse(stdout.join("\n"));
    expect(result.apps.map((app: { capsuleId: string }) => app.capsuleId)).toEqual(["cap_1", "cap_2"]);
    expect(result.nextCursor).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps list paginates the legacy installed-apps route after a 404", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (requests.length === 1) return Response.json({ error: { message: "missing" } }, { status: 404 });
    return requests.length === 2
      ? Response.json({ installedApps: [{ id: "cap_1" }], nextCursor: "legacy-page-2" })
      : Response.json({ installedApps: [{ id: "cap_2" }] });
  }) as typeof fetch;
  const stdout: string[] = [];
  try {
    expect(await main([
      "apps", "list", "--workspace", "ws_legacy", "--url", "https://takosumi.example.test", "--token", "account-pat", "--json",
    ], { stdout: (line) => stdout.push(line), stderr: quietIo.stderr })).toBe(0);
    expect(requests.map((request) => new URL(request.url).pathname + new URL(request.url).search)).toEqual([
      "/api/v1/apps",
      "/api/v1/workspaces/ws_legacy/installed-apps",
      "/api/v1/workspaces/ws_legacy/installed-apps?cursor=legacy-page-2",
    ]);
    expect(JSON.parse(stdout.join("\n")).installedApps.map((app: { id: string }) => app.id)).toEqual(["cap_1", "cap_2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps list rejects repeated cursors instead of looping", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({ apps: [], nextCursor: "repeat" });
  }) as typeof fetch;
  const stderr: string[] = [];
  try {
    expect(await main([
      "apps", "list", "--url", "https://takosumi.example.test", "--token", "account-pat",
    ], { stdout: quietIo.stdout, stderr: (line) => stderr.push(line) })).toBe(1);
    expect(requests).toBe(2);
    expect(stderr.join("\n")).toContain("repeated pagination cursor");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps list never falls back on a non-404 response", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return Response.json({ error: { message: "denied" } }, { status: 403 });
  }) as typeof fetch;
  try {
    expect(await main([
      "apps", "list", "--workspace", "ws_legacy", "--url", "https://takosumi.example.test", "--token", "account-pat",
    ], quietIo)).toBe(1);
    expect(requests).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps routes use an Accounts PAT and never fall back to the operator token", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountsToken = process.env.TAKOSUMI_ACCOUNT_TOKEN;
  const originalOperatorToken = process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
  const authHeaders: Array<string | null> = [];
  globalThis.fetch = (async (_input, init) => {
    authHeaders.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ apps: [] });
  }) as typeof fetch;
  try {
    process.env.TAKOSUMI_ACCOUNT_TOKEN = "account-pat";
    process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN = "operator-bearer";
    expect(await main(["apps", "list", "--url", "https://takosumi.example.test"], quietIo)).toBe(0);
    expect(authHeaders).toEqual(["Bearer account-pat"]);

    delete process.env.TAKOSUMI_ACCOUNT_TOKEN;
    const stderr: string[] = [];
    expect(await main(["apps", "list", "--url", "https://takosumi.example.test"], {
      stdout: quietIo.stdout,
      stderr: (line) => stderr.push(line),
    })).toBe(1);
    expect(authHeaders).toHaveLength(1);
    expect(stderr.join("\n")).toContain("Accounts PAT required");
  } finally {
    if (originalAccountsToken === undefined) delete process.env.TAKOSUMI_ACCOUNT_TOKEN;
    else process.env.TAKOSUMI_ACCOUNT_TOKEN = originalAccountsToken;
    if (originalOperatorToken === undefined) delete process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
    else process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN = originalOperatorToken;
    globalThis.fetch = originalFetch;
  }
});

test("default deploy-control API auth continues to use the operator token", async () => {
  const originalFetch = globalThis.fetch;
  const originalAccountsToken = process.env.TAKOSUMI_ACCOUNT_TOKEN;
  const originalOperatorToken = process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
  let authorization: string | null = null;
  globalThis.fetch = (async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    process.env.TAKOSUMI_ACCOUNT_TOKEN = "account-pat";
    process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN = "operator-bearer";
    await requestDeployControlApi({
      path: "/api/v1/operator/fixtures",
      options: { url: "https://takosumi.example.test" },
    });
    expect(authorization).toBe("Bearer operator-bearer");
  } finally {
    if (originalAccountsToken === undefined) delete process.env.TAKOSUMI_ACCOUNT_TOKEN;
    else process.env.TAKOSUMI_ACCOUNT_TOKEN = originalAccountsToken;
    if (originalOperatorToken === undefined) delete process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
    else process.env.TAKOSUMI_DEPLOY_CONTROL_TOKEN = originalOperatorToken;
    globalThis.fetch = originalFetch;
  }
});

test("apps uninstall calls the app-scoped uninstall route", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = (async (input, init) => {
    request = new Request(input, init);
    return Response.json({ capsule: { id: "cap_owned", status: "uninstalled" } }, { status: 202 });
  }) as typeof fetch;
  try {
    expect(await main(["apps", "uninstall", "cap_owned", "--yes", "--url", "https://takosumi.example.test", "--token", "account-pat"], quietIo)).toBe(0);
    expect(new URL(request!.url).pathname).toBe("/api/v1/capsules/cap_owned/uninstall");
    expect(request!.method).toBe("POST");
    expect(await request!.json()).toEqual({});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apps help names Accounts PAT auth and uses Japanese app terminology", async () => {
  const originalLanguage = process.env.TAKOSUMI_LANG;
  const stdout: string[] = [];
  try {
    process.env.TAKOSUMI_LANG = "ja";
    expect(await main(["apps"], { stdout: (line) => stdout.push(line), stderr: quietIo.stderr })).toBe(0);
    const help = stdout.join("\n");
    expect(help).toContain("アプリを表示");
    expect(help).toContain("アプリをインストール");
    expect(help).toContain("アプリをアンインストール");
    expect(help).toContain("Accounts PAT");
    expect(help).toContain("TAKOSUMI_ACCOUNT_TOKEN");
    expect(help).not.toContain("app を");
    expect(help).not.toContain("install を");
    expect(help).not.toContain("uninstall を");
  } finally {
    if (originalLanguage === undefined) delete process.env.TAKOSUMI_LANG;
    else process.env.TAKOSUMI_LANG = originalLanguage;
  }
});


test("apps uninstall requires explicit confirmation before any API call", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const stderr: string[] = [];
  globalThis.fetch = (async () => { calls += 1; return Response.json({}); }) as typeof fetch;
  try {
    for (const flags of [[], ["--yes=false"], ["--yes=true"]]) {
      expect(await main(["apps", "uninstall", "cap_owned", ...flags, "--url", "https://takosumi.example.test", "--token", "account-pat"],
        { stdout: quietIo.stdout, stderr: (line) => stderr.push(line) })).toBe(2);
    }
    expect(calls).toBe(0);
    expect(stderr.every((line) => line.includes("--yes"))).toBe(true);
  } finally { globalThis.fetch = originalFetch; }
});


test("a business not_found response never retries install under another scope", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ error: { code: "not_found", message: "Selected source was not found." } }, { status: 404 });
  }) as typeof fetch;
  try {
    expect(await main(["apps", "install", "--git", "https://git.example.test/private.git", "--workspace", "ws_legacy",
      "--url", "https://takosumi.example.test", "--token", "account-pat"], quietIo)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/install-plans");
  } finally { globalThis.fetch = originalFetch; }
});
