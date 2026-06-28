import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import {
  assertValidTemplate,
  defaultTemplateRegistry,
  TemplateRegistry,
  validateTemplateInputs,
} from "../../../../core/domains/templates/mod.ts";

test("built-in registry resolves first-party modules by id+version", () => {
  const r2 = defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0");
  expect(r2.source.localModulePath).toEqual(
    "/app/templates/cloudflare-r2-storage/module",
  );
});

test("built-in registry resolves but does not list the legacy worker build module", () => {
  const listedIds = defaultTemplateRegistry
    .list()
    .map((template) => template.id);
  expect(listedIds).not.toContain("cloudflare-worker-service");
  const worker = defaultTemplateRegistry.require(
    "cloudflare-worker-service",
    "1.0.0",
  );
  expect(worker.build?.artifactPath).toEqual("dist/index.js");
  expect(worker.build?.commands).toContain("bun run build");
});

test("active built-in registry modules never define Takosumi-owned build dispatch", () => {
  for (const template of defaultTemplateRegistry.list()) {
    expect(template.build).toBeUndefined();
  }
});

test("built-in registry resolves the core base Capsule module", () => {
  const core = defaultTemplateRegistry.require("core", "1.0.0");
  expect(core.source.localModulePath).toEqual("/app/templates/core/module");
  // core is a pure value-plumbing module: zero providers, zero resource types.
  expect(core.policy.allowedProviders).toEqual([]);
  expect(core.policy.allowedResourceTypes).toEqual([]);
});

test("built-in registry resolves bundled module files for every first-party module", () => {
  for (const template of defaultTemplateRegistry.list()) {
    const files = defaultTemplateRegistry.requireModuleFiles(
      template.id,
      template.version,
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.path === "main.tf")).toBe(true);
    for (const file of files) {
      expect(file.path.startsWith("/")).toBe(false);
      expect(file.path.includes("..")).toBe(false);
      expect(file.text.length).toBeGreaterThan(0);
    }
  }
});

// On-disk home of each first-party module's human-readable OpenTofu surface.
// `core` stays under `opentofu-modules/`; provider-specific modules live under
// `providers/<provider>/modules/<id>/`.
const MODULE_DIRS: Readonly<Record<string, string>> = {
  core: "opentofu-modules/core",
  "cloudflare-hello-worker":
    "providers/cloudflare/modules/cloudflare-hello-worker",
  "cloudflare-r2-storage": "providers/cloudflare/modules/cloudflare-r2-storage",
  "cloudflare-static-site":
    "providers/cloudflare/modules/cloudflare-static-site",
  "aws-s3-storage": "providers/aws/modules/aws-s3-storage",
};

test("bundled module files match the first-party module sources", async () => {
  for (const template of defaultTemplateRegistry.list()) {
    const files = defaultTemplateRegistry.requireModuleFiles(
      template.id,
      template.version,
    );
    const main = files.find((file) => file.path === "main.tf");
    expect(main).toBeDefined();
    const moduleDir = MODULE_DIRS[template.id];
    expect(moduleDir, `on-disk module dir for ${template.id}`).toBeDefined();
    const source = await readFile(
      join(import.meta.dir, "../../../..", moduleDir!, "module/main.tf"),
      "utf8",
    );
    expect(main?.text).toEqual(source);
  }
});

test("registry require throws not_found for an unknown id or version", () => {
  expect(() => defaultTemplateRegistry.require("nope", "1.0.0")).toThrow(
    /not a built-in Capsule module/,
  );
  expect(() =>
    defaultTemplateRegistry.require("cloudflare-r2-storage", "9.9.9"),
  ).toThrow(/not a built-in Capsule module/);
});

test("registry rejects a catalog with a duplicate id+version", () => {
  const t = defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0");
  expect(() => new TemplateRegistry([t, t])).toThrow(
    /duplicate first-party Capsule module/,
  );
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
    validateTemplateInputs(template, { bucketName: 1, accountId: "a" }),
  ).toThrow(/bucketName must be a string/);
  // Unknown input.
  expect(() =>
    validateTemplateInputs(template, {
      bucketName: "b",
      accountId: "a",
      bogus: "x",
    }),
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
    validateTemplateInputs(template, { retentionDays: Infinity }),
  ).toThrow(/finite number/);
});
