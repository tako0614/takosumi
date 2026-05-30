import assert from "node:assert/strict";
import { compileManifestToAppSpec } from "./compiler.ts";
import type { PublicDeployManifest } from "./types.ts";

const IMAGE_A =
  "registry.example.test/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE_B =
  "registry.example.test/app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const WORKER_IMAGE = IMAGE_A;

// Wave J removed kernel-side route compilation; the
// "accepts default-app style routes and outputs" test that asserted on
// `appSpec.routes[].to/path` projections was deleted because the kernel no
// longer projects routes.

Deno.test("public manifest compiler infers image-backed compute as container runtime", () => {
  const appSpec = compileManifestToAppSpec({
    name: "image-app",
    compute: {
      api: {
        image: IMAGE_A,
        port: 8080,
      },
    },
  });

  assert.equal(appSpec.components[0].type, "runtime.oci-container@v1");
});

// Phase 10 Wave 4: enabled — this test only exercises the compiler-level
// validation (the Plan-projection part is now covered by the
// Deployment.resolution surface in deployment_service tests).
Deno.test(
  "public manifest compiler validates and projects worker attached containers",
  () => {
    assert.throws(
      () =>
        compileManifestToAppSpec({
          name: "bad-attached",
          compute: {
            web: {
              type: "js-worker",
              image: WORKER_IMAGE,
              port: 8080,
              containers: {
                host: {
                  image: "registry.example.test/host:latest",
                  port: 9090,
                },
              },
            },
          },
        }),
      /containers\.host\.image must be digest-pinned/,
    );
    assert.throws(
      () =>
        compileManifestToAppSpec({
          name: "bad-attached-port",
          compute: {
            web: {
              type: "js-worker",
              image: WORKER_IMAGE,
              port: 8080,
              containers: { host: { image: IMAGE_A } },
            },
          },
        }),
      /containers\.host\.port must be integer/,
    );
    assert.throws(
      () =>
        compileManifestToAppSpec({
          name: "bad-attached-parent",
          compute: {
            web: {
              image: IMAGE_A,
              port: 8080,
              containers: { host: { image: IMAGE_B, port: 9090 } },
            },
          },
        }),
      /compute\.web\.containers is worker-only/,
    );
  },
);

// Workflow/trigger authoring is owned above the kernel by installer clients.
Deno.test("public manifest compiler rejects compute triggers", () => {
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-trigger",
        compute: {
          jobs: {
            type: "js-worker",
            image: WORKER_IMAGE,
            port: 8080,
            triggers: { queues: [{ binding: "JOBS", queue: "jobs" }] },
          },
        },
      }),
    /compute\.jobs must not include 'triggers'/,
  );
});

// Wave J removed the kernel-side `routes`/`outputs` map projection that the
// "keeps route and outputs map" test exercised; deleted because the kernel no
// longer carries routes through `compileManifestToAppSpec`.

Deno.test("public manifest compiler expands documented resource bindings", () => {
  const appSpec = compileManifestToAppSpec({
    name: "resource-app",
    compute: {
      web: {
        image: WORKER_IMAGE,
        port: 8080,
      },
      worker: {
        image: IMAGE_B,
        port: 8080,
      },
    },
    resources: {
      db: {
        type: "sql",
        bindings: {
          web: "DB",
        },
      },
      media: {
        type: "object-store",
        bindings: [{
          target: "web",
          binding: "MEDIA",
        }],
      },
      cache: {
        type: "key-value",
        bindings: {
          web: "KV",
        },
      },
      jobs: {
        type: "queue",
        bindings: {
          worker: "JOBS",
        },
      },
      session: {
        type: "secret",
        generate: true,
        bind: "APP_SESSION_SECRET",
        to: "web",
      },
    },
  });

  assert.deepEqual(
    appSpec.resources.map((resource) => [resource.name, resource.type]),
    [
      ["db", "resource.sql.sqlite-serverless@v1"],
      ["media", "resource.object-store.s3@v1"],
      ["cache", "resource.key-value@v1"],
      ["jobs", "resource.queue.at-least-once@v1"],
      ["session", "resource.secret@v1"],
    ],
  );
  const webBindings =
    appSpec.components.find((component) => component.name === "web")
      ?.bindings ?? {};
  assert.deepEqual(
    Object.entries(webBindings).map(([name, spec]) => [
      name,
      (spec.from as { resource: string }).resource,
      (spec.from as { access: { contract: string; mode: string } }).access,
    ]),
    [
      [
        "DB",
        "resource.db",
        {
          contract: "resource.sql.sqlite-serverless@v1",
          mode: "sql-runtime-binding",
        },
      ],
      [
        "MEDIA",
        "resource.media",
        {
          contract: "resource.object-store.s3@v1",
          mode: "object-runtime-binding",
        },
      ],
      [
        "KV",
        "resource.cache",
        {
          contract: "resource.key-value@v1",
          mode: "kv-runtime-binding",
        },
      ],
      [
        "APP_SESSION_SECRET",
        "resource.session",
        {
          contract: "resource.secret@v1",
          mode: "secret-env-binding",
        },
      ],
    ],
  );
  const workerBindings =
    appSpec.components.find((component) => component.name === "worker")
      ?.bindings ?? {};
  assert.deepEqual(
    Object.entries(workerBindings).map(([name, spec]) => [
      name,
      (spec.from as { resource: string }).resource,
      (spec.from as { access: { contract: string; mode: string } }).access,
    ]),
    [[
      "JOBS",
      "resource.jobs",
      {
        contract: "resource.queue.at-least-once@v1",
        mode: "queue-runtime-binding",
      },
    ]],
  );
});

Deno.test("public manifest compiler accepts every documented resource type", () => {
  const appSpec = compileManifestToAppSpec({
    name: "resource-types",
    resources: {
      sql: { type: "sql" },
      objectStore: { type: "object-store" },
      keyValue: { type: "key-value" },
      queue: { type: "queue" },
      vectorIndex: { type: "vector-index" },
      secret: { type: "secret" },
      analyticsEngine: { type: "analytics-engine" },
      durableObject: { type: "durable-object" },
    },
  });

  assert.deepEqual(
    appSpec.resources.map((resource) => resource.type),
    [
      "resource.sql.sqlite-serverless@v1",
      "resource.object-store.s3@v1",
      "resource.key-value@v1",
      "resource.queue.at-least-once@v1",
      "resource.vector-index@v1",
      "resource.secret@v1",
      "resource.analytics-engine@v1",
      "resource.durable-object@v1",
    ],
  );
});

Deno.test("public manifest compiler rejects removed publish field", () => {
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "invalid-app",
        publish: [],
      }),
    /must not include 'publish'/,
  );
});

// Wave J removed kernel-side route override projection; the "applies selected
// environment overrides" test asserted on `appSpec.routes` produced by the
// `overrides.production.routes[]` chain. Deleted because the kernel no longer
// reads or projects `routes` in overrides.

Deno.test("public manifest compiler rejects invalid documented manifest fields", () => {
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad",
        extra: true,
      } as never),
    /internal deployment manifest must not include 'extra'/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-image",
        compute: {
          web: { image: "registry.example.test/web:latest", port: 8080 },
        },
      }),
    /compute\.web\.image must be digest-pinned/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-port",
        compute: {
          web: { image: IMAGE_A },
        },
      }),
    /compute\.web\.port must be integer/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "rejects-build-field",
        compute: {
          web: {
            // deno-lint-ignore no-explicit-any
            build: { foo: "bar" } as any,
          },
        },
      }),
    /compute\.web must not include 'build'/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-binding",
        compute: {
          web: {
            image: WORKER_IMAGE,
            port: 8080,
          },
        },
        resources: {
          db: {
            type: "sql",
            bindings: { web: "bad-name" },
          },
        },
      }),
    /resource\.db\.bindings\.web must match/,
  );
});

Deno.test("public manifest compiler validates route and output references", () => {
  const base: PublicDeployManifest = {
    name: "route-app",
    compute: {
      web: {
        image: WORKER_IMAGE,
        port: 8080,
      },
    },
  };

  assert.throws(
    () =>
      compileManifestToAppSpec({
        ...base,
        routes: [{
          id: "web",
          target: "web",
          path: "/",
        }, {
          id: "web",
          target: "web",
          path: "/alt",
        }],
      }),
    /route\.web duplicates route id/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        ...base,
        routes: [{
          id: "a",
          target: "web",
          path: "/",
          methods: ["GET"],
        }, {
          id: "b",
          target: "web",
          path: "/",
          methods: ["get"],
        }],
      }),
    /route\.b duplicates target\/path/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        ...base,
        routes: [{ id: "web", target: "web", path: "/" }],
        outputs: [{
          name: "ui",
          type: "output.http-endpoint@v1",
          outputs: { url: { routeRef: "missing" } },
        }],
      }),
    /output\.ui references unknown route 'missing'/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        ...base,
        routes: [{ id: "web", target: "web", path: "/" }],
        outputs: [{
          name: "ui",
          type: "output.http-endpoint@v1",
        } as never],
      }),
    /output\.ui requires outputs/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        ...base,
        overrides: {
          production: {
            providerTarget: "provider.cloudflare.workers@v1",
          },
        },
      }),
    /overrides\.production must not include 'providerTarget'/,
  );
});

// Wave J removed kernel-side route protocol normalization (HTTP/HTTPS/TCP/UDP/
// queue interface contract resolution); the "normalizes non-HTTP route
// protocols" test asserted on the removed `route.protocol` /
// `interfaceContractRef` projections. Deleted because the kernel no longer
// validates or normalizes route protocols.

Deno.test(
  "public manifest compiler validates bindings request/inject shape",
  () => {
    assert.throws(
      () =>
        compileManifestToAppSpec({
          name: "bad-binding-request",
          compute: {
            web: {
              image: WORKER_IMAGE,
              port: 8080,
              bindings: {
                TAKOSUMI_API_KEY: {
                  from: {
                    output: "takosumi.api-key",
                    request: { scopes: ["files:read"], unexpected: true },
                  },
                  inject: { mode: "env", target: "TAKOSUMI_API_KEY" },
                },
              },
            },
          },
        }),
      /request must not include 'unexpected'/,
    );
  },
);

Deno.test("public manifest compiler rejects env collisions after uppercase normalization", () => {
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-env",
        env: { log_level: "info" },
        compute: {
          web: {
            image: WORKER_IMAGE,
            port: 8080,
            env: { LOG_LEVEL: "debug" },
          },
        },
      }),
    /compute\.web\.env collides with env 'LOG_LEVEL'/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-binding-env",
        compute: {
          web: {
            image: WORKER_IMAGE,
            port: 8080,
            env: { OAUTH_CLIENT_ID: "existing" },
            bindings: {
              OAUTH_CLIENT_ID: {
                from: {
                  output: "takosumi.oauth-client",
                  request: {
                    redirectUris: ["https://example.test/api/auth/callback"],
                    scopes: ["openid"],
                  },
                },
                inject: { mode: "env", target: "OAUTH_CLIENT_ID" },
              },
            },
          },
        },
      }),
    /bindings\.OAUTH_CLIENT_ID\.inject collides with env 'OAUTH_CLIENT_ID'/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-resource-binding-env",
        compute: {
          web: {
            image: WORKER_IMAGE,
            port: 8080,
            env: { DATABASE_URL: "existing" },
          },
        },
        resources: {
          db: { type: "postgres", bindings: { web: "database_url" } },
        },
      }),
    /bindings\.DATABASE_URL\.inject collides with env 'DATABASE_URL'/,
  );
});

Deno.test("public manifest compiler validates OAuth redirect URI schemes", () => {
  compileManifestToAppSpec({
    name: "oauth-relative",
    compute: {
      web: {
        image: WORKER_IMAGE,
        port: 8080,
        bindings: {
          OAUTH_CLIENT_ID: {
            from: {
              output: "takosumi.oauth-client",
              request: {
                redirectUris: ["/api/auth/callback"],
                scopes: ["openid"],
              },
            },
            inject: { mode: "env", target: "OAUTH_CLIENT_ID" },
          },
        },
      },
    },
  }, { autoHostnameAvailable: true });

  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "oauth-relative-no-context",
        compute: {
          web: {
            image: WORKER_IMAGE,
            port: 8080,
            bindings: {
              OAUTH_CLIENT_ID: {
                from: {
                  output: "takosumi.oauth-client",
                  request: {
                    redirectUris: ["/api/auth/callback"],
                    scopes: ["openid"],
                  },
                },
                inject: { mode: "env", target: "OAUTH_CLIENT_ID" },
              },
            },
          },
        },
      }),
    /relative path requires auto hostname context/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "oauth-http",
        compute: {
          web: {
            image: WORKER_IMAGE,
            port: 8080,
            bindings: {
              OAUTH_CLIENT_ID: {
                from: {
                  output: "takosumi.oauth-client",
                  request: {
                    redirectUris: ["http://example.test/callback"],
                    scopes: ["openid"],
                  },
                },
                inject: { mode: "env", target: "OAUTH_CLIENT_ID" },
              },
            },
          },
        },
      }),
    /redirectUris\[0\] must be HTTPS absolute URL/,
  );

  const appSpec = compileManifestToAppSpec({
    name: "oauth-localhost",
    compute: {
      web: {
        image: WORKER_IMAGE,
        port: 8080,
        bindings: {
          OAUTH_CLIENT_ID: {
            from: {
              output: "takosumi.oauth-client",
              request: {
                redirectUris: ["http://localhost:8787/api/auth/callback"],
                scopes: ["openid"],
              },
            },
            inject: { mode: "env", target: "OAUTH_CLIENT_ID" },
          },
        },
      },
    },
  }, { localDevelopment: true });

  assert.equal(appSpec.name, "oauth-localhost");
});

Deno.test("public manifest compiler accepts the canonical 'outputs' authoring key", () => {
  const manifest: PublicDeployManifest = {
    name: "outputs-canonical",
    version: "1.0.0",
    compute: {
      api: { image: WORKER_IMAGE, port: 8080 },
    },
    routes: [{ id: "web", target: "api", path: "/", methods: ["GET"] }],
    outputs: [{
      name: "search",
      type: "output.http-endpoint@v1",
      outputs: { url: { kind: "url", routeRef: "web" } },
    }],
  };
  const appSpec = compileManifestToAppSpec(manifest);
  const searchOutput = appSpec.outputs?.find((spec) => spec.name === "search");
  assert.ok(
    searchOutput,
    "outputs[].search should resolve into appSpec.outputs",
  );
  assert.equal(searchOutput?.type, "output.http-endpoint@v1");
});

Deno.test("public manifest compiler accepts component bindings authoring", () => {
  const manifest: PublicDeployManifest = {
    name: "binding-canonical",
    version: "1.0.0",
    compute: {
      web: {
        image: WORKER_IMAGE,
        port: 8080,
        bindings: {
          TAKOSUMI_API_KEY: {
            from: {
              output: "takosumi.api-key",
              request: { scopes: ["read"] },
            },
            inject: { mode: "env", target: "TAKOSUMI_API_KEY" },
          },
        },
      },
    },
  };
  const appSpec = compileManifestToAppSpec(manifest);
  const web = appSpec.components.find((component) => component.name === "web");
  assert.ok(web, "web component must exist after expansion");
  const binding = web?.bindings.TAKOSUMI_API_KEY;
  assert.ok(binding);
  assert.equal(
    (binding!.from as { output: string }).output,
    "takosumi.api-key",
  );
  assert.equal(binding!.inject.target, "TAKOSUMI_API_KEY");
});

Deno.test("public manifest compiler rejects removed service import bindings", () => {
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "removed-service-import-binding",
        compute: {
          web: {
            image: WORKER_IMAGE,
            port: 8080,
            bindings: {
              OIDC_ISSUER_URL: {
                from: {
                  import: "account-auth",
                  field: "url",
                },
                inject: { mode: "env", target: "OIDC_ISSUER_URL" },
              },
            },
          },
        },
      } as unknown as PublicDeployManifest),
    /compute\.web\.bindings\.OIDC_ISSUER_URL\.from must not include 'import'/,
  );
});
