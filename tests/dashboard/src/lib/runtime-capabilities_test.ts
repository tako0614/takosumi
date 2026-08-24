import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTakosumiRuntimeCapabilities } from "../../../../dashboard/src/lib/runtime-capabilities.ts";

const capabilities = {
  apiVersion: "takosumi.dev/v1alpha1",
  resources: { Stack: true },
  adapters: { opentofu: true },
  identity: {
    oidc_issuer: true,
    external_oidc_login: true,
    workload_identity: false,
  },
  operator: {
    multi_tenant_workspaces: false,
    workspace_members: false,
    runner_pools: false,
    operator_connections: false,
    target_catalog: false,
    db_backed_configuration: false,
    cli_api_operations: false,
    usage_showback: true,
    audit_evidence: false,
  },
  extensions: [],
} as const;

test("dashboard loads feature truth from same-origin Takosumi discovery", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/.well-known/takosumi")) {
      return Response.json({
        api_versions: ["takosumi.dev/v1alpha1"],
        features: {},
        endpoints: {
          api: "https://operator.example/api/v1",
          capabilities: "https://operator.example/custom/capabilities",
          openapi: "https://operator.example/openapi.json",
          oidc_issuer: "https://operator.example",
        },
      });
    }
    return Response.json(capabilities);
  };

  const loaded = await loadTakosumiRuntimeCapabilities(
    fetchImpl,
    "https://operator.example",
  );

  expect(loaded.operator.usage_showback).toBe(true);
  expect(requests).toEqual([
    "https://operator.example/.well-known/takosumi",
    "https://operator.example/custom/capabilities",
  ]);
});

test("dashboard rejects cross-origin capability endpoints", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json({
      api_versions: ["takosumi.dev/v1alpha1"],
      features: {},
      endpoints: {
        api: "https://operator.example/api/v1",
        capabilities: "https://untrusted.example/api/v1/capabilities",
        openapi: "https://operator.example/openapi.json",
        oidc_issuer: "https://operator.example",
      },
    });

  await expect(
    loadTakosumiRuntimeCapabilities(fetchImpl, "https://operator.example"),
  ).rejects.toThrow("same-origin");
});

test("dashboard rejects capability documents without provider-neutral resources", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/.well-known/takosumi")) {
      return Response.json({
        api_versions: ["takosumi.dev/v1alpha1"],
        features: {},
        endpoints: {
          api: "https://operator.example/api/v1",
          capabilities: "https://operator.example/api/v1/capabilities",
          openapi: "https://operator.example/openapi.json",
          oidc_issuer: "https://operator.example",
        },
      });
    }
    const { resources: _resources, ...untyped } = capabilities;
    return Response.json(untyped);
  };

  await expect(
    loadTakosumiRuntimeCapabilities(fetchImpl, "https://operator.example"),
  ).rejects.toThrow("response is invalid");
});

test("dashboard resolves composition capabilities before its first render", () => {
  const source = readFileSync(
    resolve(import.meta.dir, "../../../../dashboard/src/index.tsx"),
    "utf8",
  );

  expect(source).toContain(
    "void initializeTakosumiRuntimeCapabilities().finally(mountDashboard);",
  );
  expect(source).not.toContain(
    "void initializeTakosumiRuntimeCapabilities();",
  );
});
