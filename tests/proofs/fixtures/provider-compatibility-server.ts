#!/usr/bin/env bun

const resources = new Map<string, Record<string, unknown>>();
const targetPools = new Map<string, Record<string, unknown>>();
const counts: Record<string, number> = {};

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (url.pathname === "/.well-known/takosumi") {
      return json({
        api_versions: ["takosumi.dev/v1alpha1"],
        features: { resource_shapes: true },
        endpoints: {},
      });
    }
    if (url.pathname === "/v1/capabilities") {
      return json({
        apiVersion: "takosumi.dev/v1alpha1",
        resources: {
          EdgeWorker: true,
          ObjectBucket: true,
          KVStore: true,
          Queue: true,
          SQLDatabase: true,
          ContainerService: true,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/resources/preview") {
      const desired = (await request.json()) as Record<string, unknown>;
      return json({
        resource: desired,
        planDigest: "sha256:compatibility-plan",
        specDigest: "sha256:compatibility-spec",
        resolutionFingerprint: "sha256:compatibility-resolution",
      });
    }
    const resourceMatch = /^\/v1\/resources\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (resourceMatch && request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>;
      const desired = (body.resource ?? body) as Record<string, unknown>;
      const resource = readyResource(desired, resourceMatch[1], resourceMatch[2]);
      resources.set(`${resourceMatch[1]}/${resourceMatch[2]}`, resource);
      return json(resource);
    }
    if (resourceMatch && request.method === "GET") {
      const resource = resources.get(`${resourceMatch[1]}/${resourceMatch[2]}`);
      return resource ? json(resource) : json({ error: "not found" }, 404);
    }
    const observeMatch = /^\/v1\/resources\/([^/]+)\/([^/]+)\/observe$/.exec(
      url.pathname,
    );
    if (observeMatch && request.method === "POST") {
      const resource = resources.get(`${observeMatch[1]}/${observeMatch[2]}`);
      return resource ? json(resource) : json({ error: "not found" }, 404);
    }
    if (resourceMatch && request.method === "DELETE") {
      resources.delete(`${resourceMatch[1]}/${resourceMatch[2]}`);
      return new Response(null, { status: 204 });
    }
    const targetPoolMatch = /^\/v1\/target-pools\/([^/]+)$/.exec(url.pathname);
    if (targetPoolMatch && request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>;
      const record = {
        id: `tkrn:compat:TargetPool:${targetPoolMatch[1]}`,
        spaceId: body.space ?? "compat",
        name: targetPoolMatch[1],
        spec: body.spec,
      };
      targetPools.set(targetPoolMatch[1], record);
      return json(record);
    }
    if (targetPoolMatch && request.method === "GET") {
      const record = targetPools.get(targetPoolMatch[1]);
      return record ? json(record) : json({ error: "not found" }, 404);
    }
    if (targetPoolMatch && request.method === "DELETE") {
      targetPools.delete(targetPoolMatch[1]);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__proof/counts") return json(counts);
    return json({ error: `unsupported ${key}` }, 404);
  },
});

function readyResource(
  desired: Record<string, unknown>,
  kind: string,
  name: string,
) {
  const metadata = (desired.metadata ?? {}) as Record<string, unknown>;
  const spec = (desired.spec ?? {}) as Record<string, unknown>;
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind,
    metadata: {
      name,
      space: "compat",
      managedBy: metadata.managedBy ?? "opentofu",
    },
    spec: { ...spec, name },
    status: {
      phase: "Ready",
      resolution: {
        selectedImplementation: "compatibility_fixture",
        target: "fixture-target",
        locked: true,
        portability: "portable",
      },
      outputs: { fixture: "non-secret" },
    },
  };
}

process.stdout.write(`READY ${server.url.origin}\n`);
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
