import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "takosumi-contract";
import {
  isProviderConnectionCandidate,
  providerConnectionAllowedByInstallPolicy,
  providerConnectionMatchesProviderSource,
  preferredProviderConnection,
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

  test("prefers one supported operator destination over BYOK choices", () => {
    const managed = connection({
      id: "connection_managed",
      scope: "operator",
      displayName: "Takosumi Cloud",
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
    });
    const direct = connection({
      id: "connection_direct",
      displayName: "Cloudflare (direct)",
    });

    expect(preferredProviderConnection([direct, managed])).toBe(managed);
  });

  test("keeps unsupported and ambiguous destinations explicit", () => {
    const direct = connection({ id: "connection_direct" });
    expect(preferredProviderConnection([direct])).toBe(direct);
    expect(
      preferredProviderConnection([
        direct,
        connection({ id: "connection_direct_2" }),
      ]),
    ).toBeUndefined();

    const managedRecipe = {
      id: "operator-run",
      authMode: "capsule-run",
      runIssuance: {
        context: "capsule-run.v1" as const,
        operatorConnection: "workspace-bindable" as const,
        storedMaterial: "none" as const,
        audience: "extension.example.v1",
        scopes: ["extension:invoke"],
      },
    };
    expect(
      preferredProviderConnection([
        connection({
          id: "connection_managed_1",
          scope: "operator",
          credentialRecipe: managedRecipe,
        }),
        connection({
          id: "connection_managed_2",
          scope: "operator",
          credentialRecipe: managedRecipe,
        }),
      ]),
    ).toBeUndefined();
  });

  test("does not let a display name stand in for an exact provider destination", () => {
    const v01 = connection({
      id: "connection_v01",
      providerSource: "registry.opentofu.org/example/provider-v01",
      scope: "operator",
      displayName: "Takosumi Cloud",
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
    });
    const v02 = connection({
      id: "connection_v02",
      providerSource: "registry.opentofu.org/example/provider-v02",
      scope: "operator",
      displayName: "Takosumi Cloud",
      credentialRecipe: v01.credentialRecipe,
    });

    expect(preferredProviderConnection([v01])).toBe(v01);
    expect(preferredProviderConnection([v02])).toBe(v02);
    expect(
      providerConnectionMatchesProviderSource(
        "registry.opentofu.org/example/provider-v02",
        v01,
      ),
    ).toBe(false);
    expect(
      providerConnectionMatchesProviderSource("example/provider-v02", v02),
    ).toBe(true);
    expect(providerConnectionDisplayName(v01)).toBe("Takosumi Cloud");
    expect(providerConnectionDisplayName(v02)).toBe("Takosumi Cloud");
  });

  test("keeps managed and BYOC destinations disjoint for one provider source", () => {
    const managed = connection({ id: "conn_takoserverTakoform01" });
    const byoc = connection({ id: "conn_workspace_takoform" });

    expect(
      providerConnectionAllowedByInstallPolicy(managed, {
        providerCredentials: { allowedConnectionIds: [managed.id] },
      }),
    ).toBe(true);
    expect(
      providerConnectionAllowedByInstallPolicy(byoc, {
        providerCredentials: { allowedConnectionIds: [managed.id] },
      }),
    ).toBe(false);
    expect(
      providerConnectionAllowedByInstallPolicy(managed, {
        providerCredentials: { forbiddenConnectionIds: [managed.id] },
      }),
    ).toBe(false);
    expect(
      providerConnectionAllowedByInstallPolicy(byoc, {
        providerCredentials: { forbiddenConnectionIds: [managed.id] },
      }),
    ).toBe(true);
  });
});
