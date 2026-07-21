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

  const serialized = JSON.stringify(projected);
  expect(serialized).not.toContain("tksa_live_not_a_real_token");
  expect(serialized).not.toContain("mcp_live_not_a_real_token");
  expect(serialized).not.toContain("hunter2");
  // The projection still strips the operator-only fields it always did.
  expect(serialized).not.toContain("runner_operator");
  expect(serialized).not.toContain("per_install_overrides");
});
