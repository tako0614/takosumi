import { expect, test } from "bun:test";

import {
  extractDeploymentOutputs,
  parseOpenTofuOutputs,
  toDeployControlOutputEnvelope,
} from "./opentofu-output-resolver.ts";

const OUTPUTS = {
  launch_url: {
    sensitive: false,
    type: "string",
    value: "https://app.example.test",
  },
  takosumi_admin_url: {
    sensitive: false,
    type: "string",
    value: "https://admin.example.test",
  },
  oidc_client_secret: {
    sensitive: true,
    type: "string",
    value: "secret-value",
  },
  object_store: {
    sensitive: false,
    type: ["object", { bucket: "string", endpoint: "string" }],
    value: {
      bucket: "app-assets",
      endpoint: "https://r2.example.test",
    },
  },
};

test("parseOpenTofuOutputs reads tofu output -json shape", () => {
  expect(parseOpenTofuOutputs(JSON.stringify(OUTPUTS))).toEqual(OUTPUTS);
});

test("extractDeploymentOutputs publishes only well-known non-sensitive outputs", () => {
  expect(extractDeploymentOutputs({ outputs: OUTPUTS })).toEqual([
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
  ]);
});

test("extractDeploymentOutputs accepts explicit output kind mappings", () => {
  expect(
    extractDeploymentOutputs({
      outputs: OUTPUTS,
      outputKinds: { object_store: "service_url" },
    }),
  ).toContainEqual({
    name: "object_store",
    kind: "service_url",
    value: {
      bucket: "app-assets",
      endpoint: "https://r2.example.test",
    },
    sensitive: false,
  });
});

test("toDeployControlOutputEnvelope validates JSON-safe output values", () => {
  expect(toDeployControlOutputEnvelope(parseOpenTofuOutputs(OUTPUTS)).launch_url)
    .toEqual({
      sensitive: false,
      type: "string",
      value: "https://app.example.test",
    });
});

test("parseOpenTofuOutputs rejects malformed output records", () => {
  expect(() => parseOpenTofuOutputs({ bad: { sensitive: false } })).toThrow(
    "value field",
  );
});
