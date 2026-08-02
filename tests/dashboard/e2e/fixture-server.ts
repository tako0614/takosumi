import { join, relative, resolve, sep } from "node:path";
import {
  PORTABLE_CAPSULES,
  PORTABLE_OBJECT_BUCKET,
  PORTABLE_RESOURCE_INTERFACE,
  PORTABLE_SESSION_COOKIE,
  PORTABLE_UI_SURFACES,
  PORTABLE_WORKSPACES,
  workspacesResponse,
} from "./fixture-data.ts";

const port = Number(process.env.TAKOSUMI_E2E_PORT ?? "4179");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("TAKOSUMI_E2E_PORT must be a valid TCP port");
}

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

function resourcePage() {
  return { resources: [PORTABLE_OBJECT_BUCKET] };
}

function page(value: unknown, field: string): unknown {
  return { [field]: value };
}

async function apiResponse(request: Request, url: URL): Promise<Response> {
  if (!authenticated(request)) return unauthorized();

  const path = url.pathname;
  if (path === "/v1/account/session/me") {
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
  if (path === "/api/v1/__e2e/unexpected-404") {
    return json({ error: "intentional_fixture_failure" }, 404);
  }
  if (path === "/api/v1/workspaces") return json(workspacesResponse());

  const workspaceMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)(?:\/(.*))?$/u);
  if (workspaceMatch) {
    const workspaceId = decodeURIComponent(workspaceMatch[1] ?? "");
    const suffix = workspaceMatch[2] ?? "";
    if (!workspaceFor(workspaceId)) return json({ error: "not_found" }, 404);
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
    if (suffix === "current-state-versions") return json({ stateVersions: [] });
    if (suffix === "install-configs") return json({ installConfigs: [] });
    if (suffix === "target-pools") return json({ targetPools: [] });
    if (suffix === "space-policies") return json({ spacePolicies: [] });
  }

  if (path === "/v1/resources") return json(resourcePage());
  if (path === "/v1/form-availability") return json({ forms: [] });
  if (path === "/v1/target-pools") return json({ targetPools: [] });
  if (path === "/v1/space-policies") return json({ spacePolicies: [] });
  if (path === "/v1/cloud/s3-access-keys") return json({ accessKeys: [] });
  if (path === "/apis/forms.takoform.com/v1alpha1/interfaces") {
    return json({ interfaces: [PORTABLE_RESOURCE_INTERFACE] });
  }
  if (path === "/v1/resources/ObjectBucket/assets") {
    return json(PORTABLE_OBJECT_BUCKET);
  }
  if (path === "/v1/resources/ObjectBucket/assets/events") {
    return json({ events: [] });
  }
  if (path === "/.well-known/takosumi") {
    return json({
      apiVersion: "takosumi.dev/v1alpha1",
      endpoints: { capabilities: "/v1/capabilities" },
    });
  }
  if (path === "/v1/capabilities") {
    return json({
      apiVersion: "takosumi.dev/v1alpha1",
      resources: {},
      adapters: {},
      compat: {},
      compatibilityProfiles: { "compat.e2e.v1": { planes: ["control"] } },
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
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/apis/") || url.pathname === "/.well-known/takosumi") {
      return apiResponse(request, url);
    }
    return staticResponse(url);
  },
});

console.log(`dashboard-e2e fixture listening on ${server.url}`);
