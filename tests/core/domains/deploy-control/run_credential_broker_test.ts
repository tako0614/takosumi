import { test, expect } from "bun:test";
import type { PlanRun } from "../../../../contract/internal-deploy-control-api.ts";
import type { ProviderConnection } from "../../../../contract/connections.ts";
import { RunCredentialBroker } from "../../../../core/domains/deploy-control/run_credential_broker.ts";
import type { ResolvedCapsuleProviderBinding } from "../../../../core/domains/connections/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  PhaseMintBundle,
  type CapsuleProviderBindingMintEntry,
  type ConnectionVault,
} from "../../../../core/adapters/vault/mod.ts";

const NOW = "2026-06-06T00:00:00.000Z";

function connection(
  id: string,
  providerSource: string,
  envName: string,
): ProviderConnection {
  return {
    id,
    workspaceId: "workspace_1",
    provider: providerSource,
    providerSource,
    scope: "workspace",
    status: "active",
    materialization: "static",
    envNames: [envName],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function resolvedBinding(
  providerSource: string,
  id: string,
  envName: string,
): ResolvedCapsuleProviderBinding {
  return {
    provider: providerSource,
    connection: connection(id, providerSource, envName),
    materialization: "static",
  };
}

const CLOUDFLARE = resolvedBinding(
  "registry.opentofu.org/cloudflare/cloudflare",
  "conn_cloudflare",
  "CLOUDFLARE_API_TOKEN",
);
const AWS = resolvedBinding(
  "registry.opentofu.org/hashicorp/aws",
  "conn_aws",
  "AWS_SECRET_ACCESS_KEY",
);

function planRun(requiredProviders: readonly string[]): PlanRun {
  return {
    id: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "cap_1",
    capsuleContext: {
      workspaceId: "workspace_1",
      capsuleId: "cap_1",
      environment: "production",
    },
    source: { kind: "git", url: "https://example.test/repo.git", ref: "main" },
    sourceDigest: `sha256:${"1".repeat(64)}`,
    operation: "plan",
    runnerProfileId: "opentofu-default",
    variablesDigest: `sha256:${"2".repeat(64)}`,
    requiredProviders,
    status: "queued",
    policy: { decision: "pass", reasons: [] },
    policyDecisionDigest: `sha256:${"3".repeat(64)}`,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as PlanRun;
}

function brokerFor(resolved: readonly ResolvedCapsuleProviderBinding[]): {
  readonly broker: RunCredentialBroker;
  readonly mintedEntries: CapsuleProviderBindingMintEntry[][];
  readonly store: InMemoryOpenTofuControlStore;
} {
  const mintedEntries: CapsuleProviderBindingMintEntry[][] = [];
  const vault = {
    mintForCapsuleProviderBindings: (
      _workspaceId: string,
      entries: readonly CapsuleProviderBindingMintEntry[],
    ) => {
      mintedEntries.push([...entries]);
      const env: Record<string, string> = {};
      for (const entry of entries) {
        const match = resolved.find(
          (candidate) => candidate.connection.id === entry.connectionId,
        );
        for (const name of match?.connection.envNames ?? []) {
          env[name] = `minted:${entry.connectionId}`;
        }
      }
      return Promise.resolve(
        new PhaseMintBundle(
          { env },
          [],
          entries.map((entry) => ({
            provider: entry.provider,
            connectionId: entry.connectionId,
            temporary: true,
            ttlEnforced: true,
          })),
        ),
      );
    },
  } as unknown as ConnectionVault;
  let counter = 0;
  const store = new InMemoryOpenTofuControlStore();
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => resolved,
    policyForPlanRun: async () => undefined,
  });
  return { broker, mintedEntries, store };
}

test("run credential mint is narrowed to the plan's declared providers", async () => {
  // A Capsule keeps one Provider Binding set covering every provider it has
  // ever used. Minting the whole set for a run that declared only one provider
  // hands the runner live credentials it was never reviewed to receive.
  const { broker, mintedEntries, store } = brokerFor([CLOUDFLARE, AWS]);
  const credentials = await broker.mintRunCredentials(
    planRun(["registry.opentofu.org/cloudflare/cloudflare"]),
    "plan",
    "run_1",
  );
  expect(mintedEntries).toEqual([
    [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        connectionId: "conn_cloudflare",
      },
    ],
  ]);
  expect(Object.keys(credentials?.env ?? {})).toEqual(["CLOUDFLARE_API_TOKEN"]);
  // The manifest is the runner's credential allowlist AND its
  // required-env assertion, so it must describe exactly what was minted.
  expect(
    credentials?.manifest.bindings.map((binding) => binding.providerSource),
  ).toEqual(["registry.opentofu.org/cloudflare/cloudflare"]);
  expect(await store.listCredentialMintEventsForRun("run_1")).toMatchObject([{
    connectionId: "conn_cloudflare",
    providerCredentialEvidence: [{
      connectionId: "conn_cloudflare",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      temporary: true,
      ttlEnforced: true,
    }],
  }]);
});

test("a credential-free provider set mints nothing at all", async () => {
  const { broker, mintedEntries } = brokerFor([CLOUDFLARE, AWS]);
  const credentials = await broker.mintRunCredentials(
    planRun(["registry.opentofu.org/hashicorp/http"]),
    "plan",
    "run_1",
  );
  expect(mintedEntries).toEqual([]);
  expect(credentials?.env).toEqual({});
  expect(credentials?.manifest.bindings).toEqual([]);
});

test("broker rejects secret-bearing evidence before mint-event persistence", async () => {
  const rawToken = "raw-provider-token-that-must-never-be-audited";
  const store = new InMemoryOpenTofuControlStore();
  const vault = {
    mintForCapsuleProviderBindings: () =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: rawToken } },
          [],
          [{
            provider: CLOUDFLARE.provider,
            connectionId: CLOUDFLARE.connection.id,
            temporary: true,
            ttlEnforced: true,
            issuer: `driver:${rawToken}`,
            secretValueStored: false,
          }],
        ),
      ),
  } as unknown as ConnectionVault;
  const broker = new RunCredentialBroker({
    store,
    newId: (prefix) => `${prefix}_1`,
    now: () => Date.parse(NOW),
    vault,
    resolveRunProviderBindings: async () => [CLOUDFLARE],
    policyForPlanRun: async () => undefined,
  });

  const error = await broker
    .mintRunCredentials(
      planRun([CLOUDFLARE.provider]),
      "plan",
      "run_secret_evidence",
    )
    .then(
      () => undefined,
      (failure: unknown) => failure,
    );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(rawToken);
  expect(await store.listCredentialMintEventsForRun("run_secret_evidence"))
    .toEqual([]);
});
