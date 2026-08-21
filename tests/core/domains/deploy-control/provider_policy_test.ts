import { describe, expect, test } from "bun:test";
import type { ProviderCredentialMintEvidence } from "../../../../contract/security.ts";
import {
  evaluateProviderCredentialMintPolicy,
  mergePolicyConfigs,
} from "../../../../core/domains/deploy-control/provider_policy.ts";

const PROVIDER = "registry.terraform.io/tako0614/takoform";

function evidence(connectionId: string): ProviderCredentialMintEvidence {
  return {
    connectionId,
    provider: PROVIDER,
    temporary: true,
    ttlEnforced: true,
    expiresAt: "2026-08-20T23:00:00.000Z",
    ttlSeconds: 300,
    issuer: "takoserver-hosted",
    secretValueStored: false,
  };
}

describe("provider destination policy", () => {
  test("intersects allowed destinations and unions forbidden destinations", () => {
    expect(
      mergePolicyConfigs(
        {
          providerCredentials: {
            allowedConnectionIds: ["managed", "workspace"],
            forbiddenConnectionIds: ["legacy"],
          },
        },
        {
          providerCredentials: {
            allowedConnectionIds: ["managed"],
            forbiddenConnectionIds: ["workspace"],
          },
        },
      )?.providerCredentials,
    ).toMatchObject({
      allowedConnectionIds: ["managed"],
      forbiddenConnectionIds: ["legacy", "workspace"],
    });
  });

  test("rejects mint evidence for a destination outside the selected profile", () => {
    const managedPolicy = {
      providerCredentials: {
        requiredProviders: [PROVIDER],
        allowedConnectionIds: ["managed"],
        requireTemporary: true,
        requireTtlEnforced: true,
      },
    };
    expect(
      evaluateProviderCredentialMintPolicy(
        [evidence("managed")],
        managedPolicy,
        [PROVIDER],
        1,
      ).reasons,
    ).toEqual([]);
    expect(
      evaluateProviderCredentialMintPolicy(
        [evidence("workspace")],
        managedPolicy,
        [PROVIDER],
        1,
      ).reasons,
    ).toContain(
      "provider credential policy rejects unselected connections: workspace",
    );

    const byocPolicy = {
      providerCredentials: {
        requiredProviders: [PROVIDER],
        forbiddenConnectionIds: ["managed"],
      },
    };
    expect(
      evaluateProviderCredentialMintPolicy(
        [evidence("managed")],
        byocPolicy,
        [PROVIDER],
        1,
      ).reasons,
    ).toContain(
      "provider credential policy rejects forbidden connections: managed",
    );
  });
});
