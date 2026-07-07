import { describe, expect, test } from "bun:test";

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { CredentialMintEvent } from "takosumi-contract/security";
import { StorageGrantBroker } from "../../../../core/domains/deploy-control/storage_grant_broker.ts";
import type { OpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { SensitiveOutputResolver } from "../../../../core/domains/output-shares/mod.ts";
import { verifyStorageAccessToken } from "../../../../core/shared/storage_access_tokens.ts";

const WORKSPACE_ID = "space_00112233aabbccdd";
const PRODUCER_ID = "inst_aaaaaaaaaaaaaaaa";
const CONSUMER_ID = "inst_bbbbbbbbbbbbbbbb";
const SIGNING_KEY = "producer-signing-key-integration-01";
const NOW_MS = 1_700_000_000_000;

const PRODUCER_OUTPUTS = {
  service_exports: [
    {
      name: "takos.storage.object",
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

const CONSUMER_OUTPUTS = {
  app_deployment: {
    name: "takos-office",
    compute: {
      web: {
        kind: "worker",
        consume: [
          {
            publication: "takos.storage.object",
            request: { scopes: ["files:read", "files:write"] },
            inject: {
              env: {
                url: "TAKOS_OBJECT_API_URL",
                token: "TAKOS_OBJECT_ACCESS_TOKEN",
              },
            },
          },
        ],
      },
    },
  },
};

const OFFICIAL_INSTALL_CONFIG_ID = "cfg-catalog-takos-storage";
const IMPOSTOR_ID = "inst_cccccccccccccccc";
const IMPOSTOR_KEY = "attacker-controlled-signing-key-99";
const IMPOSTOR_OUTPUTS = {
  service_exports: [
    {
      name: "takos.storage.object",
      capabilities: ["storage.object", "protocol.http.api"],
      endpoints: [{ name: "default", protocol: "https", url: "https://attacker.example/o" }],
      visibility: "space",
    },
  ],
};

interface FakeStoreState {
  readonly installations: readonly {
    id: string;
    workspaceId: string;
    installConfigId?: string;
  }[];
  readonly outputs: Record<string, Record<string, unknown> | undefined>;
  readonly mintEvents: CredentialMintEvent[];
}

function makeStore(state: FakeStoreState): OpenTofuDeploymentStore {
  return {
    listInstallations: async (spaceId?: string) =>
      state.installations.filter(
        (i) => spaceId === undefined || i.workspaceId === spaceId,
      ),
    getLatestOutputSnapshot: async (installationId: string) => {
      const workspaceOutputs = state.outputs[installationId];
      if (!workspaceOutputs) return undefined;
      return {
        id: `out_${installationId}`,
        installationId,
        workspaceOutputs,
      } as unknown as Awaited<
        ReturnType<OpenTofuDeploymentStore["getLatestOutputSnapshot"]>
      >;
    },
    putCredentialMintEvent: async (event: CredentialMintEvent) => {
      state.mintEvents.push(event);
      return event;
    },
  } as unknown as OpenTofuDeploymentStore;
}

function makeResolver(signingKey: string | undefined): SensitiveOutputResolver {
  return {
    resolve: async (input) => {
      if (
        input.outputName !== "takos_storage_signing_key" ||
        signingKey === undefined
      ) {
        return undefined;
      }
      return { value: signingKey, sensitive: true };
    },
  };
}

function makePlanRun(): PlanRun {
  return {
    workspaceId: WORKSPACE_ID,
    installationId: CONSUMER_ID,
  } as unknown as PlanRun;
}

function fullState(overrides: Partial<FakeStoreState> = {}): FakeStoreState {
  return {
    installations: [
      {
        id: PRODUCER_ID,
        workspaceId: WORKSPACE_ID,
        installConfigId: OFFICIAL_INSTALL_CONFIG_ID,
      },
      { id: CONSUMER_ID, workspaceId: WORKSPACE_ID },
    ],
    outputs: {
      [PRODUCER_ID]: PRODUCER_OUTPUTS,
      [CONSUMER_ID]: CONSUMER_OUTPUTS,
    },
    mintEvents: [],
    ...overrides,
  };
}

function broker(state: FakeStoreState, signingKey: string | undefined) {
  return brokerWith(state, makeResolver(signingKey));
}

function keyedResolver(
  keysByProducer: Record<string, string>,
): SensitiveOutputResolver {
  return {
    resolve: async (input) => {
      const key = keysByProducer[input.producerInstallationId];
      if (input.outputName !== "takos_storage_signing_key" || key === undefined) {
        return undefined;
      }
      return { value: key, sensitive: true };
    },
  };
}

function brokerWith(state: FakeStoreState, resolver: SensitiveOutputResolver) {
  return new StorageGrantBroker({
    store: makeStore(state),
    newId: (prefix) => `${prefix}_test`,
    now: () => NOW_MS,
    sensitiveOutputResolver: resolver,
  });
}

describe("StorageGrantBroker", () => {
  test("mints a scoped token + TF_VAR env and records evidence", async () => {
    const state = fullState();
    const env = await broker(state, SIGNING_KEY).mintStorageGrantEnv(
      makePlanRun(),
      "apply",
      "run_audit_1",
    );
    expect(env).toBeDefined();
    expect(env!.TF_VAR_takos_object_api_url).toBe("https://storage.example/o");
    expect(env!.TF_VAR_takos_object_key_prefix).toBe(
      `${WORKSPACE_ID}/${CONSUMER_ID}/`,
    );

    const token = env!.TF_VAR_takos_object_access_token!;
    const verified = await verifyStorageAccessToken(
      SIGNING_KEY,
      token,
      Math.floor(NOW_MS / 1000) + 60,
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.sub).toBe(CONSUMER_ID);
      expect(verified.payload.pfx).toBe(`${WORKSPACE_ID}/${CONSUMER_ID}/`);
      expect(verified.payload.cap).toContain("w");
    }

    expect(state.mintEvents).toHaveLength(1);
    const evidence = state.mintEvents[0]!.providerCredentialEvidence![0]!;
    expect(evidence.issuer).toBe("takosumi_storage_scoped_token");
    expect(evidence.temporary).toBe(true);
    expect(evidence.secretValueStored).toBe(false);
    expect(state.mintEvents[0]!.capsuleId).toBe(CONSUMER_ID);
  });

  test("skips when the consumer declares no storage consume", async () => {
    const state = fullState({
      outputs: { [PRODUCER_ID]: PRODUCER_OUTPUTS, [CONSUMER_ID]: {} },
    });
    const env = await broker(state, SIGNING_KEY).mintStorageGrantEnv(
      makePlanRun(),
      "apply",
      "run_audit_2",
    );
    expect(env).toBeUndefined();
    expect(state.mintEvents).toHaveLength(0);
  });

  test("skips (fail-open) when no producer is installed in the workspace", async () => {
    const state = fullState({
      installations: [{ id: CONSUMER_ID, workspaceId: WORKSPACE_ID }],
      outputs: { [CONSUMER_ID]: CONSUMER_OUTPUTS },
    });
    const env = await broker(state, SIGNING_KEY).mintStorageGrantEnv(
      makePlanRun(),
      "apply",
      "run_audit_3",
    );
    expect(env).toBeUndefined();
  });

  test("skips when the signing key can't be resolved", async () => {
    const state = fullState();
    const env = await broker(state, undefined).mintStorageGrantEnv(
      makePlanRun(),
      "apply",
      "run_audit_4",
    );
    expect(env).toBeUndefined();
  });

  test("does not mint on destroy", async () => {
    const state = fullState();
    const env = await broker(state, SIGNING_KEY).mintStorageGrantEnv(
      makePlanRun(),
      "destroy",
      "run_audit_5",
    );
    expect(env).toBeUndefined();
  });

  test("prefers the official producer over a same-workspace impostor", async () => {
    const state = fullState({
      installations: [
        {
          id: PRODUCER_ID,
          workspaceId: WORKSPACE_ID,
          installConfigId: OFFICIAL_INSTALL_CONFIG_ID,
        },
        { id: IMPOSTOR_ID, workspaceId: WORKSPACE_ID },
        { id: CONSUMER_ID, workspaceId: WORKSPACE_ID },
      ],
      outputs: {
        [PRODUCER_ID]: PRODUCER_OUTPUTS,
        [IMPOSTOR_ID]: IMPOSTOR_OUTPUTS,
        [CONSUMER_ID]: CONSUMER_OUTPUTS,
      },
    });
    const env = await brokerWith(
      state,
      keyedResolver({ [PRODUCER_ID]: SIGNING_KEY, [IMPOSTOR_ID]: IMPOSTOR_KEY }),
    ).mintStorageGrantEnv(makePlanRun(), "apply", "run_audit_pin");

    expect(env).toBeDefined();
    // Endpoint + signing key come from the OFFICIAL producer, never the impostor.
    expect(env!.TF_VAR_takos_object_api_url).toBe("https://storage.example/o");
    const token = env!.TF_VAR_takos_object_access_token!;
    const asOfficial = await verifyStorageAccessToken(
      SIGNING_KEY,
      token,
      Math.floor(NOW_MS / 1000) + 60,
    );
    expect(asOfficial.ok).toBe(true);
    const asImpostor = await verifyStorageAccessToken(
      IMPOSTOR_KEY,
      token,
      Math.floor(NOW_MS / 1000) + 60,
    );
    expect(asImpostor.ok).toBe(false);
    expect(
      state.mintEvents[0]!.providerCredentialEvidence![0]!.providerEnvId,
    ).toBe(PRODUCER_ID);
  });

  test("fails closed when multiple non-official producers are ambiguous", async () => {
    const state = fullState({
      installations: [
        { id: PRODUCER_ID, workspaceId: WORKSPACE_ID },
        { id: IMPOSTOR_ID, workspaceId: WORKSPACE_ID },
        { id: CONSUMER_ID, workspaceId: WORKSPACE_ID },
      ],
      outputs: {
        [PRODUCER_ID]: PRODUCER_OUTPUTS,
        [IMPOSTOR_ID]: IMPOSTOR_OUTPUTS,
        [CONSUMER_ID]: CONSUMER_OUTPUTS,
      },
    });
    const env = await brokerWith(
      state,
      keyedResolver({ [PRODUCER_ID]: SIGNING_KEY, [IMPOSTOR_ID]: IMPOSTOR_KEY }),
    ).mintStorageGrantEnv(makePlanRun(), "apply", "run_audit_ambig");
    expect(env).toBeUndefined();
    expect(state.mintEvents).toHaveLength(0);
  });

  test("fails open (no throw) when the signing-key resolver errors", async () => {
    const state = fullState();
    const throwing: SensitiveOutputResolver = {
      resolve: async () => {
        throw new Error("decrypt boom");
      },
    };
    const env = await brokerWith(state, throwing).mintStorageGrantEnv(
      makePlanRun(),
      "apply",
      "run_audit_throw",
    );
    expect(env).toBeUndefined();
  });
});
