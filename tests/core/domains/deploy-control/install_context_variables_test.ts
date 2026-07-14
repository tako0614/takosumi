import { expect, test } from "bun:test";
import {
  materializeInstallContextVariables,
  mergeInstallContextVariables,
} from "../../../../core/domains/deploy-control/validation.ts";

test("install context maps ledger ids into ordinary nested variables", () => {
  expect(
    materializeInstallContextVariables(
      {
        "env.APP_WORKSPACE_ID": "workspace_id",
        "env.APP_CAPSULE_ID": "capsule_id",
      },
      { workspaceId: "workspace_1", capsuleId: "capsule_1" },
    ),
  ).toEqual({
    env: {
      APP_WORKSPACE_ID: "workspace_1",
      APP_CAPSULE_ID: "capsule_1",
    },
  });
});

test("install context rejects unknown sources and unsafe variable paths", () => {
  expect(() =>
    materializeInstallContextVariables(
      { "env.APP_ID": "secret_value" as never },
      { workspaceId: "workspace_1", capsuleId: "capsule_1" },
    ),
  ).toThrow("unsupported source");
  expect(() =>
    materializeInstallContextVariables(
      { "env.__proto__.APP_ID": "capsule_id" },
      { workspaceId: "workspace_1", capsuleId: "capsule_1" },
    ),
  ).toThrow("dot-separated");
});

test("install context overrides only mapped identity leaves and preserves all other variables", () => {
  expect(
    mergeInstallContextVariables(
      {
        project_name: "storage",
        enable_cloudflare_resources: true,
        env: {
          LOG_LEVEL: "info",
          APP_WORKSPACE_ID: "untrusted-workspace",
        },
      },
      {
        "env.APP_WORKSPACE_ID": "workspace_id",
        "env.APP_CAPSULE_ID": "capsule_id",
      },
      { workspaceId: "workspace_1", capsuleId: "capsule_1" },
    ),
  ).toEqual({
    project_name: "storage",
    enable_cloudflare_resources: true,
    env: {
      LOG_LEVEL: "info",
      APP_WORKSPACE_ID: "workspace_1",
      APP_CAPSULE_ID: "capsule_1",
    },
  });
});
