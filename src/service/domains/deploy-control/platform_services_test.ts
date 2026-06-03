import { expect, test } from "bun:test";
import { deploymentOutputsFromOpenTofu } from "./mod.ts";

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
