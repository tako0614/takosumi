import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { FormRef } from "takosumi-contract";
import { registerFormActivationRoutes } from "../../../core/api/form_activation_routes.ts";
import {
  FormRegistryService,
  InMemoryFormRegistryStore,
} from "../../../core/domains/service-forms/mod.ts";

const TOKEN = "operator-form-activation-token";
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const FORM_REF: FormRef = {
  apiVersion: "takoform.dev/v1alpha1",
  kind: "ObjectBucket",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
};

describe("Form Activation operator API", () => {
  test("requires the operator bearer and never trusts actor/commercial body fields", async () => {
    const { app } = await fixture();
    const noBearer = await app.request("/v1/form-activations");
    expect(noBearer.status).toBe(401);

    const actorInjection = await request(app, "/v1/form-activations", {
      method: "POST",
      body: JSON.stringify({
        ...createBody("activation_actor"),
        actorId: "customer-controlled",
      }),
    });
    expect(actorInjection.status).toBe(400);
    expect(await errorMessage(actorInjection)).toContain("actorId");

    const commercialInjection = await request(app, "/v1/form-activations", {
      method: "POST",
      body: JSON.stringify({
        ...createBody("activation_price"),
        price: { usd: 10 },
      }),
    });
    expect(commercialInjection.status).toBe(400);
    expect(await errorMessage(commercialInjection)).toContain("price");
  });

  test("creates, reads, pages, and CAS-updates exact noncommercial activations", async () => {
    const { app } = await fixture();
    const created = await request(app, "/v1/form-activations", {
      method: "POST",
      body: JSON.stringify(createBody("activation_public")),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');
    const activation = (await created.json()) as Record<string, unknown>;
    expect(activation.createdBy).toBe("self-host-operator");
    expect(activation.status).toBe("inactive");

    const second = await request(app, "/v1/form-activations", {
      method: "POST",
      body: JSON.stringify(createBody("activation_workspace")),
    });
    expect(second.status).toBe(201);

    const firstPage = await request(app, "/v1/form-activations?limit=1");
    expect(firstPage.status).toBe(200);
    const page = (await firstPage.json()) as {
      activations: readonly unknown[];
      nextCursor?: string;
    };
    expect(page.activations).toHaveLength(1);
    expect(page.nextCursor).toBeString();

    const read = await request(app, "/v1/form-activations/activation_public");
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe('"1"');

    const updated = await request(
      app,
      "/v1/form-activations/activation_public",
      {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: 1,
          status: "active",
          audience: { public: true },
        }),
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe('"2"');
    expect(((await updated.json()) as Record<string, unknown>).status).toBe(
      "active",
    );

    const stale = await request(app, "/v1/form-activations/activation_public", {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: 1, status: "inactive" }),
    });
    expect(stale.status).toBe(409);
  });

  test("does not mount an operable API when the operator bearer disappears", async () => {
    const { service } = await fixture();
    const app = new Hono();
    registerFormActivationRoutes(app, {
      service,
      getBearerToken: () => undefined,
    });
    const response = await request(app, "/v1/form-activations");
    expect(response.status).toBe(404);
  });
});

async function fixture() {
  const service = new FormRegistryService({
    store: new InMemoryFormRegistryStore(),
    artifactReader: { read: async () => new Uint8Array([1, 2, 3]) },
    verifier: {
      id: "test-verifier",
      verify: async () => ({
        packageDigest: PACKAGE_DIGEST,
        definitions: [
          {
            formRef: FORM_REF,
            operations: ["create", "read", "update", "delete"],
          },
        ],
      }),
    },
    now: (() => {
      let tick = 0;
      return () => `2026-07-16T00:00:0${tick++}.000Z`;
    })(),
  });
  await service.installPackage({
    artifactRef: "memory://signed-form-package",
    expectedPackageDigest: PACKAGE_DIGEST,
    actorId: "operator-bootstrap",
  });
  const app = new Hono();
  registerFormActivationRoutes(app, {
    service,
    getBearerToken: () => TOKEN,
  });
  return { app, service };
}

function createBody(id: string) {
  return {
    id,
    identity: { formRef: FORM_REF, packageDigest: PACKAGE_DIGEST },
    scope: { type: "operator" },
    audience: { public: false, roles: ["member"] },
    policy: { approval: "operator" },
    eligibleTargetPoolClasses: ["edge.object-store"],
  };
}

function request(app: Hono, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { message?: string } };
  return body.error?.message ?? "";
}
