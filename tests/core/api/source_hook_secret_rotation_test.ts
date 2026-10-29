import { expect, test } from "bun:test";
import { createApiApp } from "../../../core/api/mod.ts";
import { SourcesService } from "../../../core/domains/sources/mod.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../core/adapters/storage/artifact-references.ts";
import { SOURCE_HOOK_SECRET_ROTATE_PATH } from "takosumi-contract/sources";
import { WorkspacesService } from "../../../core/domains/workspaces/mod.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { handleSourceWebhookRequest } from "../../../deploy/platform/worker.ts";
import { sha256HexOfStringAsync } from "../../../core/shared/runtime/hash.ts";
import { sourceSchemas } from "../../../core/api/openapi.ts";
import { DEPLOY_CONTROL_SOURCE_ENDPOINTS } from "../../../core/api/deploy_control_source_routes.ts";
import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "../../../accounts/service/src/control-route-inventory.ts";

const WORKSPACE_ID = "ws_rotation00000001";
const HEADERS = { authorization: "Bearer rotation-writer" };

async function fixture() {
  const store = new InMemoryOpenTofuControlStore();
  const workspacesService = new WorkspacesService({ store });
  await store.putWorkspace({
    id: WORKSPACE_ID, handle: "hook-rotation", displayName: "Hook rotation",
    type: "personal", ownerUserId: "acct_rotation",
    createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
  });
  const sources = new SourcesService({ store, artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator() });
  const controller = new OpenTofuController({ store, sourcesService: sources });
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller, workspacesService,
      authorizeDeployControlBearer: ({ token }) => token === "rotation-writer"
        ? { actor: "acct_rotation", workspaceIds: [WORKSPACE_ID], operations: "*", runnerProfileIds: "*" }
        : token === "other-workspace"
          ? { actor: "acct_other", workspaceIds: ["ws_other"], operations: "*", runnerProfileIds: "*" }
          : undefined,
    },
    requestCorrelation: false,
  });
  const created = await sources.createSource({
    workspaceId: WORKSPACE_ID, name: "rotation", url: "https://example.test/repo.git",
  });
  const path = SOURCE_HOOK_SECRET_ROTATE_PATH(created.source.id);
  const webhook = async (secret: string) => {
    const url = new URL(`https://example.test/hooks/sources/${created.source.id}`);
    return await handleSourceWebhookRequest(new Request(url, {
      method: "POST", headers: { authorization: `Bearer ${secret}` },
    }), url, {
      getSource: (id) => sources.getSource(id),
      verifySourceHookSecret: (id, bearer) => sources.verifyHookSecret(id, bearer),
      createSourceReconciliationSyncs: (id) => sources.createReconciliationSyncs(id),
    });
  };
  return { store, sources, app, created, path, webhook };
}

test("rotation commits hash and value-free audit; old webhook is rejected and new webhook accepted", async () => {
  const { app, store, sources, created, path, webhook } = await fixture();
  const response = await app.request(path, { method: "POST", headers: HEADERS });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const rotated = await response.json();
  expect(rotated.source.id).toBe(created.source.id);
  expect(rotated.hookSecret).toMatch(/^whk_[0-9a-f]{64}$/u);
  expect(rotated.hookSecret).not.toBe(created.hookSecret);
  const stored = await store.getSource(created.source.id);
  expect(stored?.hookSecretHash).toBe(await sha256HexOfStringAsync(rotated.hookSecret));
  expect((await webhook(created.hookSecret)).status).toBe(401);
  expect((await store.listSourceSyncRuns(WORKSPACE_ID))).toHaveLength(0);
  expect((await webhook(rotated.hookSecret)).status).toBe(202);
  const events = await store.listActivityEvents(WORKSPACE_ID);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    action: "source.hook_secret_rotated", actorId: "acct_rotation",
    workspaceId: WORKSPACE_ID, targetType: "source", targetId: created.source.id, metadata: {},
  });
  const persisted = JSON.stringify({ stored, events, runs: await store.listSourceSyncRuns(WORKSPACE_ID) });
  expect(persisted).not.toContain(created.hookSecret);
  expect(persisted).not.toContain(rotated.hookSecret);
  const publicResponses = JSON.stringify({
    read: await sources.getSource(created.source.id), list: await sources.listSources(WORKSPACE_ID),
  });
  expect(publicResponses).not.toContain("hookSecret");
  expect(publicResponses).not.toContain(rotated.hookSecret);
});

test("rotation rejects absent/invalid bearer, wrong Workspace and caller-chosen secret without mutation", async () => {
  const { app, store, created, path } = await fixture();
  const before = await store.getSource(created.source.id);
  for (const [headers, status] of [
    [{}, 401], [{ authorization: "Bearer invalid" }, 401],
    [{ authorization: "Bearer other-workspace" }, 403],
  ] as const) {
    const response = await app.request(path, { method: "POST", headers });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("hookSecret");
  }
  const rejected = await app.request(path, {
    method: "POST", headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ hookSecret: "caller-controlled" }),
  });
  expect(rejected.status).toBe(400);
  expect(await store.getSource(created.source.id)).toEqual(before);
  expect(await store.listActivityEvents(WORKSPACE_ID)).toHaveLength(0);
});

test("lost rotation response cannot be replayed; explicit second POST revokes its secret", async () => {
  const { app, sources, store, created, path } = await fixture();
  const first = await app.request(path, { method: "POST", headers: HEADERS });
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  const second = await app.request(path, { method: "POST", headers: HEADERS });
  expect(second.status).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.hookSecret).not.toBe(firstBody.hookSecret);
  expect(await sources.verifyHookSecret(created.source.id, created.hookSecret)).toBe(false);
  expect(await sources.verifyHookSecret(created.source.id, firstBody.hookSecret)).toBe(false);
  expect(await sources.verifyHookSecret(created.source.id, secondBody.hookSecret)).toBe(true);
  expect(await store.listActivityEvents(WORKSPACE_ID)).toHaveLength(2);
});

test("concurrent rotation returns exactly one acknowledged secret and one value-free conflict", async () => {
  const { app, sources, store, created, path } = await fixture();
  const responses = await Promise.all([
    app.request(path, { method: "POST", headers: HEADERS }),
    app.request(path, { method: "POST", headers: HEADERS }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = await responses.find((r) => r.status === 200)!.json();
  const conflict = await responses.find((r) => r.status === 409)!.text();
  expect(conflict).not.toContain("hookSecret");
  expect(conflict).not.toContain(winner.hookSecret);
  expect(await sources.verifyHookSecret(created.source.id, created.hookSecret)).toBe(false);
  expect(await sources.verifyHookSecret(created.source.id, winner.hookSecret)).toBe(true);
  expect(await store.listActivityEvents(WORKSPACE_ID)).toHaveLength(1);
});

test("rotation contract is present in internal and Accounts inventories and OpenAPI schemas", () => {
  const endpoint = DEPLOY_CONTROL_SOURCE_ENDPOINTS.find((e) => e.operationId === "rotateSourceHookSecret");
  expect(endpoint).toMatchObject({
    method: "POST", path: "/internal/v1/sources/:sourceId/hook-secret/rotate",
    openapi: { pathParams: ["sourceId"], okSchema: "RotateSourceHookSecretResponse" },
  });
  expect(PUBLIC_SESSION_CONTROL_ENDPOINTS.some((e) =>
    e.method === "POST" && e.path === "/api/v1/sources/{sourceId}/hook-secret/rotate",
  )).toBe(true);
  expect(sourceSchemas().RotateSourceHookSecretResponse).toMatchObject({
    type: "object", required: ["source", "hookSecret"], additionalProperties: false,
    properties: { hookSecret: { type: "string", pattern: "^whk_[0-9a-f]{64}$" } },
  });
});
