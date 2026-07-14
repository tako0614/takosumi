import { expect, test } from "bun:test";
import { loadTakosumiRuntimeCapabilities } from "../../../../dashboard/src/lib/runtime-capabilities.ts";

const capabilities = {
  apiVersion: "takosumi.dev/v1alpha1",
  resources: { Stack: true },
  adapters: { opentofu: true },
  compat: { framework: true },
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
    managed_target_catalog: false,
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
          api: "https://operator.example/api",
          capabilities: "https://operator.example/custom/capabilities",
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
        api: "https://operator.example/api",
        capabilities: "https://untrusted.example/v1/capabilities",
        oidc_issuer: "https://operator.example",
      },
    });

  await expect(
    loadTakosumiRuntimeCapabilities(fetchImpl, "https://operator.example"),
  ).rejects.toThrow("same-origin");
});
