import { expect, test } from "bun:test";
import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";
import {
  assertValidTemplate,
  defaultTemplateRegistry,
  TemplateRegistry,
  validateTemplateInputs,
} from "./mod.ts";

test("built-in registry resolves the official catalog templates by id+version", () => {
  const r2 = defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0");
  expect(r2.source.localModulePath).toEqual(
    "/app/templates/cloudflare-r2-storage/module",
  );
  const worker = defaultTemplateRegistry.require(
    "cloudflare-worker-service",
    "1.0.0",
  );
  expect(worker.build?.artifactPath).toEqual("dist/index.js");
  expect(worker.build?.commands).toContain("bun run build");
});

test("built-in registry resolves the core base-installation template", () => {
  const core = defaultTemplateRegistry.require("core", "1.0.0");
  expect(core.source.localModulePath).toEqual("/app/templates/core/module");
  // core is a pure value-plumbing module: zero providers, zero resource types.
  expect(core.policy.allowedProviders).toEqual([]);
  expect(core.policy.allowedResourceTypes).toEqual([]);
});

test("registry require throws not_found for an unknown id or version", () => {
  expect(() => defaultTemplateRegistry.require("nope", "1.0.0")).toThrow(
    /not in the official catalog/,
  );
  expect(() =>
    defaultTemplateRegistry.require("cloudflare-r2-storage", "9.9.9")
  ).toThrow(/not in the official catalog/);
});

test("registry rejects a catalog with a duplicate id+version", () => {
  const t = defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0");
  expect(() => new TemplateRegistry([t, t])).toThrow(/duplicate template/);
});

test("assertValidTemplate rejects traversal in the in-image module path", () => {
  const bad: TemplateDefinition = {
    ...defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0"),
    source: { localModulePath: "/app/../etc/passwd" },
  };
  expect(() => assertValidTemplate(bad)).toThrow(/localModulePath/);
});

test("validateTemplateInputs validates types, required, defaults, and unknown keys", () => {
  const template = defaultTemplateRegistry.require(
    "cloudflare-r2-storage",
    "1.0.0",
  );
  // Required input missing.
  expect(() => validateTemplateInputs(template, { accountId: "a" })).toThrow(
    /bucketName is required/,
  );
  // Wrong type.
  expect(() =>
    validateTemplateInputs(template, { bucketName: 1, accountId: "a" })
  ).toThrow(/bucketName must be a string/);
  // Unknown input.
  expect(() =>
    validateTemplateInputs(template, {
      bucketName: "b",
      accountId: "a",
      bogus: "x",
    })
  ).toThrow(/unknown input bogus/);
  // Optional with default filled; required passed through.
  const normalized = validateTemplateInputs(template, {
    bucketName: "b",
    accountId: "a",
  });
  expect(normalized).toEqual({ bucketName: "b", accountId: "a", location: "" });
});

test("validateTemplateInputs rejects non-finite numbers", () => {
  const template: TemplateDefinition = {
    ...defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0"),
    inputs: {
      retentionDays: { type: "number", title: "Retention", required: true },
    },
  };
  expect(() =>
    validateTemplateInputs(template, { retentionDays: Infinity })
  ).toThrow(/finite number/);
});
