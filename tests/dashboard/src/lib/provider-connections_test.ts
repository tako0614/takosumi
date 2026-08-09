import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "takosumi-contract";
import {
  isProviderConnectionCandidate,
  providerConnectionDisplayName,
} from "../../../../dashboard/src/lib/provider-connections.ts";

const NOW = "2026-08-02T00:00:00.000Z";

function connection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "connection_1",
    provider: "registry.opentofu.org/example/provider",
    providerSource: "registry.opentofu.org/example/provider",
    scope: "workspace",
    status: "verified",
    materialization: "provider",
    envNames: ["EXAMPLE_TOKEN"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("dashboard ProviderConnection candidates", () => {
  test("keeps verified Workspace connections available", () => {
    expect(isProviderConnectionCandidate(connection())).toBe(true);
    expect(
      isProviderConnectionCandidate(
        connection({ status: "pending" }),
      ),
    ).toBe(false);
  });

  test("accepts only verified operator capacity with the exact run recipe", () => {
    const runIssued = {
      scope: "operator" as const,
      credentialRecipe: {
        id: "operator-run",
        authMode: "capsule-run",
        preRunAction: "operator.run.v1",
        runIssuance: {
          context: "capsule-run.v1" as const,
          operatorConnection: "workspace-bindable" as const,
          storedMaterial: "none" as const,
          audience: "extension.example.v1",
          scopes: ["extension:invoke"],
        },
      },
    };
    expect(
      isProviderConnectionCandidate(
        connection({ ...runIssued, status: "pending" }),
      ),
    ).toBe(false);
    expect(
      isProviderConnectionCandidate(
        connection({ ...runIssued, status: "verified" }),
      ),
    ).toBe(true);
    for (const status of ["revoked", "expired", "error"] as const) {
      expect(
        isProviderConnectionCandidate(connection({ ...runIssued, status })),
      ).toBe(false);
    }
  });

  test("legacy managed fields and Workspace-owned run recipes grant no authority", () => {
    expect(
      isProviderConnectionCandidate(
        connection({
          scope: "operator",
          scopeHints: {
            managedProvider: true,
            managedProviderProfile: "legacy.example.v1",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isProviderConnectionCandidate(
        connection({
          scope: "workspace",
          status: "pending",
          credentialRecipe: {
            id: "operator-run",
            authMode: "capsule-run",
            runIssuance: {
              context: "capsule-run.v1",
              operatorConnection: "workspace-bindable",
              storedMaterial: "none",
              audience: "extension.example.v1",
              scopes: ["extension:invoke"],
            },
          },
        }),
      ),
    ).toBe(false);
  });

  test("keeps the persisted label for a verified run-issued operator connection", () => {
    expect(
      providerConnectionDisplayName(
        connection({
          scope: "operator",
          displayName: "Takoform portable form host",
          credentialRecipe: {
            id: "operator-run",
            authMode: "capsule-run",
            runIssuance: {
              context: "capsule-run.v1",
              operatorConnection: "workspace-bindable",
              storedMaterial: "none",
              audience: "extension.example.v1",
              scopes: ["extension:invoke"],
            },
          },
        }),
      ),
    ).toBe("Takoform portable form host");
  });

  test("keeps Workspace-owned connection display names unchanged", () => {
    expect(
      providerConnectionDisplayName(
        connection({ displayName: "My cloud account" }),
      ),
    ).toBe("My cloud account");
    expect(providerConnectionDisplayName(connection())).toBe("connection_1");
  });
});
