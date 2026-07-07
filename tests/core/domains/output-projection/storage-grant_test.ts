import { describe, expect, test } from "bun:test";

import { verifyStorageAccessToken } from "../../../../core/shared/storage_access_tokens.ts";
import { projectServicesFromOutputs } from "../../../../core/domains/output-projection/service-projection.ts";
import {
  issueStorageWorkspaceGrants,
  planStorageWorkspaceGrants,
} from "../../../../core/domains/output-projection/storage-grant.ts";

const SIGNING_KEY = "producer-signing-key-0011223344";

// The takos-storage producer's service_exports output.
const PRODUCER_OUTPUTS = {
  service_exports: [
    {
      name: "takos.storage.workspace",
      capabilities: ["storage.object", "protocol.http.api"],
      endpoints: [
        {
          name: "default",
          protocol: "https",
          pathPrefix: "/o",
          url: "https://storage.example/o",
        },
      ],
      visibility: "space",
    },
  ],
};

// A takos-office-shaped consumer that consumes the workspace storage.
const CONSUMER_OUTPUTS = {
  app_deployment: {
    name: "takos-office",
    compute: {
      web: {
        kind: "worker",
        consume: [
          {
            publication: "takos.storage.workspace",
            request: { scopes: ["files:read", "files:write"] },
            inject: {
              env: {
                url: "TAKOS_STORAGE_API_URL",
                token: "TAKOS_STORAGE_ACCESS_TOKEN",
              },
            },
          },
        ],
      },
    },
  },
};

function producerExport() {
  const { serviceExports } = projectServicesFromOutputs(PRODUCER_OUTPUTS);
  return serviceExports[0]!;
}

function consumerBindings() {
  // The consume publication is a non-standard capability token, so extensions
  // must be allowed when projecting a consumer that binds a custom service.
  return projectServicesFromOutputs(CONSUMER_OUTPUTS, {
    allowExtensionCapabilities: true,
  }).serviceBindings;
}

const CONTEXT = {
  workspaceId: "space_00112233aabbccdd",
  consumerInstallationId: "inst_0011223344556677",
};

describe("storage workspace grant resolution", () => {
  test("plans a grant confined to the consumer's own prefix with write verbs", () => {
    const plans = planStorageWorkspaceGrants(
      consumerBindings(),
      producerExport(),
      CONTEXT,
    );
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.apiUrl).toBe("https://storage.example/o");
    expect(plan.prefix).toBe("space_00112233aabbccdd/inst_0011223344556677/");
    expect(plan.verbs).toEqual(["r", "l", "w", "d"]);
    expect(plan.urlEnvVar).toBe("TAKOS_STORAGE_API_URL");
    expect(plan.tokenEnvVar).toBe("TAKOS_STORAGE_ACCESS_TOKEN");
  });

  test("issues an injectable env map with a verifiable token", async () => {
    const grants = await issueStorageWorkspaceGrants(
      consumerBindings(),
      { export: producerExport(), signingKey: SIGNING_KEY },
      CONTEXT,
      { now: () => 1_700_000_000_000 },
    );
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(grant.injectEnv.TAKOS_STORAGE_API_URL).toBe(
      "https://storage.example/o",
    );
    expect(grant.injectEnv.TAKOS_STORAGE_KEY_PREFIX).toBe(
      "space_00112233aabbccdd/inst_0011223344556677/",
    );

    const token = grant.injectEnv.TAKOS_STORAGE_ACCESS_TOKEN!;
    // The producer Worker verifies with the same key + format.
    const verified = await verifyStorageAccessToken(
      SIGNING_KEY,
      token,
      1_700_000_100,
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.sub).toBe("inst_0011223344556677");
      expect(verified.payload.pfx).toBe(
        "space_00112233aabbccdd/inst_0011223344556677/",
      );
      expect(verified.payload.cap).toContain("w");
    }
  });

  test("ignores producers that are not the workspace storage publication", () => {
    const otherExport = { ...producerExport(), name: "some.other.service" };
    expect(
      planStorageWorkspaceGrants(consumerBindings(), otherExport, CONTEXT),
    ).toHaveLength(0);
  });
});
