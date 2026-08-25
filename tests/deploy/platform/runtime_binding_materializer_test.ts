import { describe, expect, test } from "bun:test";
import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  createTakosumiRuntimeBindingMaterializer,
  type RuntimeBindingControlLedger,
} from "../../../deploy/platform/runtime_binding_materializer.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function installConfig(): InstallConfig {
  return {
    id: "icfg_yurucommu",
    workspaceId: "ws_1",
    name: "Yurucommu",
    variableMapping: {},
    installExperience: { projections: [{ kind: "service_name", variable: "project_name" }] },
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v1",
      generatedSecrets: [
        {
          binding: "ENCRYPTION_KEY",
          bytes: 32,
          encoding: "hex",
        },
      ],
      oidcClient: {
        issuerBinding: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
        clientIdBinding: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        ownerSubjectBinding: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
        redirectUriBinding: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
        callbackPath: "/api/auth/callback/takos",
        scopes: ["openid", "profile", "email"],
      },
    },
    outputAllowlist: {},
    policy: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as InstallConfig;
}

function control(
  context = {
    workspaceId: "ws_1",
    capsuleId: "cap_1",
    runId: "run_1",
    installingPrincipalId: "tsub_owner",
    phase: "apply" as const,
    lifecycleIntent: "provision" as const,
  },
): RuntimeBindingControlLedger {
  return {
    async resolveContext() {
      return { ok: true, context };
    },
    async getCapsule() {
      return {
        id: "cap_1",
        workspaceId: "ws_1",
        name: "Yurucommu",
        installConfigId: "icfg_yurucommu",
      };
    },
    async getInstallConfig() {
      return installConfig();
    },
    async putInstallConfig(config) {
      return config;
    },
  };
}

describe("Takosumi runtime binding materializer", () => {
  test("materializes only the DB-owned exact binding set and registers a live OIDC client", async () => {
    const saved: unknown[] = [];
    const materializer = createTakosumiRuntimeBindingMaterializer({
      control: control(),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient(record) {
          saved.push(record);
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      derivationKey: "runtime-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    const request = {
      contract: "takosumi.runtime-bindings/v1",
      workspaceId: "ws_1",
      capsuleId: "cap_1",
      runId: "run_1",
      phase: "apply",
    } as const;
    const bindings = [
      "ENCRYPTION_KEY",
      "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
    ] as const;
    const first = await materializer.materializeRuntimeBindings({
      request,
      resourceName: "takoform_worker_version.yurucommu",
      scriptName: "yurucommu",
      publicOrigin: "https://yurucommu.example.test",
      bindings,
    });
    const second = await materializer.materializeRuntimeBindings({
      request,
      resourceName: "takoform_worker_version.yurucommu",
      scriptName: "yurucommu",
      publicOrigin: "https://yurucommu.example.test",
      bindings,
    });

    expect(Object.keys(first.values).sort()).toEqual([...bindings].sort());
    expect(first.values.ENCRYPTION_KEY).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.values).toEqual(first.values);
    expect(first.values.TAKOSUMI_ACCOUNTS_ISSUER_URL).toBe(
      "https://app.takosumi.com",
    );
    expect(first.values.TAKOSUMI_ACCOUNTS_REDIRECT_URI).toBe(
      "https://yurucommu.example.test/api/auth/callback/takos",
    );
    expect(first.values.TAKOSUMI_ACCOUNTS_CLIENT_ID).toMatch(
      /^tko_[A-Za-z0-9_-]{43}$/u,
    );
    expect(first.values.TAKOSUMI_ACCOUNTS_OWNER_SUB).toMatch(
      /^tsub_[A-Za-z0-9_-]{32}$/u,
    );
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)).toMatchObject({
      clientId: first.values.TAKOSUMI_ACCOUNTS_CLIENT_ID,
      capsuleId: "cap_1",
      namespacePath: "identity.oidc",
      issuerUrl: "https://app.takosumi.com",
      redirectUris: [
        "https://yurucommu.example.test/api/auth/callback/takos",
      ],
      allowedScopes: ["openid", "profile", "email"],
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: "none",
    });
  });

  test("refuses drift or undeclared bindings before Accounts mutation", async () => {
    let writes = 0;
    const materializer = createTakosumiRuntimeBindingMaterializer({
      control: control(),
      accounts: {
        async findOidcClient() {
          return undefined;
        },
        async findOidcClientForCapsule() {
          return undefined;
        },
        async saveOidcClient() {
          writes += 1;
        },
      },
      issuer: "https://app.takosumi.com",
      pairwiseSubjectSecret: "pairwise-secret-with-at-least-32-bytes",
      derivationKey: "runtime-secret-with-at-least-32-bytes",
      clock: () => NOW,
    });

    await expect(
      materializer.materializeRuntimeBindings({
        request: {
          contract: "takosumi.runtime-bindings/v1",
          workspaceId: "ws_other",
          capsuleId: "cap_1",
          runId: "run_1",
          phase: "apply",
        },
        resourceName: "worker",
        scriptName: "yurucommu",
        publicOrigin: "https://yurucommu.example.test",
        bindings: ["ENCRYPTION_KEY"],
      }),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  });
});
