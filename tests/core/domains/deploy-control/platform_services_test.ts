import { expect, test } from "bun:test";
import { deploymentOutputsFromOpenTofu } from "../../../../core/domains/deploy-control/mod.ts";
import { normalizeDeploymentOutputs } from "../../../../core/domains/deploy-control/projection.ts";

test("deploymentOutputsFromOpenTofu publishes only non-sensitive well-known outputs", () => {
  expect(
    deploymentOutputsFromOpenTofu({
      launch_url: {
        sensitive: false,
        value: "https://app.example.test",
      },
      takosumi_admin_url: {
        sensitive: false,
        value: "https://admin.example.test",
      },
      database_password: {
        sensitive: true,
        value: "secret",
      },
      arbitrary: {
        sensitive: false,
        value: "not public metadata",
      },
      docs_url: {
        sensitive: false,
        value: "https://docs.example.test/callback?token=leaked",
      },
      health_url: {
        sensitive: false,
        value: "https://health.example.test/check?id=sk-status-raw",
      },
      takosumi_service_url: {
        sensitive: false,
        value: "https://service.example.test",
      },
    }),
  ).toEqual([
    {
      name: "launch_url",
      kind: "launch_url",
      value: "https://app.example.test",
      sensitive: false,
    },
    {
      name: "takosumi_admin_url",
      kind: "admin_url",
      value: "https://admin.example.test",
      sensitive: false,
    },
    {
      name: "takosumi_service_url",
      kind: "service_url",
      value: "https://service.example.test",
      sensitive: false,
    },
  ]);
});

test("deployment output projection rejects bare token-shaped public values", () => {
  expect(
    normalizeDeploymentOutputs([
      {
        name: "public_status",
        kind: "string",
        value: "sk-status-raw",
        sensitive: false,
      },
      {
        name: "public_metadata",
        kind: "json",
        value: {
          id: "visible",
          providerToken: "ghp_abcdefghijklmnopqrstuvwxyz",
        },
        sensitive: false,
      },
      {
        name: "safe_label",
        kind: "string",
        value: "ready",
        sensitive: false,
      },
    ]),
  ).toEqual([
    {
      name: "safe_label",
      kind: "string",
      value: "ready",
      sensitive: false,
    },
  ]);
});
