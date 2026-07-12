import { describe, expect, test } from "bun:test";

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { CredentialMintEvent } from "takosumi-contract/security";
import { ServiceGrantBroker } from "../../../../core/domains/deploy-control/service_grant_broker.ts";
import type { OpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { SensitiveOutputResolver } from "../../../../core/domains/output-shares/mod.ts";
import { verifyServiceScopedCredential } from "../../../../core/shared/service_scoped_credentials.ts";

const WORKSPACE_ID = "space_00112233aabbccdd";
const PRODUCER_ID = "inst_aaaaaaaaaaaaaaaa";
const CONSUMER_ID = "inst_bbbbbbbbbbbbbbbb";
const SIGNING_KEY = "producer-signing-key-integration-01";
const NOW_MS = 1_700_000_000_000;

const PRODUCER_OUTPUTS = {
  service_exports: [
    {
      name: "storage.object",
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
            publication: "storage.object",
            request: { scopes: ["files:read", "files:write"] },
            inject: {
              env: {
                url: "OBJECT_STORAGE_API_URL",
                token: "OBJECT_STORAGE_ACCESS_TOKEN",
              },
            },
          },
        ],
      },
    },
  },
};

const IMPOSTOR_ID = "inst_cccccccccccccccc";
const IMPOSTOR_KEY = "attacker-controlled-signing-key-99";
const IMPOSTOR_OUTPUTS = {
  service_exports: [
    {
      name: "storage.object",
      capabilities: ["storage.object", "protocol.http.api"],
      endpoints: [
        {
          name: "default",
          protocol: "https",
          url: "https://attacker.example/o",
        },
      ],
      visibility: "space",
    },
  ],
};

interface FakeStoreState {
  readonly installations: readonly {
    id: string;
    workspaceId: string;
    installConfigId?: string;
    status?:
      "pending" | "active" | "stale" | "error" | "disabled" | "destroyed";
  }[];
  readonly outputs: Record<string, Record<string, unknown> | undefined>;
  readonly mintEvents: CredentialMintEvent[];
}

function makeStore(state: FakeStoreState): OpenTofuDeploymentStore {
  return {
    listInstallations: async (spaceId?: string) =>
      state.installations
        .filter((i) => spaceId === undefined || i.workspaceId === spaceId)
        .map((installation) => ({
          ...installation,
          status: installation.status ?? "active",
        })),
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
        !input.outputName.endsWith("_signing_key") ||
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

function gitConsumerState(scopes: readonly string[]): FakeStoreState {
  const gitProducerId = "inst_dddddddddddddddd";
  return {
    installations: [
      { id: gitProducerId, workspaceId: WORKSPACE_ID },
      { id: CONSUMER_ID, workspaceId: WORKSPACE_ID },
    ],
    outputs: {
      [gitProducerId]: {
        service_exports: [{
          name: "source.git.smart_http",
          capabilities: ["source.git.smart_http", "protocol.http.api"],
          endpoints: [{
            name: "default",
            protocol: "https",
            url: "https://git.example/git",
          }],
          visibility: "space",
        }],
      },
      [CONSUMER_ID]: {
        app_deployment: {
          name: "consumer",
          compute: {
            web: {
              kind: "worker",
              consume: [{
                publication: "source.git.smart_http",
                request: { scopes: [...scopes] },
              }],
            },
          },
        },
      },
    },
    mintEvents: [],
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
      if (!input.outputName.endsWith("_signing_key") || key === undefined) {
        return undefined;
      }
      return { value: key, sensitive: true };
    },
  };
}

function brokerWith(state: FakeStoreState, resolver: SensitiveOutputResolver) {
  return new ServiceGrantBroker({
    store: makeStore(state),
    newId: (prefix) => `${prefix}_test`,
    now: () => NOW_MS,
    sensitiveOutputResolver: resolver,
  });
}

describe("ServiceGrantBroker", () => {
  test("mints a scoped token + TF_VAR env and records evidence", async () => {
    const state = fullState();
    const env = await broker(state, SIGNING_KEY).mintServiceGrantEnv(
      makePlanRun(),
      "plan",
      "run_audit_1",
    );
    expect(env).toBeDefined();
    expect(env!.TF_VAR_object_storage_api_url).toBe(
      "https://storage.example/o",
    );
    expect(env!.TF_VAR_object_storage_key_prefix).toBe(
      `${WORKSPACE_ID}/${CONSUMER_ID}/`,
    );
    expect(env!.TF_VAR_object_storage_workspace_id).toBe(WORKSPACE_ID);

    const token = env!.TF_VAR_object_storage_access_token!;
    const verified = await verifyServiceScopedCredential(
      SIGNING_KEY,
      token,
      "storage.object",
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.sub).toBe(CONSUMER_ID);
      expect(verified.payload.pfx).toBe(`${WORKSPACE_ID}/${CONSUMER_ID}/`);
      expect(verified.payload.cap).toContain("w");
    }

    expect(state.mintEvents).toHaveLength(1);
    const evidence = state.mintEvents[0]!.providerCredentialEvidence![0]!;
    expect(evidence.issuer).toBe("takosumi_service_scoped_credential");
    expect(evidence.temporary).toBe(false);
    expect(evidence.ttlEnforced).toBe(false);
    expect(evidence.secretValueStored).toBe(false);
    expect(state.mintEvents[0]!.capsuleId).toBe(CONSUMER_ID);
  });

  test("skips when the consumer declares no scoped service consume", async () => {
    const state = fullState({
      outputs: { [PRODUCER_ID]: PRODUCER_OUTPUTS, [CONSUMER_ID]: {} },
    });
    const env = await broker(state, SIGNING_KEY).mintServiceGrantEnv(
      makePlanRun(),
      "plan",
      "run_audit_2",
    );
    expect(env).toBeUndefined();
    expect(state.mintEvents).toHaveLength(0);
  });

  test("fails closed when no producer is installed in the workspace", async () => {
    const state = fullState({
      installations: [{ id: CONSUMER_ID, workspaceId: WORKSPACE_ID }],
      outputs: { [CONSUMER_ID]: CONSUMER_OUTPUTS },
    });
    await expect(
      broker(state, SIGNING_KEY).mintServiceGrantEnv(
        makePlanRun(),
        "plan",
        "run_audit_3",
      ),
    ).rejects.toThrow(/no unique producer/);
  });

  test("fails closed when the signing key can't be resolved", async () => {
    const state = fullState();
    await expect(
      broker(state, undefined).mintServiceGrantEnv(
        makePlanRun(),
        "plan",
        "run_audit_4",
      ),
    ).rejects.toThrow(/signing authority/);
  });

  test("does not mint during destroy phase or destroy plan", async () => {
    const state = fullState();
    const destroyPhaseEnv = await broker(
      state,
      SIGNING_KEY,
    ).mintServiceGrantEnv(
      makePlanRun(),
      "destroy",
      "run_audit_5",
    );
    const destroyPlanEnv = await broker(
      state,
      SIGNING_KEY,
    ).mintServiceGrantEnv(
      { ...makePlanRun(), operation: "destroy" },
      "plan",
      "run_audit_6",
    );
    expect(destroyPhaseEnv).toBeUndefined();
    expect(destroyPlanEnv).toBeUndefined();
  });

  test("fails closed instead of trusting nonselectable store ids when producers are ambiguous", async () => {
    const state = fullState({
      installations: [
        {
          id: PRODUCER_ID,
          workspaceId: WORKSPACE_ID,
          installConfigId: "cfg-store-takos-storage",
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
    const env = brokerWith(
      state,
      keyedResolver({
        [PRODUCER_ID]: SIGNING_KEY,
        [IMPOSTOR_ID]: IMPOSTOR_KEY,
      }),
    ).mintServiceGrantEnv(makePlanRun(), "plan", "run_audit_pin");

    await expect(env).rejects.toThrow(/no unique producer/);
    expect(state.mintEvents).toHaveLength(0);
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
    const env = brokerWith(
      state,
      keyedResolver({
        [PRODUCER_ID]: SIGNING_KEY,
        [IMPOSTOR_ID]: IMPOSTOR_KEY,
      }),
    ).mintServiceGrantEnv(makePlanRun(), "plan", "run_audit_ambig");
    await expect(env).rejects.toThrow(/no unique producer/);
    expect(state.mintEvents).toHaveLength(0);
  });

  test("ignores destroyed producers even when their outputs are retained", async () => {
    const state = fullState({
      installations: [
        {
          id: PRODUCER_ID,
          workspaceId: WORKSPACE_ID,
          status: "active",
        },
        {
          id: IMPOSTOR_ID,
          workspaceId: WORKSPACE_ID,
          status: "destroyed",
        },
        { id: CONSUMER_ID, workspaceId: WORKSPACE_ID, status: "pending" },
      ],
      outputs: {
        [PRODUCER_ID]: PRODUCER_OUTPUTS,
        [IMPOSTOR_ID]: IMPOSTOR_OUTPUTS,
        [CONSUMER_ID]: CONSUMER_OUTPUTS,
      },
    });
    const env = await brokerWith(
      state,
      keyedResolver({
        [PRODUCER_ID]: SIGNING_KEY,
        [IMPOSTOR_ID]: IMPOSTOR_KEY,
      }),
    ).mintServiceGrantEnv(makePlanRun(), "plan", "run_audit_destroyed");

    const verified = await verifyServiceScopedCredential(
      SIGNING_KEY,
      env!.TF_VAR_object_storage_access_token!,
      "storage.object",
    );
    expect(verified.ok).toBe(true);
    expect(state.mintEvents).toHaveLength(1);
    expect(state.mintEvents[0]!.providerEnvId).toBe(PRODUCER_ID);
  });

  test("fails closed when the signing-key resolver errors", async () => {
    const state = fullState();
    const throwing: SensitiveOutputResolver = {
      resolve: async () => {
        throw new Error("decrypt boom");
      },
    };
    await expect(
      brokerWith(state, throwing).mintServiceGrantEnv(
        makePlanRun(),
        "plan",
        "run_audit_throw",
      ),
    ).rejects.toThrow("decrypt boom");
  });

  test("mints a read-only clone grant for a source.git.smart_http consumer", async () => {
    const GIT_PRODUCER_ID = "inst_dddddddddddddddd";
    const state: FakeStoreState = {
      installations: [
        {
          id: GIT_PRODUCER_ID,
          workspaceId: WORKSPACE_ID,
        },
        { id: CONSUMER_ID, workspaceId: WORKSPACE_ID },
      ],
      outputs: {
        [GIT_PRODUCER_ID]: {
          service_exports: [
            {
              name: "source.git.smart_http",
              capabilities: ["source.git.smart_http", "protocol.http.api"],
              endpoints: [
                {
                  name: "default",
                  protocol: "https",
                  url: "https://git.example/git",
                },
              ],
              visibility: "space",
            },
          ],
        },
        [CONSUMER_ID]: {
          app_deployment: {
            name: "consumer",
            compute: {
              web: {
                kind: "worker",
                consume: [
                  {
                    publication: "source.git.smart_http",
                    request: { scopes: [] },
                  },
                ],
              },
            },
          },
        },
      },
      mintEvents: [],
    };
    const env = await broker(state, SIGNING_KEY).mintServiceGrantEnv(
      makePlanRun(),
      "plan",
      "run_git",
    );
    expect(env).toBeDefined();
    expect(env!.TF_VAR_git_http_url).toBe("https://git.example/git");
    expect(env!.TF_VAR_git_repo_prefix).toBe(WORKSPACE_ID);

    const payload = decodeTokenPayload(env!.TF_VAR_git_access_token!);
    expect(payload.aud).toBe("source.git.smart_http");
    expect(payload.pfx).toBe(WORKSPACE_ID);
    expect(payload.cap).toEqual(["r"]);
    expect(state.mintEvents[0]!.providerCredentialEvidence![0]!.provider).toBe(
      "source.git.smart_http",
    );
  });

  test("mints read/write Git verbs only for repos:write", async () => {
    const state = gitConsumerState(["repos:write"]);
    const env = await broker(state, SIGNING_KEY).mintServiceGrantEnv(
      makePlanRun(),
      "plan",
      "run_git_write",
    );

    expect(env).toBeDefined();
    expect(env!.TF_VAR_git_repo_prefix).toBe(WORKSPACE_ID);
    const payload = decodeTokenPayload(env!.TF_VAR_git_access_token!);
    expect(payload.pfx).toBe(WORKSPACE_ID);
    expect(payload.cap).toEqual(["r", "w"]);
  });

  test("maps repos:read to a read-only Workspace Git grant", async () => {
    const state = gitConsumerState(["repos:read"]);
    const env = await broker(state, SIGNING_KEY).mintServiceGrantEnv(
      makePlanRun(),
      "plan",
      "run_git_read",
    );

    expect(env).toBeDefined();
    const payload = decodeTokenPayload(env!.TF_VAR_git_access_token!);
    expect(payload.pfx).toBe(WORKSPACE_ID);
    expect(payload.cap).toEqual(["r"]);
  });
});

function decodeTokenPayload(token: string): Record<string, unknown> {
  const body = token.slice("tksvc_".length).split(".")[0]!;
  const normalized = body.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}
