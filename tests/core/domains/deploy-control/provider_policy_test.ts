import { describe, expect, test } from "bun:test";
import type { PolicyConfig } from "../../../../contract/install-configs.ts";
import type { ProviderCredentialMintEvidence } from "../../../../contract/security.ts";
import {
  evaluateProviderConnectionCredentialPolicy,
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
  test("intersects ownership scopes and exact recipe/mode pairs", () => {
    expect(
      mergePolicyConfigs(
        {
          providerCredentials: {
            allowedConnectionScopes: ["workspace", "operator"],
            allowedCredentialRecipes: [
              { id: "cloudflare", authMode: "api_token" },
              { id: "cloudflare", authMode: "oauth" },
            ],
          },
        },
        {
          providerCredentials: {
            allowedConnectionScopes: ["workspace"],
            allowedCredentialRecipes: [
              { id: "cloudflare", authMode: "api_token" },
              { id: "other", authMode: "api_token" },
            ],
          },
        },
      )?.providerCredentials,
    ).toEqual({
      allowedConnectionScopes: ["workspace"],
      allowedCredentialRecipes: [{ id: "cloudflare", authMode: "api_token" }],
      requireTemporary: false,
      requireTtlEnforced: false,
    });
  });

  test("unions required capabilities and rejects connections missing one", () => {
    const requiredCapability = "cloudflare.account-workers-subdomain.v1";
    const policyA = {
      providerCredentials: {
        requiredCredentialCapabilities: [requiredCapability, "workspace.foo"],
      },
    } as unknown as PolicyConfig;
    const policyB = {
      providerCredentials: {
        requiredCredentialCapabilities: ["other.bar", requiredCapability],
      },
    } as unknown as PolicyConfig;
    expect(mergePolicyConfigs(policyA, policyB)?.providerCredentials).toMatchObject({
      requiredCredentialCapabilities: [
        requiredCapability,
        "other.bar",
        "workspace.foo",
      ],
    });

    const policy = {
      providerCredentials: {
        requiredCredentialCapabilities: [requiredCapability, "workspace.foo"],
      },
    } as unknown as PolicyConfig;
    expect(
      evaluateProviderConnectionCredentialPolicy(
        {
          id: "attested-cloudflare",
          scope: "workspace",
          credentialRecipe: { id: "cloudflare", authMode: "api_token" },
          credentialVerification: {
            kind: "takosumi.credential-verification@v1",
            // verifierId is provenance only; eligibility comes from capabilities.
            verifierId: "unrelated-verifier@v1",
            capabilities: [requiredCapability, "workspace.foo", "extra"],
          },
        },
        policy,
      ),
    ).toEqual([]);
    expect(
      evaluateProviderConnectionCredentialPolicy(
        {
          id: "missing-capability-cloudflare",
          scope: "workspace",
          credentialRecipe: { id: "cloudflare", authMode: "api_token" },
          credentialVerification: {
            kind: "takosumi.credential-verification@v1",
            verifierId: "unrelated-verifier@v1",
            capabilities: [requiredCapability],
          },
        },
        policy,
      ),
    ).toContain(
      "provider credential policy rejects connection missing-capability-cloudflare credential capabilities missing workspace.foo",
    );
    expect(
      evaluateProviderConnectionCredentialPolicy(
        {
          id: "wrong-verifier-cloudflare",
          scope: "workspace",
          credentialRecipe: { id: "cloudflare", authMode: "api_token" },
          credentialVerification: {
            kind: "takosumi.credential-verification@v1",
            verifierId: "other@v1",
            capabilities: [requiredCapability, "workspace.foo"],
          },
        },
        policy,
      ),
    ).toEqual([]);
    expect(
      evaluateProviderConnectionCredentialPolicy(
        {
          id: "legacy-cloudflare",
          scope: "workspace",
          credentialRecipe: { id: "cloudflare", authMode: "api_token" },
        },
        policy,
      ),
    ).toContain(
      "provider credential policy rejects connection legacy-cloudflare credential capabilities missing cloudflare.account-workers-subdomain.v1, workspace.foo",
    );
  });

  test("rejects an operator or wrong-recipe connection before mint", () => {
    const policy = {
      providerCredentials: {
        allowedConnectionScopes: ["workspace" as const],
        allowedCredentialRecipes: [
          { id: "cloudflare", authMode: "api_token" },
        ],
      },
    };
    expect(
      evaluateProviderConnectionCredentialPolicy(
        {
          id: "operator-cloudflare",
          scope: "operator",
          credentialRecipe: { id: "cloudflare", authMode: "api_token" },
        },
        policy,
      ),
    ).toEqual([
      "provider credential policy rejects connection operator-cloudflare scope operator",
    ]);
    expect(
      evaluateProviderConnectionCredentialPolicy(
        {
          id: "workspace-cloudflare",
          scope: "workspace",
          credentialRecipe: { id: "cloudflare", authMode: "oauth" },
        },
        policy,
      ),
    ).toEqual([
      "provider credential policy rejects connection workspace-cloudflare credential recipe cloudflare:oauth",
    ]);
  });

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
