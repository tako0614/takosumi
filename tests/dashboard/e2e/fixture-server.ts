import { join, relative, resolve, sep } from "node:path";
import { resolvePortablePort } from "./portable-origin.ts";
import {
  createInstallAttemptFixture,
  PORTABLE_AUTHORITY_GUARD,
  PORTABLE_APPS,
  PORTABLE_APP_MEMBERS,
  PORTABLE_SHARED_APP_MEMBERS,
  PORTABLE_PERSONAL_CONNECTIONS,
  PORTABLE_CAPSULES,
  PORTABLE_SESSION_COOKIE,
  PORTABLE_SOURCE_COMMIT,
  PORTABLE_UI_SURFACES,
  PORTABLE_WORKSPACES,
  portableUsageResponse,
  portableAppConnectionLabels,
  portableCapsule,
  portableCapsuleApp,
  portableCapsuleRuns,
  workspacesResponse,
} from "./fixture-data.ts";

const port = resolvePortablePort();

const distRoot = resolve(import.meta.dir, "../../../dashboard/dist");
const indexFile = Bun.file(join(distRoot, "index.html"));
if (!(await indexFile.exists())) {
  throw new Error(
    "dashboard/dist/index.html is missing; run `bun run check:dashboard` before the portable browser check",
  );
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

function authenticated(request: Request): boolean {
  return request.headers.get("cookie")?.split(";").some((entry) =>
    entry.trim() === PORTABLE_SESSION_COOKIE,
  ) === true;
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function workspaceFor(id: string | null) {
  return PORTABLE_WORKSPACES.find((workspace) => workspace.id === id);
}

function activityResponse() {
  return { events: [] };
}

function page(value: unknown, field: string): unknown {
  return { [field]: value };
}

// Per-app install attempt routes, including the workspace-less collection and
// the legacy workspace collection alias. Cases that need a particular app
// (connections, settings, failures) stub these with their own fixture instance.
const installAttempts = createInstallAttemptFixture({ workspaceId: "ws_alpha" });

async function installAttemptResponse(request: Request, url: URL): Promise<Response | undefined> {
  const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    return json({ error: { code: "invalid_request", message: "Invalid JSON." } }, 400);
  }
  const reply = installAttempts.handle({
    method: request.method,
    path: url.pathname,
    search: url.search,
    body,
    idempotencyKey: request.headers.get("idempotency-key"),
  });
  return reply ? json(reply.json, reply.status) : undefined;
}

async function apiResponse(request: Request, url: URL): Promise<Response> {
  if (!authenticated(request)) return unauthorized();

  const path = url.pathname;
  if (path === "/api/v1/account/session/me") {
    return json({
      subject: "sub_portable_e2e",
      expiresAt: Date.now() + 60 * 60 * 1000,
      displayName: "Portable E2E",
      email: "portable-e2e@example.test",
    });
  }
  if (path === "/api/v1/dashboard/bootstrap") {
    return json({
      session: {
        subject: "sub_portable_e2e",
        expiresAt: Date.now() + 60 * 60 * 1000,
        displayName: "Portable E2E",
        email: "portable-e2e@example.test",
      },
      workspaces: PORTABLE_WORKSPACES,
      workspaceList: {
        total: PORTABLE_WORKSPACES.length,
        returned: PORTABLE_WORKSPACES.length,
        limit: 50,
        truncated: false,
      },
      notifications: [],
    });
  }
  if (path === "/api/v1/apps" && request.method === "GET") {
    return json({ apps: PORTABLE_APPS });
  }
  if (request.method === "GET" && (path === "/api/v1/ownership-transfers" ||
    /^\/api\/v1\/capsules\/[^/]+\/ownership-transfers$/u.test(path))) {
    return json({ transfers: [] });
  }
  if (path === "/api/v1/connections" && request.method === "GET") {
    if (url.searchParams.get("projection") === "labels") {
      const capsuleId = url.searchParams.get("capsuleId");
      if (!capsuleId) return json({ error: "invalid_request" }, 400);
      return json(portableAppConnectionLabels(capsuleId));
    }
    return json({ connections: PORTABLE_PERSONAL_CONNECTIONS });
  }
  if (path === "/api/v1/usage" && request.method === "GET") {
    return json(portableUsageResponse());
  }
  if (path === "/api/v1/source-ref-resolutions/stable-semver" && request.method === "POST") {
    return json({ tag: "v1.0.0", commit: PORTABLE_SOURCE_COMMIT });
  }
  const memberMatch = path.match(/^\/api\/v1\/capsules\/([^/]+)\/members$/u);
  if (memberMatch && request.method === "GET") {
    if (!portableCapsule(decodeURIComponent(memberMatch[1] ?? ""))) {
      return json({ error: "not_found" }, 404);
    }
    return json(decodeURIComponent(memberMatch[1] ?? "") === "cap_beta_office"
      ? PORTABLE_SHARED_APP_MEMBERS
      : PORTABLE_APP_MEMBERS);
  }
  const configMatch = path.match(/^\/api\/v1\/capsule-configs\/([^/]+)$/u);
  if (configMatch && request.method === "GET") {
    const configId = decodeURIComponent(configMatch[1] ?? "");
    const capsuleId = configId.startsWith("cfg_") ? configId.slice("cfg_".length) : "";
    const capsule = portableCapsule(capsuleId);
    if (!capsule || capsule.installConfigId !== configId) return json({ error: "not_found" }, 404);
    return json({ installConfig: {
      id: configId,
      workspaceId: capsule.workspaceId,
      name: capsule.name,
      sourceSelector: { url: `https://github.com/example/${capsule.slug}.git`, path: "." },
      modulePath: ".",
    } });
  }
  if (path === "/api/v1/__e2e/unexpected-404") {
    return json({ error: "intentional_fixture_failure" }, 404);
  }
  if (path === "/api/v1/workspaces") return json(workspacesResponse());

  const workspaceMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)(?:\/(.*))?$/u);
  if (workspaceMatch) {
    const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
    const suffix = workspaceMatch[2] ?? "";
    if (!workspaceFor(workspaceId)) return json({ error: "not_found" }, 404);
    if (suffix === "installed-apps") return json({ installedApps: [], complete: true });
    if (suffix === "capsules") {
      return json(page(PORTABLE_CAPSULES[workspaceId as keyof typeof PORTABLE_CAPSULES] ?? [], "capsules"));
    }
    if (suffix === "ui-surfaces") {
      return json({
        interfaces:
          PORTABLE_UI_SURFACES[workspaceId as keyof typeof PORTABLE_UI_SURFACES] ?? [],
      });
    }
    if (suffix === "activity") return json(activityResponse());
    if (suffix === "source-ref-resolutions/stable-semver" && request.method === "POST") {
      return json({ tag: "v1.0.0", commit: PORTABLE_SOURCE_COMMIT });
    }
    if (suffix === "current-state-versions") return json({ stateVersions: [] });
    if (suffix === "install-configs") return json({ installConfigs: [] });
    if (suffix === "install-plans") {
      if (workspaceId !== "ws_alpha") return json({ installPlans: [] });
      return (await installAttemptResponse(request, url))!;
    }
  }

  if (path === "/api/v1/install-plans" || path.startsWith("/api/v1/install-plans/")) {
    const reply = await installAttemptResponse(request, url);
    if (reply) return reply;
  }

  // One installed app: its record, the control plane's view of it and its
  // own Runs. Cases that need other states stub these per test.
  const capsuleMatch = path.match(/^\/api\/v1\/capsules\/([^/]+)(?:\/(app|runs))?$/u);
  if (capsuleMatch && request.method === "GET") {
    const capsule = portableCapsule(decodeURIComponent(capsuleMatch[1] ?? ""));
    if (!capsule) return json({ error: "not_found" }, 404);
    if (capsuleMatch[2] === "app") return json({ app: portableCapsuleApp(capsule) });
    if (capsuleMatch[2] === "runs") return json({ runs: portableCapsuleRuns(capsule) });
    return json({
      capsule,
      installConfigReAdoption: { authorityGuard: PORTABLE_AUTHORITY_GUARD },
    });
  }

  if (path === "/.well-known/takosumi") {
    return json({
      apiVersion: "takosumi.dev/v1alpha1",
      apiBaseUrl: `${url.origin}/api/v1`,
      endpoints: {
        api: `${url.origin}/api/v1`,
        capabilities: `${url.origin}/api/v1/capabilities`,
        openapi: `${url.origin}/openapi.json`,
        oidc_issuer: url.origin,
      },
    });
  }
  if (path === "/api/v1/capabilities") {
    return json({
      apiVersion: "takosumi.dev/v1alpha1",
      resources: {},
      adapters: {},
      identity: {},
      operator: {},
      extensions: [],
    });
  }

  // Unknown API routes are explicit failures. A permissive `{}` response would
  // make a broken dashboard request look like a green browser check.
  return json({ error: "fixture_route_not_found", path }, 404);
}

async function staticResponse(url: URL): Promise<Response> {
  if (url.pathname === "/__e2e/ready") {
    return new Response("ready\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("invalid path\n", { status: 400 });
  }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(distRoot, requested);
  const rel = relative(distRoot, candidate);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(`${sep}..${sep}`)) {
    return new Response("not found\n", { status: 404 });
  }
  const file = Bun.file(candidate);
  if (await file.exists()) return new Response(file);
  // Solid Router owns client-side routes. Only a browser document gets the
  // SPA fallback; missing asset requests remain real 404s.
  if (url.pathname.startsWith("/assets/") || url.pathname.includes(".")) {
    return new Response("not found\n", { status: 404 });
  }
  return new Response(indexFile, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/auth/oidc/session" &&
      url.search === ""
    ) {
      return Response.json({ error: "not_found" }, {
        status: 404,
        headers: {
          "cache-control": "no-store",
          "x-takosumi-shared-auth-absent": "1",
        },
      });
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/apis/") || url.pathname === "/.well-known/takosumi") {
      return apiResponse(request, url);
    }
    return staticResponse(url);
  },
});

console.log(`dashboard-e2e fixture listening on ${server.url}`);
