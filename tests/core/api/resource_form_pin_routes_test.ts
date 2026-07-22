import { expect, test } from "bun:test";
import type { InstalledFormReference } from "takosumi-contract";
import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type {
  BackfillResourceFormPinsRequest,
  ResourceFormPinOperations,
  RestoreResourceFormPinsRequest,
} from "../../../core/domains/resource-shape/form_pin_operations.ts";
import type {
  ResourceFormPinInventoryReader,
  ResourceFormPinInventoryReceipt,
} from "../../../core/domains/resource-shape/form_pin_inventory.ts";

const TOKEN = "scoped-token";
const WORKSPACE = "ws_allowed12";
const SPACE = "space_resources_a";
const BASE = `/internal/v1/workspaces/${WORKSPACE}/migrations/resource-form-pins`;
const INVENTORY_PATH = "/internal/v1/migrations/resource-form-pins/inventory";
const IDENTITY: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  packageDigest: `sha256:${"b".repeat(64)}`,
};

function emptyReport(dryRun: boolean) {
  return {
    dryRun,
    scanned: 0,
    wouldPin: 0,
    pinned: 0,
    alreadyPinned: 0,
    refused: 0,
    evidence: [],
  } as const;
}

async function fixture(
  resolveScope: (workspaceId: string) => string | undefined = (workspaceId) =>
    workspaceId === WORKSPACE ? SPACE : undefined,
  workspaceIds: "*" | readonly string[] = [WORKSPACE],
) {
  let backfillRequest: BackfillResourceFormPinsRequest | undefined;
  let restoreRequest: RestoreResourceFormPinsRequest | undefined;
  const operations = {
    async backfill(request: BackfillResourceFormPinsRequest) {
      backfillRequest = request;
      return emptyReport(request.dryRun === true);
    },
    async restore(request: RestoreResourceFormPinsRequest) {
      restoreRequest = request;
      return emptyReport(false);
    },
  } as unknown as ResourceFormPinOperations;
  const inventoryReceipt = {
    kind: "takosumi.resource-form-pin-inventory@v1",
    complete: true,
    capturedAt: "2026-07-22T00:00:00.000Z",
    matrixDigest: `sha256:${"c".repeat(64)}`,
    rows: [],
    matrix: [],
  } as unknown as ResourceFormPinInventoryReceipt;
  let inventoryCalls = 0;
  const inventory: ResourceFormPinInventoryReader = {
    async capture() {
      inventoryCalls += 1;
      return inventoryReceipt;
    },
  };
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller: new OpenTofuController({
        store: new InMemoryOpenTofuControlStore(),
      }),
      resourceFormPinOperations: operations,
      resourceFormPinInventory: inventory,
      resolveResourceFormPinScope: resolveScope,
      authorizeDeployControlBearer: ({ token }) =>
        token === TOKEN
          ? {
              actor: "acct_operator",
              workspaceIds,
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  return {
    app,
    backfillRequest: () => backfillRequest,
    restoreRequest: () => restoreRequest,
    inventoryCalls: () => inventoryCalls,
    inventoryReceipt,
  };
}

const headers = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
} as const;

test("exact FormRef backfill binds Workspace to the host-authorized Space and bearer actor", async () => {
  const { app, backfillRequest } = await fixture();
  const response = await app.request(`${BASE}/backfill`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "ObjectBucket",
      activationIds: ["activation_object_bucket"],
      dryRun: true,
      limit: 17,
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ dryRun: true, scanned: 0 });
  expect(backfillRequest()).toEqual({
    workspaceId: WORKSPACE,
    spaceId: SPACE,
    actorId: "acct_operator",
    kind: "ObjectBucket",
    activationIds: ["activation_object_bucket"],
    dryRun: true,
    limit: 17,
  });
});

test("exact FormRef routes reject caller-selected scope and a missing host mapping", async () => {
  const { app, backfillRequest } = await fixture();
  const callerScope = await app.request(`${BASE}/backfill`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "ObjectBucket",
      activationIds: ["activation_object_bucket"],
      spaceId: "space_attacker",
    }),
  });
  expect(callerScope.status).toBe(400);
  expect(backfillRequest()).toBeUndefined();

  const missing = await fixture(() => undefined);
  const noMapping = await missing.app.request(`${BASE}/backfill`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "ObjectBucket",
      activationIds: ["activation_object_bucket"],
    }),
  });
  expect(noMapping.status).toBe(409);
  expect((await noMapping.json()).error.message).toContain(
    "no authorized Resource Space mapping",
  );
});

test("exact FormRef restore accepts only a redacted exact identity sidecar", async () => {
  const { app, restoreRequest } = await fixture();
  const entry = {
    resourceId: "tkrn:space_resources_a:ObjectBucket:archive",
    resourceScopeId: SPACE,
    kind: "ObjectBucket",
    identity: IDENTITY,
  };
  const response = await app.request(`${BASE}/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({ entries: [entry], limit: 1 }),
  });
  expect(response.status).toBe(200);
  expect(restoreRequest()).toEqual({
    workspaceId: WORKSPACE,
    spaceId: SPACE,
    actorId: "acct_operator",
    entries: [entry],
    limit: 1,
  });

  const malformed = await app.request(`${BASE}/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      entries: [{ ...entry, identity: { latest: true } }],
    }),
  });
  expect(malformed.status).toBe(400);

  const leakedValue = await app.request(`${BASE}/restore`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      entries: [{ ...entry, spec: { password: "DO-NOT-ACCEPT" } }],
    }),
  });
  expect(leakedValue.status).toBe(400);
});

test("exact FormRef routes preserve Workspace-scoped bearer authorization", async () => {
  const { app } = await fixture();
  const denied = await app.request(
    "/internal/v1/workspaces/ws_denied12/migrations/resource-form-pins/backfill",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "ObjectBucket",
        activationIds: ["activation_object_bucket"],
      }),
    },
  );
  expect(denied.status).toBe(403);
});

test("authoritative inventory requires an unrestricted deploy-control bearer", async () => {
  const scoped = await fixture();
  const denied = await scoped.app.request(INVENTORY_PATH, { headers });
  expect(denied.status).toBe(403);
  expect(scoped.inventoryCalls()).toBe(0);

  const operator = await fixture(undefined, "*");
  const response = await operator.app.request(INVENTORY_PATH, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(operator.inventoryReceipt);
  expect(operator.inventoryCalls()).toBe(1);

  const unauthenticated = await operator.app.request(INVENTORY_PATH);
  expect(unauthenticated.status).toBe(401);
  expect(operator.inventoryCalls()).toBe(1);
});
