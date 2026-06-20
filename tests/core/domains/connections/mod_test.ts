/** Provider Env binding resolution. */
import { expect, test } from "bun:test";

import type { Connection } from "@takosumi/internal/deploy-control-api";
import type { ProviderEnv } from "takosumi-contract/provider-envs";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { ConnectionsService, mintableConnectionIds } from "../../../../core/domains/connections/mod.ts";

const NOW = "2026-06-06T00:00:00.000Z";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";

function connection(input: {
  readonly id: string;
  readonly spaceId?: string;
  readonly provider?: string;
  readonly status?: Connection["status"];
}): Connection {
  return {
    id: input.id,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    provider: input.provider ?? "cloudflare",
    kind: "cloudflare_api_token",
    scope: input.spaceId ? "space" : "operator",
    authMethod: "static_secret",
    status: input.status ?? "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function providerEnv(input: {
  readonly id: string;
  readonly spaceId?: string;
  readonly providerSource?: string;
  readonly materialization: ProviderEnv["materialization"];
  readonly status?: ProviderEnv["status"];
  readonly secretRef?: string;
}): ProviderEnv {
  const secretRef = input.secretRef ?? input.id;
  return {
    id: input.id,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    providerSource: input.providerSource ?? CLOUDFLARE,
    displayName: input.id,
    materialization: input.materialization,
    status: input.status ?? "ready",
    requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    ...(secretRef ? { secretRef } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function setup() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const model = await seedInstallationModel(store);
  const service = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_1`,
    now: () => NOW,
  });
  return { store, model, service };
}

test("global Provider Envs are rejected in OSS", async () => {
  const { store } = await setup();
  expect(() =>
    store.putProviderEnv(
      providerEnv({
        id: "penv_cf_global",
        materialization: "secret",
      }),
    ),
  ).toThrow(/global provider resolver records are not supported/);
});

test("global non-gateway Provider Envs are rejected at creation", async () => {
  const { service } = await setup();
  await expect(
    service.putProviderEnv("penv_global_secret", {
      providerSource: CLOUDFLARE,
      displayName: "Global secret",
      materialization: "secret",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
      secretRef: "conn_operator_secret",
    }),
  ).rejects.toThrow(/provider resolver records must be scoped to a Space/);
});

test("Provider Env creation validates write-only backing Connection refs", async () => {
  const { store, model, service } = await setup();

  await expect(
    service.putProviderEnv("penv_missing", {
      spaceId: model.space.id,
      providerSource: CLOUDFLARE,
      displayName: "Missing backing connection",
      materialization: "secret",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
      secretRef: "conn_missing",
    }),
  ).rejects.toThrow(/backing Connection conn_missing does not exist/);

  await store.putConnection(
    connection({ id: "conn_other", spaceId: "space_other" }),
  );
  await expect(
    service.putProviderEnv("penv_other", {
      spaceId: model.space.id,
      providerSource: CLOUDFLARE,
      displayName: "Wrong Space backing connection",
      materialization: "secret",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
      secretRef: "conn_other",
    }),
  ).rejects.toThrow(/belongs to another Space/);

  await store.putConnection(
    connection({
      id: "conn_pending",
      spaceId: model.space.id,
      status: "pending",
    }),
  );
  const pendingEnv = await service.putProviderEnv("penv_pending_backing", {
    spaceId: model.space.id,
    providerSource: CLOUDFLARE,
    displayName: "Pending backing connection",
    materialization: "secret",
    requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    secretRef: "conn_pending",
  });
  expect(pendingEnv.status).toBe("needs_setup");

  await expect(
    service.putProviderEnv("penv_pending_ready", {
      spaceId: model.space.id,
      providerSource: CLOUDFLARE,
      displayName: "Pending backing connection forced ready",
      materialization: "secret",
      status: "ready",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
      secretRef: "conn_pending",
    }),
  ).rejects.toThrow(/status pending is not verified/);

  await expect(
    service.putProviderEnv("penv_gateway_secret", {
      providerSource: CLOUDFLARE,
      displayName: "Cloud-only gateway materialization",
      materialization: "gateway" as never,
      secretRef: "conn_pending",
    }),
  ).rejects.toThrow(/materialization must be oauth or secret/);
});

test("secret Provider Env binding resolves through its backing Connection", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "penv_space_cf", spaceId: model.space.id }),
  );
  await store.putProviderEnv(
    providerEnv({
      id: "penv_space_cf",
      spaceId: model.space.id,
      materialization: "secret",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        alias: "main",
        envId: "penv_space_cf",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderEnvBindings(model.installation);
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.materialization).toBe("secret");
  expect(resolved[0]?.connection?.id).toBe("penv_space_cf");
  expect(mintableConnectionIds(resolved)).toEqual(["penv_space_cf"]);
});

test("operator-backed Provider Env is Cloud-only and resolves only when enabled", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_operator_cf" }));

  await expect(
    service.putProviderEnv("penv_operator_cf", {
      spaceId: model.space.id,
      providerSource: CLOUDFLARE,
      displayName: "Takosumi Cloud Cloudflare",
      materialization: "secret",
      requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
      secretRef: "conn_operator_cf",
    }),
  ).rejects.toThrow(/operator-scoped/);

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorBackedProviderEnvs: true,
  });
  await cloudService.putProviderEnv("penv_operator_cf", {
    spaceId: model.space.id,
    providerSource: CLOUDFLARE,
    displayName: "Takosumi Cloud Cloudflare",
    materialization: "secret",
    requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    secretRef: "conn_operator_cf",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_operator",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, envId: "penv_operator_cf" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/operator-scoped/);

  const resolved = await cloudService.resolveProviderEnvBindings(
    model.installation,
  );
  expect(resolved[0]?.connection?.id).toBe("conn_operator_cf");
  expect(resolved[0]?.connection?.scope).toBe("operator");
});

test("oauth Provider Env binding uses the same backing Connection boundary", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "penv_oauth_cf", spaceId: model.space.id }),
  );
  await store.putProviderEnv(
    providerEnv({
      id: "penv_oauth_cf",
      spaceId: model.space.id,
      materialization: "oauth",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, envId: "penv_oauth_cf" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderEnvBindings(model.installation);
  expect(resolved[0]?.materialization).toBe("oauth");
  expect(mintableConnectionIds(resolved)).toEqual(["penv_oauth_cf"]);
});

test("Provider Env from another Space is rejected", async () => {
  const { store, model, service } = await setup();
  await store.putProviderEnv(
    providerEnv({
      id: "penv_other",
      spaceId: "space_other",
      materialization: "secret",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, envId: "penv_other" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/belongs to another Space/);
});

test("required providers must have explicit Provider Env bindings", async () => {
  const { model, service } = await setup();
  await expect(
    service.resolveProviderEnvBindingsForRun(model.installation, [CLOUDFLARE]),
  ).rejects.toThrow(/provider connection is required/);
});

test("non-ready Provider Env fails closed before runner dispatch", async () => {
  const { store, model, service } = await setup();
  await store.putProviderEnv(
    providerEnv({
      id: "penv_pending",
      spaceId: model.space.id,
      materialization: "secret",
      status: "needs_setup",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, envId: "penv_pending" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/status needs_setup is not ready/);
});

test("Provider Env provider family must match the binding provider", async () => {
  const { store, model, service } = await setup();
  await store.putProviderEnv(
    providerEnv({
      id: "penv_aws",
      spaceId: model.space.id,
      providerSource: "registry.opentofu.org/hashicorp/aws",
      materialization: "secret",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, envId: "penv_aws" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/does not match binding provider/);
});
