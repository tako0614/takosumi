import { test, expect } from "bun:test";
import type { InstallConfig } from "../../../../contract/install-configs.ts";
import { publicInstallConfigRecord } from "../../../../core/domains/capsules/public_install_config.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function installConfig(): InstallConfig {
  return {
    id: "cfg_office",
    name: "takos-office",
    variableMapping: {
      app_url: "https://office.example.test",
      takos_storage_access_token: "tksa_live_not_a_real_token",
      mcp_auth_token: "mcp_live_not_a_real_token",
      admin_password: "hunter2",
      ordinary: {
        api_token: "nested-secret",
        safe: "ok",
      },
      array_value: [
        {
          nested_token: "array-secret",
          safe: "array-ok",
        },
      ],
      replicas: 3,
    },
    variablePresentation: [
      {
        name: "app_url",
        label: { en: "App URL" },
      },
      {
        name: "takos_storage_access_token",
        secret: true,
        label: { en: "Storage access token" },
      },
    ],
    outputAllowlist: {},
    policy: {},
    runnerId: "runner_operator",
    internal: { reason: "per_install_overrides" },
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: [
        { binding: "INTERNAL_SECRET", bytes: 32, encoding: "hex" },
      ],
      runtimeSecretFile: {
        contract: "takosumi.runtime-secret-file/v1",
        envName: "TAKOS_RUNTIME_SECRETS_FILE",
        fileName: "runtime.json",
        mode: 0o600,
        values: [
          { kind: "random", name: "FILE_SECRET", bytes: 32, encoding: "hex" },
        ],
      },
    },
    accountsOidcModuleVariableMaterialization: {
      contract: "takosumi.accounts-oidc-module-variables/v1",
      workerNameVariable: "worker_name",
      projectNameVariable: "project_name",
      issuerUrlVariable: "takosumi_accounts_issuer_url",
      clientIdVariable: "takosumi_accounts_client_id",
      ownerSubjectVariable: "oidc_owner_sub",
      allowUnpinnedOwnerClaimVariable: "allow_unpinned_owner_claim",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("public InstallConfig projection never returns secret install variables", () => {
  // The per-install config is addressable by id from the Capsule record and
  // authorized by Workspace membership alone, so any member could read the
  // catalog access token a previous installer typed in.
  const projected = publicInstallConfigRecord(installConfig());

  expect(projected.variableMapping.takos_storage_access_token).toBe(
    "[REDACTED]",
  );
  // Undeclared credential-shaped names are covered too: an install variable is
  // not required to carry a `secret: true` presentation entry.
  expect(projected.variableMapping.mcp_auth_token).toBe("[REDACTED]");
  expect(projected.variableMapping.admin_password).toBe("[REDACTED]");

  // Ordinary configuration is untouched.
  expect(projected.variableMapping.app_url).toBe("https://office.example.test");
  expect(projected.variableMapping.replicas).toBe(3);
  expect(projected.variableMapping.ordinary).toEqual({
    api_token: "[REDACTED]",
    safe: "ok",
  });
  expect(projected.variableMapping.array_value).toEqual([
    { nested_token: "[REDACTED]", safe: "array-ok" },
  ]);

  const serialized = JSON.stringify(projected);
  expect(serialized).not.toContain("tksa_live_not_a_real_token");
  expect(serialized).not.toContain("mcp_live_not_a_real_token");
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("nested-secret");
  expect(serialized).not.toContain("array-secret");
  // The projection still strips the operator-only fields it always did.
  expect(serialized).not.toContain("runner_operator");
  expect(serialized).not.toContain("per_install_overrides");
  expect(serialized).not.toContain("runtime-binding-profile");
  expect(serialized).not.toContain("INTERNAL_SECRET");
  expect(serialized).not.toContain("TAKOS_RUNTIME_SECRETS_FILE");
  expect(serialized).not.toContain("FILE_SECRET");
  expect(serialized).not.toContain("accounts-oidc-module-variables");
  expect(serialized).not.toContain("oidc_owner_sub");
});

test("public InstallConfig policy projection keeps only safe policy fields", () => {
  const projected = publicInstallConfigRecord({
    ...installConfig(),
    policy: {
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      providerCredentials: {
        requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        allowedConnectionScopes: ["workspace"],
        allowedCredentialRecipes: [
          { id: "cloudflare", authMode: "api_token" },
        ],
        requiredCredentialCapabilities: [
          "cloudflare.account-workers-subdomain.v1",
        ],
        requireTemporary: true,
        requireTtlEnforced: true,
        clientSecret: "provider-secret",
      },
      scopeBoundary: {
        mode: "strict",
        rules: [],
        operatorNote: "scope-secret",
      },
    } as unknown as InstallConfig["policy"],
  });

  expect(projected.policy).toMatchObject({
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    providerCredentials: {
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      allowedConnectionScopes: ["workspace"],
      allowedCredentialRecipes: [
        { id: "cloudflare", authMode: "api_token" },
      ],
      requiredCredentialCapabilities: [
        "cloudflare.account-workers-subdomain.v1",
      ],
      requireTemporary: true,
      requireTtlEnforced: true,
    },
    scopeBoundary: { mode: "strict", rules: [] },
  });
  const serialized = JSON.stringify(projected.policy);
  expect(serialized).not.toContain("clientSecret");
  expect(serialized).not.toContain("provider-secret");
  expect(serialized).not.toContain("operatorNote");
  expect(serialized).not.toContain("scope-secret");
});
