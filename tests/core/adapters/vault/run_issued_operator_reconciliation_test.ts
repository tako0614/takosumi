import { describe, expect, test } from "bun:test";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  reconcileRunIssuedOperatorConnection,
  resolveTargetConnection,
  RunIssuedOperatorConnectionReconcileError,
  type ReconcileRunIssuedOperatorConnectionInput,
} from "../../../../core/adapters/vault/run_issued_operator_reconciliation.ts";
import { credentialRecipeDriverKey } from "@takosumi/providers/types";

const PROVIDER = "registry.example/operator/extension";
const RECIPE_ID = "operator-extension-run";
const AUTH_MODE = "run";
const DRIVER = "operator-extension.issue-run.v1";
const FIXED_ID = "conn_operatorExtension01";
const NOW = "2026-08-09T00:00:00.000Z";

describe("fixed-id run-issued operator Connection reconciliation", () => {
  test("creates an exact verified row without a blob and is idempotent", async () => {
    const { store, input, verifyCalls } = fixture();
    const created = await reconcileRunIssuedOperatorConnection(input);
    expect(created.status).toBe("created");
    expect(created.connection).toMatchObject({
      id: FIXED_ID,
      provider: PROVIDER,
      providerSource: PROVIDER,
      scope: "operator",
      status: "verified",
      materialization: "run-issued",
      runCredentialSettings: { requiredAvailableMinor: 2300 },
      envNames: ["EXTENSION_ENDPOINT", "EXTENSION_RUN_TOKEN"],
      credentialRecipe: {
        id: RECIPE_ID,
        authMode: AUTH_MODE,
        preRunAction: DRIVER,
        runIssuance: {
          context: "capsule-run.v1",
          operatorConnection: "workspace-bindable",
          storedMaterial: "none",
          audience: "extension.example.v1",
          scopes: ["extension:invoke"],
        },
      },
    });
    expect(await store.getSecretBlob(FIXED_ID)).toBeUndefined();

    const unchanged = await reconcileRunIssuedOperatorConnection(input);
    expect(unchanged).toEqual({ status: "unchanged", connection: created.connection });
    expect(verifyCalls.count).toBe(1);
  });

  test("accepts an existing exact verified row but rejects semantic drift", async () => {
    const base = fixture();
    const expected = resolveTargetConnection(
      base.input.descriptor,
      base.input.credentialRecipeResolver,
      base.input.credentialDrivers,
      NOW,
    );
    await base.store.putConnection(expected);
    await expect(reconcileRunIssuedOperatorConnection(base.input)).resolves.toMatchObject({
      status: "unchanged",
    });

    for (const drift of [
      { ...expected, status: "pending" as const },
      { ...expected, provider: "registry.example/other/provider", providerSource: "registry.example/other/provider" },
      { ...expected, workspaceId: "workspace_1", scope: "workspace" as const },
    ]) {
      const current = fixture();
      await current.store.putConnection(drift);
      await expect(reconcileRunIssuedOperatorConnection(current.input)).rejects.toMatchObject({
        code: "drift",
      });
    }
  });

  test("rejects stored material on an otherwise exact row", async () => {
    const base = fixture();
    const expected = resolveTargetConnection(
      base.input.descriptor,
      base.input.credentialRecipeResolver,
      base.input.credentialDrivers,
      NOW,
    );
    await base.store.putConnection(expected);
    await base.store.putSecretBlob({
      id: `secret_${FIXED_ID}`,
      connectionId: FIXED_ID,
      kind: "unexpected",
      ciphertext: "AA==",
      encryptedDek: "AA==",
      nonce: "AA==",
      aad: "{}",
      keyVersion: 1,
      createdAt: NOW,
    });
    await expect(reconcileRunIssuedOperatorConnection(base.input)).rejects.toMatchObject({
      code: "stored_material",
    });
  });

  test("rereads and accepts an exact same-id race winner, but rejects a mismatch", async () => {
    const base = fixture();
    const target = resolveTargetConnection(
      base.input.descriptor,
      base.input.credentialRecipeResolver,
      base.input.credentialDrivers,
      NOW,
    );
    const raceStore = {
      getConnection: base.store.getConnection.bind(base.store),
      getSecretBlob: base.store.getSecretBlob.bind(base.store),
      createConnectionIfAbsent: async () => {
        await base.store.putConnection(target);
        return false;
      },
    };
    await expect(
      reconcileRunIssuedOperatorConnection({ ...base.input, store: raceStore }),
    ).resolves.toMatchObject({ status: "unchanged", connection: target });

    const mismatch = fixture();
    const mismatchStore = {
      getConnection: mismatch.store.getConnection.bind(mismatch.store),
      getSecretBlob: mismatch.store.getSecretBlob.bind(mismatch.store),
      createConnectionIfAbsent: async () => {
        await mismatch.store.putConnection({
          ...target,
          provider: "registry.example/other/provider",
          providerSource: "registry.example/other/provider",
        });
        return false;
      },
    };
    await expect(
      reconcileRunIssuedOperatorConnection({ ...mismatch.input, store: mismatchStore }),
    ).rejects.toMatchObject({ code: "drift" });
  });

  test("prevalidates descriptors and sanitizes driver verification errors", async () => {
    const invalid = fixture();
    await expect(
      reconcileRunIssuedOperatorConnection({
        ...invalid.input,
        descriptor: { ...invalid.input.descriptor, unknown: true } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_descriptor" });

    const secret = "raw-provider-secret";
    const failing = fixture({
      verify: async () => {
        throw new Error(`provider rejected ${secret}`);
      },
    });
    const error = await reconcileRunIssuedOperatorConnection(failing.input).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RunIssuedOperatorConnectionReconcileError);
    expect((error as RunIssuedOperatorConnectionReconcileError).code).toBe(
      "verification_failed",
    );
    expect((error as Error).message).toBe(
      "operator Provider Connection verification failed",
    );
    expect(String(error)).not.toContain(secret);
    expect(await failing.store.getConnection(FIXED_ID)).toBeUndefined();
  });
});

function fixture(options: {
  readonly verify?: (input: Parameters<NonNullable<
    ReconcileRunIssuedOperatorConnectionInput["credentialDrivers"][string]["verify"]
  >>[0]) => Promise<{ readonly ok: boolean }>;
} = {}): {
  readonly store: InMemoryOpenTofuControlStore;
  readonly input: ReconcileRunIssuedOperatorConnectionInput;
  readonly verifyCalls: { count: number };
} {
  const store = new InMemoryOpenTofuControlStore();
  const verifyCalls = { count: 0 };
  const recipe = {
    id: RECIPE_ID,
    displayName: "Operator extension",
    terraformSource: [PROVIDER],
    envNames: ["EXTENSION_RUN_TOKEN", "EXTENSION_ENDPOINT"],
    authModes: {
      [AUTH_MODE]: {
        env: {},
        preRun: { type: DRIVER },
        runIssuance: {
          context: "capsule-run.v1",
          operatorConnection: "workspace-bindable",
          storedMaterial: "none",
          audience: "extension.example.v1",
          scopes: ["extension:invoke"],
        },
      },
    },
  } as const;
  const verify = options.verify
    ? async (input: Parameters<NonNullable<typeof options.verify>>[0]) =>
        await options.verify!(input)
    : async () => {
        verifyCalls.count += 1;
        return { ok: true };
      };
  return {
    store,
    verifyCalls,
    input: {
      store,
      descriptor: {
        id: FIXED_ID,
        providerSource: PROVIDER,
        displayName: "Operator extension",
        runCredentialSettings: { requiredAvailableMinor: 2300 },
        credentialRecipe: { id: RECIPE_ID, authMode: AUTH_MODE },
      },
      credentialRecipeResolver: (id) => (id === RECIPE_ID ? recipe : undefined),
      credentialDrivers: {
        [credentialRecipeDriverKey({ id: RECIPE_ID, authMode: AUTH_MODE })]: {
          evidenceIssuer: DRIVER,
          verify,
          mint: async ({ connection }) => ({
            env: {
              EXTENSION_ENDPOINT: "https://extension.example",
              EXTENSION_RUN_TOKEN: "issued",
            },
            evidence: {
              connectionId: connection.id,
              provider: connection.provider,
              temporary: true,
              ttlEnforced: true,
              secretValueStored: false,
            },
          }),
        },
      },
      now: () => new Date(NOW),
    },
  };
}
