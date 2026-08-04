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

  test("accepts pending public managed operator capacity by explicit profile", () => {
    const managed = {
      scope: "operator" as const,
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "takoform.form-host.v1",
      },
    };
    expect(
      isProviderConnectionCandidate(
        connection({ ...managed, status: "pending" }),
      ),
    ).toBe(true);
    expect(
      isProviderConnectionCandidate(
        connection({ ...managed, status: "verified" }),
      ),
    ).toBe(true);
    for (const status of ["revoked", "expired", "error"] as const) {
      expect(
        isProviderConnectionCandidate(connection({ ...managed, status })),
      ).toBe(false);
    }
  });

  test("does not treat an unprofiled or Workspace-owned marker as public capacity", () => {
    expect(
      isProviderConnectionCandidate(
        connection({
          scope: "operator",
          scopeHints: { managedProvider: true },
        }),
      ),
    ).toBe(false);
    expect(
      isProviderConnectionCandidate(
        connection({
          scope: "workspace",
          status: "pending",
          scopeHints: {
            managedProvider: true,
            managedProviderProfile: "takoform.form-host.v1",
          },
        }),
      ),
    ).toBe(false);
  });

  test("uses the product label for public managed capacity", () => {
    expect(
      providerConnectionDisplayName(
        connection({
          scope: "operator",
          displayName: "Takoform portable form host",
          scopeHints: {
            managedProvider: true,
            managedProviderProfile: "takoform.form-host.v1",
          },
        }),
        "Takosumi Cloud",
      ),
    ).toBe("Takosumi Cloud");
  });

  test("keeps Workspace-owned connection display names unchanged", () => {
    expect(
      providerConnectionDisplayName(
        connection({ displayName: "My cloud account" }),
        "Takosumi Cloud",
      ),
    ).toBe("My cloud account");
    expect(
      providerConnectionDisplayName(connection(), "Takosumi Cloud"),
    ).toBe("connection_1");
  });
});
