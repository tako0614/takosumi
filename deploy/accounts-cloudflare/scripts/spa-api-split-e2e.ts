/**
 * SPA-vs-API split regression gate for the single accounts Worker.
 *
 * The Worker serves the dashboard SPA from Static Assets AND routes the
 * account/service API to the accounts handler from one origin (see
 * `src/handler.ts` + `src/routes.ts`, `run_worker_first = true`). This e2e
 * boots `wrangler dev` (local) against the template `wrangler.toml --env local`
 * and proves, on one origin, that:
 *   - API namespaces (/v1, /oauth, /.well-known, /start, /internal) reach the
 *     accounts handler — the response is NOT the SPA HTML shell (it is JSON,
 *     even when it errors because no local D1 is provisioned), and
 *   - everything else (/, deep links, SPA-owned launch pages) is served the SPA shell
 *     (text/html, 200), proving `not_found_handling = single-page-application`
 *     owns navigations and the legacy server-HTML dashboard is gone.
 *
 * The discriminator is the content-type: API => not text/html; SPA => text/html.
 * It does not require a provisioned D1, so it runs offline as a pure routing gate.
 *
 * Usage (build the SPA first):
 *   bun run deploy:accounts-cloudflare:build-assets
 *   bun deploy/accounts-cloudflare/scripts/spa-api-split-e2e.ts
 */

const cloudflareRoot = new URL("../", import.meta.url);
const assetsIndex = new URL(
  "../../packages/dashboard-ui/.output/public/index.html",
  cloudflareRoot,
);

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env ?? {};
const port = Number(env.TAKOSUMI_ACCOUNTS_E2E_PORT ?? "8788");
const host = `http://127.0.0.1:${port}`;

interface ApiCheck {
  readonly method: string;
  readonly path: string;
}

// Every non-/dashboard path the accounts handler owns. Must NOT be shadowed by
// the SPA fallback — i.e. must return JSON (any status), never the HTML shell.
const API_CHECKS: readonly ApiCheck[] = [
  { method: "GET", path: "/.well-known/openid-configuration" },
  { method: "GET", path: "/oauth/jwks" },
  { method: "GET", path: "/v1/account/session/me" },
  { method: "GET", path: "/start" },
  { method: "POST", path: "/internal/workload-platform-services/resolve" },
  { method: "POST", path: "/v1/installations" },
];

// Navigations the SPA must own (root, deep links, and SPA-owned launch pages).
const SPA_PATHS: readonly string[] = [
  "/",
  "/apps",
  "/apps/inst_e2e_probe",
  "/install",
  "/takos/start",
  "/account/tokens",
];

function log(message: string): void {
  console.log(message);
}

async function ensureBuilt(): Promise<void> {
  if (!(await Bun.file(assetsIndex.pathname).exists())) {
    throw new Error(
      `dashboard SPA build missing at ${assetsIndex.pathname}. Run: bun run deploy:accounts-cloudflare:build-assets`,
    );
  }
}

async function waitForReady(
  proc: { stdout: ReadableStream<Uint8Array> },
  timeoutMs: number,
): Promise<void> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  const reader = proc.stdout.getReader();
  let buffered = "";
  let exited = false;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) {
      exited = true;
      break;
    }
    buffered += decoder.decode(value, { stream: true });
    if (/Ready on http:\/\//.test(buffered)) {
      reader.releaseLock();
      return;
    }
  }
  reader.releaseLock();
  throw new Error(
    exited
      ? "wrangler dev exited / closed stdout before becoming ready"
      : "wrangler dev did not become ready in time",
  );
}

async function run(): Promise<void> {
  await ensureBuilt();
  log(`▶ starting wrangler dev on ${host} ...`);
  const proc = Bun.spawn({
    cmd: [
      "bunx",
      "wrangler",
      "dev",
      "--config",
      "wrangler.toml",
      "--env",
      "local",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
    ],
    cwd: cloudflareRoot.pathname,
    env: {
      ...env,
      TAKOSUMI_ACCOUNTS_ISSUER: env.TAKOSUMI_ACCOUNTS_ISSUER ??
        "https://accounts.takosumi.test",
    },
    stdout: "pipe",
    // Inherit stderr so wrangler's (potentially large) diagnostic output never
    // fills an undrained OS pipe buffer and deadlocks the child.
    stderr: "inherit",
  });

  const failures: string[] = [];
  try {
    await waitForReady(proc, 90_000);
    log("✓ wrangler dev ready\n");

    for (const check of API_CHECKS) {
      const res = await fetch(`${host}${check.path}`, { method: check.method });
      const ct = res.headers.get("content-type") ?? "";
      const ok = !ct.includes("text/html");
      log(
        `${ok ? "✓" : "✗"} API  ${check.method} ${check.path} -> ${ct || "(none)"} ${res.status}`,
      );
      if (!ok) {
        failures.push(
          `API ${check.method} ${check.path} was shadowed by the SPA (content-type ${ct})`,
        );
      }
    }

    for (const path of SPA_PATHS) {
      const res = await fetch(`${host}${path}`);
      const ct = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const ok = res.status === 200 && ct.includes("text/html") &&
        body.includes('<div id="app"');
      log(`${ok ? "✓" : "✗"} SPA  GET ${path} -> ${ct || "(none)"} ${res.status}`);
      if (!ok) {
        failures.push(
          `SPA ${path} did not return the HTML shell (status ${res.status}, content-type ${ct})`,
        );
      }
    }
  } finally {
    proc.kill("SIGINT");
    await proc.exited;
  }

  if (failures.length > 0) {
    console.error(`\n✘ SPA/API split FAILED:\n  - ${failures.join("\n  - ")}`);
    throw new Error("spa-api-split-e2e failed");
  }
  log("\n✔ SPA/API split verified: API namespaces reach the handler, navigations serve the SPA.");
}

await run();
