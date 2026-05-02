import assert from "node:assert/strict";
import { Hono, type Hono as HonoApp } from "hono";
import type {
  ManifestResource,
  ResourceHandle,
  Template,
} from "takosumi-contract";
import { registerTemplate, unregisterTemplate } from "takosumi-contract";
import {
  registerDeployPublicRoutes,
  TAKOSUMI_DEPLOY_PUBLIC_PATH,
} from "./deploy_public_routes.ts";
import type {
  ApplyV2Outcome,
  DestroyV2Outcome,
} from "../domains/deploy/apply_v2.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  type TakosumiDeploymentRecordStore,
} from "../domains/deploy/takosumi_deployment_record_store.ts";

const VALID_TOKEN = "test-token-abc";

const SAMPLE_RESOURCE: ManifestResource = {
  shape: "object-store@v1",
  name: "logs",
  provider: "filesystem",
  spec: { name: "logs", region: "local" },
};

function createApp(opts: {
  token?: string | undefined;
  applyResources?: (
    resources: readonly ManifestResource[],
  ) => Promise<ApplyV2Outcome>;
  destroyResources?: (
    resources: readonly ManifestResource[],
    handleFor?: (resource: ManifestResource) => ResourceHandle,
  ) => Promise<DestroyV2Outcome>;
  recordStore?: TakosumiDeploymentRecordStore;
  now?: () => string;
} = {}): HonoApp {
  const app: HonoApp = new Hono();
  registerDeployPublicRoutes(app, {
    getDeployToken: () => opts.token,
    applyResources: opts.applyResources ?? (() =>
      Promise.resolve({
        applied: [
          {
            name: SAMPLE_RESOURCE.name,
            providerId: SAMPLE_RESOURCE.provider,
            handle: { kind: "test", id: "h_1" } as unknown as ApplyV2Outcome[
              "applied"
            ][number]["handle"],
            outputs: { ok: true },
          },
        ],
        issues: [],
        status: "succeeded",
      })),
    ...(opts.destroyResources
      ? { destroyResources: opts.destroyResources }
      : {}),
    ...(opts.recordStore ? { recordStore: opts.recordStore } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return app;
}

Deno.test("deploy public route returns 404 when token env unset", async () => {
  const app = createApp({ token: undefined });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "apply",
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

Deno.test("deploy public route rejects request without authorization header", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "apply",
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.match(body.error.message, /missing bearer token/);
});

Deno.test("deploy public route rejects wrong bearer token", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer not-the-right-token",
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthenticated");
  assert.match(body.error.message, /invalid token/);
});

Deno.test("deploy public route applies manifest with valid token", async () => {
  let captured: readonly ManifestResource[] | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: (resources) => {
      captured = resources;
      return Promise.resolve({
        applied: [
          {
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: {
              kind: "test",
              id: "applied",
            } as unknown as ApplyV2Outcome[
              "applied"
            ][number]["handle"],
            outputs: { ok: true },
          },
        ],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "succeeded");
  assert.equal(body.outcome.applied.length, 1);
  assert.equal(body.outcome.applied[0].name, SAMPLE_RESOURCE.name);
  assert.deepEqual(captured, [SAMPLE_RESOURCE]);
});

Deno.test("deploy public route surfaces apply validation failures as 400", async () => {
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: () =>
      Promise.resolve({
        applied: [],
        issues: [{ path: "$.resources[0]", message: "shape unknown" }],
        status: "failed-validation",
      }),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.status, "error");
  assert.equal(body.outcome.status, "failed-validation");
});

Deno.test("deploy public route rejects manifest without resources[]", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: { name: "no-resources" },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
  assert.match(body.error.message, /resources\[\]/);
});

Deno.test("deploy public route rejects unknown mode value", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "rollout",
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
  assert.match(body.error.message, /apply\|plan\|destroy/);
});

Deno.test("deploy public route plan mode short-circuits without invoking apply", async () => {
  let invoked = false;
  const app = createApp({
    token: VALID_TOKEN,
    applyResources: () => {
      invoked = true;
      return Promise.resolve({
        applied: [],
        issues: [],
        status: "succeeded",
      });
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "plan",
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(
    invoked,
    false,
    "applyResources must not be called for plan mode",
  );
});

const TEST_TEMPLATE_ID = "deploy-public-test-template";
const TEST_TEMPLATE_VERSION = "v1";
const TEST_TEMPLATE_REF = `${TEST_TEMPLATE_ID}@${TEST_TEMPLATE_VERSION}`;

const testTemplate: Template = {
  id: TEST_TEMPLATE_ID,
  version: TEST_TEMPLATE_VERSION,
  description: "fixture for deploy_public_routes template-expansion tests",
  validateInputs(value, issues) {
    if (
      typeof value !== "object" || value === null || Array.isArray(value)
    ) {
      issues.push({ path: "$", message: "must be an object" });
      return;
    }
    const inputs = value as Record<string, unknown>;
    if (typeof inputs.serviceName !== "string" || inputs.serviceName === "") {
      issues.push({
        path: "$.serviceName",
        message: "must be a non-empty string",
      });
    }
  },
  expand(inputs) {
    const serviceName = (inputs as { serviceName: string }).serviceName;
    return [
      {
        shape: "object-store@v1",
        name: serviceName,
        provider: "filesystem",
        spec: { name: serviceName, region: "local" },
      },
    ];
  },
};

Deno.test("deploy public route expands template with valid inputs", async () => {
  registerTemplate(testTemplate);
  try {
    let captured: readonly ManifestResource[] | undefined;
    const app = createApp({
      token: VALID_TOKEN,
      applyResources: (resources) => {
        captured = resources;
        return Promise.resolve({
          applied: [
            {
              name: resources[0].name,
              providerId: resources[0].provider,
              handle: {
                kind: "test",
                id: "applied",
              } as unknown as ApplyV2Outcome["applied"][number]["handle"],
              outputs: { ok: true },
            },
          ],
          issues: [],
          status: "succeeded",
        });
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          template: {
            ref: TEST_TEMPLATE_REF,
            inputs: { serviceName: "logs" },
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(body.outcome.status, "succeeded");
    assert.ok(captured, "applyResources must receive expanded resources");
    assert.equal(captured!.length, 1);
    assert.equal(captured![0].name, "logs");
    assert.equal(captured![0].shape, "object-store@v1");
  } finally {
    unregisterTemplate(TEST_TEMPLATE_ID, TEST_TEMPLATE_VERSION);
  }
});

Deno.test("deploy public route surfaces template input validation as 400", async () => {
  registerTemplate(testTemplate);
  try {
    const app = createApp({ token: VALID_TOKEN });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          template: { ref: TEST_TEMPLATE_REF, inputs: {} },
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, "invalid_argument");
    assert.match(body.error.message, /serviceName/);
    assert.match(body.error.message, /must be a non-empty string/);
  } finally {
    unregisterTemplate(TEST_TEMPLATE_ID, TEST_TEMPLATE_VERSION);
  }
});

Deno.test("deploy public route rejects manifest carrying both template and resources", async () => {
  registerTemplate(testTemplate);
  try {
    const app = createApp({ token: VALID_TOKEN });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "apply",
        manifest: {
          template: {
            ref: TEST_TEMPLATE_REF,
            inputs: { serviceName: "logs" },
          },
          resources: [SAMPLE_RESOURCE],
        },
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, "invalid_argument");
    assert.match(body.error.message, /both/);
  } finally {
    unregisterTemplate(TEST_TEMPLATE_ID, TEST_TEMPLATE_VERSION);
  }
});

Deno.test("deploy public route rejects unknown template ref", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        template: { ref: "nonexistent-template@v999", inputs: {} },
      },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "invalid_argument");
  assert.match(body.error.message, /not registered/);
});

Deno.test("deploy public route runs destroy mode against destroyV2", async () => {
  let captured: readonly ManifestResource[] | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    destroyResources: (resources) => {
      captured = resources;
      return Promise.resolve(
        {
          destroyed: [
            {
              name: resources[0].name,
              providerId: resources[0].provider,
              handle: resources[0].name,
            },
          ],
          errors: [],
          issues: [],
          status: "succeeded",
        } satisfies DestroyV2Outcome,
      );
    },
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      force: true,
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "succeeded");
  assert.equal(body.outcome.destroyed.length, 1);
  assert.equal(body.outcome.destroyed[0].name, SAMPLE_RESOURCE.name);
  assert.deepEqual(captured, [SAMPLE_RESOURCE]);
});

Deno.test("deploy public route surfaces destroy partial outcome with 200 + errors", async () => {
  const app = createApp({
    token: VALID_TOKEN,
    destroyResources: () =>
      Promise.resolve(
        {
          destroyed: [],
          errors: [
            {
              name: "logs",
              providerId: "filesystem",
              handle: "logs",
              message: "boom",
            },
          ],
          issues: [],
          status: "partial",
        } satisfies DestroyV2Outcome,
      ),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      force: true,
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.outcome.status, "partial");
  assert.equal(body.outcome.errors.length, 1);
  assert.equal(body.outcome.errors[0].message, "boom");
});

Deno.test("deploy public route surfaces destroy validation failures as 400", async () => {
  const app = createApp({
    token: VALID_TOKEN,
    destroyResources: () =>
      Promise.resolve(
        {
          destroyed: [],
          errors: [],
          issues: [{ path: "$.resources[0]", message: "shape unknown" }],
          status: "failed-validation",
        } satisfies DestroyV2Outcome,
      ),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      force: true,
      manifest: { resources: [SAMPLE_RESOURCE] },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.status, "error");
  assert.equal(body.outcome.status, "failed-validation");
});

// --- Task 2: apply persists to recordStore -----------------------------------

Deno.test("apply persists handles + manifest to recordStore", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    applyResources: () =>
      Promise.resolve({
        applied: [
          {
            name: SAMPLE_RESOURCE.name,
            providerId: SAMPLE_RESOURCE.provider,
            handle: "arn:aws:s3:::real-bucket",
            outputs: { url: "https://logs.example" },
          },
        ],
        issues: [],
        status: "succeeded",
      }),
    now: () => "2026-05-02T00:00:00.000Z",
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        metadata: { name: "my-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);

  const persisted = await recordStore.get("takosumi-deploy", "my-app");
  assert.ok(persisted, "apply must upsert a record keyed by metadata.name");
  assert.equal(persisted!.status, "applied");
  assert.equal(persisted!.appliedResources.length, 1);
  assert.equal(persisted!.appliedResources[0].resourceName, "logs");
  assert.equal(
    persisted!.appliedResources[0].handle,
    "arn:aws:s3:::real-bucket",
    "persisted handle must be the apply-time ARN, not the resource name",
  );
  assert.equal(persisted!.appliedResources[0].shape, "object-store@v1");
  assert.equal(persisted!.appliedResources[0].providerId, "filesystem");
});

Deno.test("apply persists `failed` status when applyV2 returns failed-apply", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    applyResources: () =>
      Promise.resolve({
        applied: [],
        issues: [{ path: "$", message: "boom" }],
        status: "failed-apply",
      }),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        metadata: { name: "broken-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 500);
  const persisted = await recordStore.get("takosumi-deploy", "broken-app");
  assert.ok(persisted);
  assert.equal(persisted!.status, "failed");
});

Deno.test("apply does not persist on validation failure", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    applyResources: () =>
      Promise.resolve({
        applied: [],
        issues: [{ path: "$.resources[0]", message: "shape unknown" }],
        status: "failed-validation",
      }),
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "apply",
      manifest: {
        metadata: { name: "invalid-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 400);
  // failed-validation is a manifest-level fault, not a deploy attempt.
  const persisted = await recordStore.get("takosumi-deploy", "invalid-app");
  assert.equal(persisted, undefined);
});

// --- Task 3: destroy uses persisted handles ----------------------------------

Deno.test("destroy feeds persisted handles into destroyV2 via handleFor", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  // Seed the store with a prior apply.
  await recordStore.upsert({
    tenantId: "takosumi-deploy",
    name: "my-app",
    manifest: {},
    appliedResources: [{
      resourceName: "logs",
      shape: "object-store@v1",
      providerId: "filesystem",
      handle: "arn:aws:s3:::real-bucket",
      outputs: {},
      appliedAt: "2026-05-01T00:00:00.000Z",
    }],
    status: "applied",
    now: "2026-05-01T00:00:00.000Z",
  });

  let observedHandle: ResourceHandle | undefined;
  const app = createApp({
    token: VALID_TOKEN,
    recordStore,
    destroyResources: (resources, handleFor) => {
      observedHandle = handleFor ? handleFor(resources[0]) : undefined;
      return Promise.resolve(
        {
          destroyed: [{
            name: resources[0].name,
            providerId: resources[0].provider,
            handle: handleFor?.(resources[0]) ?? resources[0].name,
          }],
          errors: [],
          issues: [],
          status: "succeeded",
        } satisfies DestroyV2Outcome,
      );
    },
    now: () => "2026-05-02T00:00:00.000Z",
  });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
    body: JSON.stringify({
      mode: "destroy",
      manifest: {
        metadata: { name: "my-app" },
        resources: [SAMPLE_RESOURCE],
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    observedHandle,
    "arn:aws:s3:::real-bucket",
    "destroy must receive the persisted handle, not resource.name",
  );
  const persisted = await recordStore.get("takosumi-deploy", "my-app");
  assert.equal(persisted!.status, "destroyed");
  assert.equal(persisted!.appliedResources.length, 0);
});

Deno.test(
  "destroy without prior record refuses with 409 by default",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let destroyCalled = false;
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      destroyResources: () => {
        destroyCalled = true;
        return Promise.resolve(
          {
            destroyed: [],
            errors: [],
            issues: [],
            status: "succeeded",
          } satisfies DestroyV2Outcome,
        );
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "destroy",
        manifest: {
          metadata: { name: "ghost" },
          resources: [SAMPLE_RESOURCE],
        },
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, "failed_precondition");
    assert.match(body.error.message, /no prior deploy record/);
    assert.equal(
      destroyCalled,
      false,
      "destroyV2 must not be invoked without state",
    );
  },
);

Deno.test(
  "destroy without prior record falls back to resource.name when force=true",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    let observedHandleFor: unknown = "untouched";
    const app = createApp({
      token: VALID_TOKEN,
      recordStore,
      destroyResources: (_resources, handleFor) => {
        observedHandleFor = handleFor;
        return Promise.resolve(
          {
            destroyed: [{
              name: SAMPLE_RESOURCE.name,
              providerId: SAMPLE_RESOURCE.provider,
              handle: SAMPLE_RESOURCE.name,
            }],
            errors: [],
            issues: [],
            status: "succeeded",
          } satisfies DestroyV2Outcome,
        );
      },
    });
    const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        mode: "destroy",
        force: true,
        manifest: {
          metadata: { name: "ghost" },
          resources: [SAMPLE_RESOURCE],
        },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(
      observedHandleFor,
      undefined,
      "force: no record means no handleFor (destroyV2 falls back to resource.name)",
    );
  },
);

// --- Task 4: GET /v1/deployments + GET /v1/deployments/:name -----------------

Deno.test("GET /v1/deployments returns the deployment list", async () => {
  const recordStore = new InMemoryTakosumiDeploymentRecordStore();
  await recordStore.upsert({
    tenantId: "takosumi-deploy",
    name: "app-1",
    manifest: {},
    appliedResources: [{
      resourceName: "bucket",
      shape: "object-store@v1",
      providerId: "aws-s3",
      handle: "arn:1",
      outputs: {},
      appliedAt: "2026-05-01T00:00:00.000Z",
    }],
    status: "applied",
    now: "2026-05-01T00:00:00.000Z",
  });
  await recordStore.upsert({
    tenantId: "takosumi-deploy",
    name: "app-2",
    manifest: {},
    appliedResources: [],
    status: "destroyed",
    now: "2026-05-01T00:00:00.000Z",
  });
  const app = createApp({ token: VALID_TOKEN, recordStore });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    deployments: ReadonlyArray<{
      name: string;
      status: string;
      resources: ReadonlyArray<
        { name: string; shape: string; provider: string; status: string }
      >;
    }>;
  };
  assert.equal(body.deployments.length, 2);
  const names = body.deployments.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["app-1", "app-2"]);
  const app1 = body.deployments.find((entry) => entry.name === "app-1")!;
  assert.equal(app1.status, "applied");
  assert.equal(app1.resources.length, 1);
  assert.equal(app1.resources[0].name, "bucket");
  assert.equal(app1.resources[0].shape, "object-store@v1");
  assert.equal(app1.resources[0].provider, "aws-s3");
});

Deno.test(
  "GET /v1/deployments/:name returns a single deployment record",
  async () => {
    const recordStore = new InMemoryTakosumiDeploymentRecordStore();
    await recordStore.upsert({
      tenantId: "takosumi-deploy",
      name: "single",
      manifest: {},
      appliedResources: [{
        resourceName: "bucket",
        shape: "object-store@v1",
        providerId: "aws-s3",
        handle: "arn:single",
        outputs: { region: "us-east-1" },
        appliedAt: "2026-05-01T00:00:00.000Z",
      }],
      status: "applied",
      now: "2026-05-01T00:00:00.000Z",
    });
    const app = createApp({ token: VALID_TOKEN, recordStore });
    const response = await app.request(
      `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/single`,
      { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      name: string;
      status: string;
      resources: ReadonlyArray<{ outputs: Record<string, unknown> }>;
    };
    assert.equal(body.name, "single");
    assert.equal(body.status, "applied");
    assert.deepEqual(body.resources[0].outputs, { region: "us-east-1" });
  },
);

Deno.test("GET /v1/deployments/:name returns 404 when missing", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(
    `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/never-existed`,
    { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
});

Deno.test("GET /v1/deployments rejects missing token", async () => {
  const app = createApp({ token: VALID_TOKEN });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "unauthenticated");
});

Deno.test("GET /v1/deployments returns 404 when token env unset", async () => {
  const app = createApp({ token: undefined });
  const response = await app.request(TAKOSUMI_DEPLOY_PUBLIC_PATH, {
    headers: { authorization: "Bearer anything" },
  });
  assert.equal(response.status, 404);
});
