import { expect, test } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type { LegacyOutputInterfaceMigrationService } from "../../../core/domains/interfaces/legacy_output_migration.ts";

const PATH =
  "/internal/v1/workspaces/ws_migrate12/migrations/output-interfaces";
const candidate = {
  capsuleId: "cap_legacy",
  capsuleUpdatedAt: "2026-07-14T12:00:00.000Z",
  installConfigId: "cfg_legacy",
  installConfigUpdatedAt: "2026-07-14T12:00:00.000Z",
  outputId: "out_legacy",
  outputDigest: `sha256:${"a".repeat(64)}`,
  outputNamesDigest: `sha256:${"b".repeat(64)}`,
  legacyConventionNames: ["app_deployment"],
  availableOutputNames: ["app_deployment", "launch_url"],
  mode: "owner_selection_required",
} as const;

function appWithMigration(migration: LegacyOutputInterfaceMigrationService) {
  const store = new InMemoryOpenTofuControlStore();
  return createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller: new OpenTofuController({
        store,
        now: () => 1,
        newId: () => "plan_route_test",
      }),
      legacyOutputInterfaceMigrationService: migration,
      getDeployControlToken: () => "deploy-control-token",
    },
    requestCorrelation: false,
  });
}

test("Output-to-Interface migration route reports names-only candidates", async () => {
  const migration = {
    report: (workspaceId: string) =>
      Promise.resolve({
        workspaceId,
        candidates: [candidate],
        completed: [],
        issues: [],
      }),
    confirm: () => Promise.reject(new Error("not used")),
  } as unknown as LegacyOutputInterfaceMigrationService;
  const app = await appWithMigration(migration);

  const response = await app.request(PATH, {
    headers: { authorization: "Bearer deploy-control-token" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    workspaceId: "ws_migrate12",
    candidates: [candidate],
  });
});

test("Output-to-Interface migration route passes the exact route Workspace fence", async () => {
  let receivedWorkspaceId: string | undefined;
  let receivedActor: string | undefined;
  const migration = {
    report: () =>
      Promise.resolve({ candidates: [], completed: [], issues: [] }),
    confirm: (
      input: { readonly confirmedBy: string },
      expectedWorkspaceId?: string,
    ) => {
      receivedWorkspaceId = expectedWorkspaceId;
      receivedActor = input.confirmedBy;
      return Promise.resolve({
        capsuleId: "cap_legacy",
        outputId: "out_legacy",
        interfaceIds: ["if_legacy"],
        evidenceEventId: "act_migration",
      });
    },
  } as unknown as LegacyOutputInterfaceMigrationService;
  const app = await appWithMigration(migration);

  const response = await app.request(PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      candidate,
      selection: {
        name: "main-mcp",
        type: "mcp.server",
        version: "2025-11-25",
        document: { transport: "streamable-http" },
        inputName: "endpoint",
        outputName: "launch_url",
        access: { visibility: "private", resourceUriInput: "endpoint" },
      },
    }),
  });

  expect(response.status).toBe(200);
  expect(receivedWorkspaceId).toBe("ws_migrate12");
  expect(receivedActor).toBeTruthy();
});

test("Output-to-Interface migration route rejects incomplete copied candidates", async () => {
  const migration = {
    report: () =>
      Promise.resolve({ candidates: [], completed: [], issues: [] }),
    confirm: () =>
      Promise.reject(new Error("confirm must not receive an invalid body")),
  } as unknown as LegacyOutputInterfaceMigrationService;
  const app = await appWithMigration(migration);

  const response = await app.request(PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer deploy-control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ candidate: { capsuleId: "cap_legacy" } }),
  });

  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_argument");
});

test("production composition wires the migration service instead of returning 501", async () => {
  const { app } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-token",
    },
    opentofuControlStore: new InMemoryOpenTofuControlStore(),
  });

  const response = await app.request(PATH, {
    headers: { authorization: "Bearer deploy-control-token" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    workspaceId: "ws_migrate12",
    candidates: [],
    completed: [],
    issues: [],
  });
});
