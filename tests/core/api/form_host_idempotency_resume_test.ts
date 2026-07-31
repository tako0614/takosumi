import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ActorContext } from "takosumi-contract";
import { registerPortableFormHostRoutes } from "../../../core/api/form_host_routes.ts";
import {
  InMemoryPortableHostIdempotencyLedger,
  PortableHostIdempotencyCoordinator,
} from "../../../core/api/portable_host_idempotency.ts";
import type { ResourceShapeService } from "../../../core/domains/resource-shape/mod.ts";

/**
 * A portable mutation interrupted after reserving its Idempotency-Key must stay
 * retryable. A provider derives that key from the operation identity, not from
 * the attempt, so a stranded reservation cannot be worked around by the
 * operator: the exact same key is presented forever.
 */

const ACTOR: ActorContext = {
  actorAccountId: "acct_writer",
  workspaceId: "workspace_1",
  roles: ["owner"],
  scopes: ["forms:write"],
  requestId: "req_resume",
};

const SPACE = "workspace_1";
const FORM_QUERY = [
  `space=${SPACE}`,
  "apiVersion=forms.takoform.com%2Fv1alpha1",
  "kind=ObjectBucket",
  "definitionVersion=1.0.0",
  `schemaDigest=sha256%3A${"a".repeat(64)}`,
  `packageDigest=sha256%3A${"b".repeat(64)}`,
].join("&");

/**
 * Fails the first backend attempt the way an unavailable provider control
 * plane does — by throwing, so the reservation is never resolved — then
 * succeeds on the next one.
 */
function serviceFailingOnce(attempts: { count: number }) {
  const succeed = () => {
    attempts.count += 1;
    if (attempts.count === 1) {
      throw new Error("backend control plane is unavailable");
    }
  };
  return {
    get: async () => ({ ok: true as const, value: resourceObject() }),
    delete: async () => {
      succeed();
      return { ok: true as const, value: undefined };
    },
    observe: async () => {
      succeed();
      return { ok: true as const, value: { resource: resourceObject() } };
    },
    refresh: async () => {
      succeed();
      return { ok: true as const, value: { resource: resourceObject() } };
    },
  } as unknown as ResourceShapeService;
}

function resourceObject() {
  return {
    kind: "ObjectBucket",
    form: {
      type: "object_bucket",
      version: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
      packageDigest: `sha256:${"b".repeat(64)}`,
    },
    metadata: {
      name: "assets",
      space: SPACE,
      generation: 1,
      resourceVersion: "1",
    },
    spec: { name: "assets" },
    status: {},
  };
}

function appFor(service: ResourceShapeService) {
  const app = new Hono();
  registerPortableFormHostRoutes(app, {
    service,
    availability: {
      listFormAvailability: async () => ({ items: [] }),
    },
    idempotency: new PortableHostIdempotencyCoordinator(
      new InMemoryPortableHostIdempotencyLedger(),
    ),
    authorize: async () => ({ ok: true, actor: ACTOR }),
    canReadForms: () => true,
  });
  return app;
}

async function callTwice(
  app: Hono,
  path: string,
  init: RequestInit,
): Promise<readonly [Response, Response]> {
  const url = `http://host${path}`;
  const first = await app
    .request(url, init)
    .catch(() => new Response(null, { status: 500 }));
  const second = await app.request(url, init);
  return [first, second];
}

test("an interrupted portable delete is retryable under the same Idempotency-Key", async () => {
  const attempts = { count: 0 };
  const app = appFor(serviceFailingOnce(attempts));
  const [first, second] = await callTwice(
    app,
    `/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets?${FORM_QUERY}`,
    {
      method: "DELETE",
      headers: {
        "Idempotency-Key": "delete-assets-generation-1",
        "If-Match": '"1"',
      },
    },
  );

  expect(first.status).toBeGreaterThanOrEqual(500);
  // Without a resume path this is 409 resource_busy forever.
  expect(second.status).toBe(204);
  expect(attempts.count).toBe(2);
});

test("an interrupted portable observe is retryable under the same Idempotency-Key", async () => {
  const attempts = { count: 0 };
  const app = appFor(serviceFailingOnce(attempts));
  const [, second] = await callTwice(
    app,
    `/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets/observe?${FORM_QUERY}`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": "observe-assets-generation-1",
        "If-Match": '"1"',
      },
    },
  );

  expect(second.status).toBe(200);
  expect(attempts.count).toBe(2);
});

test("an interrupted portable refresh is retryable under the same Idempotency-Key", async () => {
  const attempts = { count: 0 };
  const app = appFor(serviceFailingOnce(attempts));
  const [, second] = await callTwice(
    app,
    `/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets/refresh?${FORM_QUERY}`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": "refresh-assets-generation-1",
        "If-Match": '"1"',
      },
    },
  );

  expect(second.status).toBe(200);
  expect(attempts.count).toBe(2);
});
