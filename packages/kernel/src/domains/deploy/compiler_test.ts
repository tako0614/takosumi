import assert from "node:assert/strict";
import { compileManifestToAppSpec } from "./compiler.ts";
import type { PublicDeployManifest } from "./types.ts";

const IMAGE_A =
  "registry.example.test/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE_B =
  "registry.example.test/app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function workerBuild() {
  return {
    fromWorkflow: {
      path: ".takos/workflows/build.yml",
      job: "build",
      artifact: "bundle",
    },
  };
}

Deno.test("public manifest compiler accepts default-app style routes and outputs", () => {
  const manifest: PublicDeployManifest = {
    name: "takos-docs",
    version: "1.0.0",
    compute: {
      web: {
        build: {
          fromWorkflow: {
            path: ".takos/workflows/build.yml",
            job: "build",
            artifact: "bundle",
          },
        },
        icon: "/icons/docs.png",
      },
    },
    routes: [{
      id: "web",
      target: "web",
      path: "/",
      methods: ["GET"],
    }, {
      id: "mcp",
      target: "web",
      path: "/mcp",
      methods: ["GET", "POST"],
    }, {
      id: "file",
      target: "web",
      path: "/files/:id",
      methods: ["GET"],
    }],
    outputs: [{
      name: "docs-ui",
      type: "output.http-endpoint@v1",
      outputs: {
        url: {
          kind: "url",
          routeRef: "web",
        },
      },
      display: {
        title: "Takos Docs",
        icon: "/icons/docs.png",
      },
      auth: {
        required: false,
      },
      spec: {
        launcher: true,
      },
    }, {
      name: "docs-mcp",
      type: "output.mcp-server@v1",
      outputs: {
        url: {
          kind: "url",
          routeRef: "mcp",
        },
      },
      spec: {
        transport: "streamable-http",
      },
    }, {
      name: "docs-file",
      type: "output.http-endpoint@v1",
      outputs: {
        url: {
          kind: "url",
          routeRef: "file",
        },
      },
      spec: {
        mimeTypes: ["text/markdown"],
      },
    }],
  };

  const appSpec = compileManifestToAppSpec(manifest);

  assert.equal(appSpec.components[0].name, "web");
  assert.equal(appSpec.components[0].type, "runtime.js-worker@v1");
  assert.deepEqual(
    appSpec.routes.map((route) => [route.name, route.to, route.path]),
    [
      ["web", "web", "/"],
      ["mcp", "web", "/mcp"],
      ["file", "web", "/files/:id"],
    ],
  );
  assert.deepEqual(
    appSpec.outputs.map((output) => [
      output.name,
      output.type,
    ]),
    [
      ["docs-ui", "output.http-endpoint@v1"],
      ["docs-mcp", "output.mcp-server@v1"],
      ["docs-file", "output.http-endpoint@v1"],
    ],
  );
  assert.deepEqual(appSpec.outputs[0].outputs, {
    url: {
      kind: "url",
      routeRef: "web",
    },
  });
  assert.deepEqual(appSpec.outputs[0].raw.display, {
    title: "Takos Docs",
    icon: "/icons/docs.png",
  });
  assert.deepEqual(appSpec.outputs[0].raw.auth, {
    required: false,
  });
  assert.deepEqual(appSpec.outputs[0].spec, {
    launcher: true,
  });
  assert.deepEqual(appSpec.outputs[0].raw.spec, {
    launcher: true,
  });
  assert.equal(appSpec.outputs[1].raw.type, "output.mcp-server@v1");
  assert.equal(
    appSpec.outputs[2].raw.type,
    "output.http-endpoint@v1",
  );
});

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
              build: workerBuild(),
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
              build: workerBuild(),
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

// Phase 10 Wave 4: enabled — exercises compiler-level worker trigger
// validation; Deployment.resolution surface coverage lives in
// deployment_service tests.
Deno.test("public manifest compiler validates worker triggers", () => {
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-trigger-selector",
        compute: {
          jobs: {
            build: workerBuild(),
            triggers: { queues: [{ binding: "JOBS", queue: "jobs" }] },
          },
        },
      }),
    /requires exactly one of binding or queue/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-trigger-parent",
        compute: {
          api: {
            image: IMAGE_A,
            port: 8080,
            triggers: { queues: [{ queue: "jobs" }] },
          },
        },
      }),
    /compute\.api\.triggers is worker-only/,
  );
});

Deno.test("public manifest compiler keeps route and outputs map", () => {
  const appSpec = compileManifestToAppSpec({
    name: "outputs-app",
    compute: {
      web: {
        type: "container",
        image: IMAGE_A,
        port: 8080,
      },
    },
    routes: {
      web: {
        target: "web",
        path: "/",
      },
    },
    outputs: {
      web: {
        type: "output.http-endpoint@v1",
        outputs: { url: { routeRef: "web" } },
      },
    },
  });

  assert.deepEqual(appSpec.routes.map((route) => [route.name, route.to]), [
    ["web", "web"],
  ]);
  assert.deepEqual(
    appSpec.outputs.map((output) => [
      output.name,
      output.type,
    ]),
    [["web", "output.http-endpoint@v1"]],
  );
});

Deno.test("public manifest compiler expands documented resource bindings", () => {
  const appSpec = compileManifestToAppSpec({
    name: "resource-app",
    compute: {
      web: {
        build: {
          fromWorkflow: {
            path: ".takos/workflows/build.yml",
            job: "build",
            artifact: "bundle",
          },
        },
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
      workflow: { type: "workflow" },
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
      "resource.workflow@v1",
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

Deno.test("public manifest compiler applies selected environment overrides", () => {
  const appSpec = compileManifestToAppSpec({
    name: "env-app",
    env: { LOG_LEVEL: "info" },
    compute: {
      web: {
        image: IMAGE_A,
        port: 8080,
        env: { FEATURE: "off" },
      },
    },
    routes: [{
      id: "web",
      target: "web",
      path: "/",
      methods: ["GET"],
    }],
    outputs: [{
      name: "web-ui",
      type: "output.http-endpoint@v1",
      outputs: { url: { routeRef: "web" } },
      spec: { launcher: false },
    }],
    overrides: {
      providerTarget: "provider.cloudflare.containers@v1",
      production: {
        env: { LOG_LEVEL: "warn" },
        compute: {
          web: { env: { FEATURE: "on" } },
        },
        routes: [{
          id: "web",
          target: "web",
          path: "/app",
          methods: ["GET", "POST"],
        }],
        outputs: [{
          name: "web-ui",
          spec: { launcher: true },
        }],
      },
    },
  }, { envName: "production" });

  assert.equal(appSpec.env.LOG_LEVEL, "warn");
  assert.equal(appSpec.components[0].env.FEATURE, "on");
  assert.deepEqual(
    appSpec.routes.map((route) => [
      route.name,
      route.path,
      route.methods,
    ]),
    [["web", "/app", ["GET", "POST"]]],
  );
  assert.deepEqual(appSpec.outputs[0].spec, { launcher: true });
  assert.deepEqual(appSpec.overrides, {
    providerTarget: "provider.cloudflare.containers@v1",
  });
});

Deno.test("public manifest compiler rejects invalid documented manifest fields", () => {
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad",
        extra: true,
      } as never),
    /public deploy manifest must not include 'extra'/,
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
        name: "bad-workflow",
        compute: {
          web: {
            build: {
              fromWorkflow: {
                path: ".github/workflows/build.yml",
                job: "build",
                artifact: "bundle",
              },
            },
          },
        },
      }),
    /build\.fromWorkflow\.path must be under \.takos\/workflows\//,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-artifact-path",
        compute: {
          web: {
            build: {
              fromWorkflow: {
                path: ".takos/workflows/build.yml",
                job: "build",
                artifact: "bundle",
                artifactPath: "../dist/worker.js",
              },
            },
          },
        },
      }),
    /artifactPath must be a repository relative path/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-binding",
        compute: {
          web: {
            build: {
              fromWorkflow: {
                path: ".takos/workflows/build.yml",
                job: "build",
                artifact: "bundle",
              },
            },
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
        build: {
          fromWorkflow: {
            path: ".takos/workflows/build.yml",
            job: "build",
            artifact: "bundle",
          },
        },
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

Deno.test("public manifest compiler normalizes non-HTTP route protocols", () => {
  const appSpec = compileManifestToAppSpec({
    name: "multi-protocol-app",
    compute: {
      worker: {
        build: workerBuild(),
      },
    },
    routes: [{
      id: "web",
      target: "worker",
      path: "/",
      protocol: "https",
    }, {
      id: "socket",
      target: "worker",
      protocol: "tcp",
      port: 4433,
    }, {
      id: "dns",
      target: "worker",
      protocol: "udp",
      port: 5353,
    }, {
      id: "jobs",
      target: "worker",
      protocol: "queue",
      source: "jobs.incoming",
    }, {
      id: "daily",
      target: "worker",
      protocol: "schedule",
    }, {
      id: "push",
      target: "worker",
      protocol: "event",
      source: "repo.push",
    }],
  });

  assert.deepEqual(
    appSpec.routes.map((route) => [
      route.name,
      route.protocol,
      route.interfaceContractRef,
      route.path,
      route.port,
      route.targetPort,
      route.source,
    ]),
    [
      [
        "web",
        "https",
        "interface.http@v1",
        "/",
        undefined,
        undefined,
        undefined,
      ],
      ["socket", "tcp", "interface.tcp@v1", undefined, 4433, 4433, undefined],
      ["dns", "udp", "interface.udp@v1", undefined, 5353, 5353, undefined],
      [
        "jobs",
        "queue",
        "interface.queue@v1",
        undefined,
        undefined,
        undefined,
        "jobs.incoming",
      ],
      [
        "daily",
        "schedule",
        "interface.schedule@v1",
        undefined,
        undefined,
        undefined,
        "daily",
      ],
      [
        "push",
        "event",
        "interface.event@v1",
        undefined,
        undefined,
        undefined,
        "repo.push",
      ],
    ],
  );

  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-tcp",
        compute: { worker: { build: workerBuild() } },
        routes: [{ id: "socket", target: "worker", protocol: "tcp" }],
      }),
    /route\.socket\.port or compute\.worker\.port is required/,
  );
  assert.throws(
    () =>
      compileManifestToAppSpec({
        name: "bad-queue",
        compute: { worker: { build: workerBuild() } },
        routes: [{
          id: "jobs",
          target: "worker",
          protocol: "queue",
          path: "/jobs",
        }],
      }),
    /route\.jobs\.path is only valid for http\/https routes/,
  );
});

Deno.test(
  "public manifest compiler validates bindings request/inject shape",
  () => {
    assert.throws(
      () =>
        compileManifestToAppSpec({
          name: "bad-binding-request",
          compute: {
            web: {
              build: workerBuild(),
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
            build: workerBuild(),
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
            build: workerBuild(),
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
            build: workerBuild(),
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
        build: workerBuild(),
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
            build: workerBuild(),
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
            build: workerBuild(),
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
        build: workerBuild(),
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
      api: { build: workerBuild() },
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
        build: workerBuild(),
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
