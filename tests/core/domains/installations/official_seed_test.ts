import { expect, test } from "bun:test";

import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  installConfigIdForName,
  installConfigIdForTemplate,
  officialInstallConfigs,
  seedOfficialInstallConfigs,
} from "../../../../core/domains/capsules/official_seed.ts";
import { defaultTemplateRegistry } from "../../../../core/domains/templates/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";

const NOW = () => new Date("2026-06-06T00:00:00.000Z");

const NAMED = [
  { name: "core", templateId: "core", installType: "core" },
] as const;

test("officialInstallConfigs seeds the generic Capsule default + first-party template configs", () => {
  const configs = officialInstallConfigs({ now: NOW });
  const templates = defaultTemplateRegistry.list();
  // One generic Capsule config, five curated generic Capsule app configs, plus
  // one config per template (except templates already bound by a named alias,
  // currently only core).
  expect(configs.length).toBe(templates.length + 6);
  const generic = configs[0];
  expect(generic?.id).toBe(DEFAULT_CAPSULE_INSTALL_CONFIG_ID);
  expect(generic?.sourceKind).toBe("generic_capsule");
  expect(generic?.templateBinding).toBeUndefined();
  expect(generic?.trustLevel).toBe("trusted");
  expect(generic?.outputAllowlist).toEqual({
    url: { from: "url", type: "url" },
    worker_name: { from: "worker_name", type: "string" },
  });
  for (const config of configs) {
    expect(config.spaceId).toBeUndefined();
    expect(config.createdAt).toBe("2026-06-06T00:00:00.000Z");
  }
});

test("the named official aliases carry friendly names, ids, and §10 install types without talk/files", () => {
  const configs = officialInstallConfigs({ now: NOW });
  for (const named of NAMED) {
    const config = configs.find((c) => c.name === named.name);
    expect(config?.id).toBe(installConfigIdForName(named.name));
    expect(config?.installType).toBe(named.installType);
    expect(config?.templateBinding?.templateId).toBe(named.templateId);
    expect(config?.sourceKind).toBe("first_party_capsule");
  }
  expect(configs.find((c) => c.name === "talk")).toBeUndefined();
  expect(configs.find((c) => c.name === "files")).toBeUndefined();
  expect(configs.find((c) => c.id === "cfg-official-talk")).toBeUndefined();
  expect(configs.find((c) => c.id === "cfg-official-files")).toBeUndefined();
  // core is the only `core` install type.
  const core = configs.find((c) => c.name === "core");
  expect(core?.installType).toBe("core");
});

test("a template bound by a named install does not also get a generic config", () => {
  const configs = officialInstallConfigs({ now: NOW });
  // The core template is bound as `core`; there must be exactly one config over
  // that template surface.
  expect(
    configs.filter((c) => c.templateBinding?.templateId === "core"),
  ).toHaveLength(1);
});

test("generic per-template configs keep installType opentofu_module + a template-derived id", () => {
  const configs = officialInstallConfigs({ now: NOW });
  const namedTemplateIds = new Set(NAMED.map((n) => n.templateId));
  for (const template of defaultTemplateRegistry.list()) {
    if (namedTemplateIds.has(template.id)) continue;
    const config = configs.find(
      (c) => c.id === installConfigIdForTemplate(template.id),
    );
    expect(config?.installType).toBe("opentofu_module");
    expect(config?.name).toBe(template.id);
    expect(config?.sourceKind).toBe("first_party_capsule");
    expect(config?.templateBinding?.templateVersion).toBe(template.version);
  }
});

test("hostable official configs expose public catalog metadata for the dashboard", () => {
  const configs = officialInstallConfigs({ now: NOW });
  const catalogTemplateIds = configs
    .map((config) => config.catalog?.templateId)
    .filter(Boolean);
  expect(catalogTemplateIds).toEqual(["cloudflare-hello-worker"]);
  expect(
    configs
      .map((config) => config.catalog?.order)
      .filter((order): order is number => order !== undefined)
      .sort((a, b) => a - b),
  ).toEqual([10, 100, 110, 115, 120, 130]);

  const hello = configs.find(
    (config) => config.catalog?.templateId === "cloudflare-hello-worker",
  );
  expect(hello?.catalog?.source?.git).toBe(
    "https://github.com/tako0614/takosumi.git",
  );
  expect(hello?.catalog?.source?.ref).toMatch(/^[0-9a-f]{40}$/);
  expect(hello?.catalog?.source?.path).toBe(
    "providers/cloudflare/modules/cloudflare-hello-worker/module",
  );
  expect(hello?.catalog?.inputs.map((input) => input.name)).toContain(
    "workersSubdomain",
  );
  expect(hello?.catalog?.name.ja).toBe("Webアプリを公開");
  expect(hello?.catalog?.surface).toBe("service");

  const hidden = configs.find((config) => config.name === "core");
  expect(hidden?.catalog).toBeUndefined();

  const yurucommu = configs.find(
    (config) => config.id === "cfg-catalog-yurucommu",
  );
  const office = configs.find(
    (config) => config.id === "cfg-catalog-takos-office",
  );
  const storage = configs.find(
    (config) => config.id === "cfg-catalog-takos-storage",
  );
  const git = configs.find((config) => config.id === "cfg-catalog-takos-git");
  const takos = configs.find((config) => config.id === "cfg-catalog-takos");
  const yurucommuInput = (name: string) =>
    yurucommu?.catalog?.inputs.find((input) => input.name === name);
  const officeInput = (name: string) =>
    office?.catalog?.inputs.find((input) => input.name === name);
  const storageInput = (name: string) =>
    storage?.catalog?.inputs.find((input) => input.name === name);
  const gitInput = (name: string) =>
    git?.catalog?.inputs.find((input) => input.name === name);
  const takosInput = (name: string) =>
    takos?.catalog?.inputs.find((input) => input.name === name);
  expect(yurucommu?.sourceKind).toBe("generic_capsule");
  expect(yurucommu?.catalog?.source.ref).toBe(
    "ebe1cb08e67794aaab4722b138a321c78e430291",
  );
  expect(yurucommu?.catalog?.source.path).toBe(".");
  expect(yurucommu?.modulePath).toBeUndefined();
  expect(yurucommuInput("worker_bundle_url")).toMatchObject({
    advanced: true,
    defaultValue:
      "https://github.com/tako0614/yurucommu/releases/download/v2.0.3/takos-worker-4f184e34c3ddf25c4be6a6c5ade5381173cef04e7fe8068b849ae88bd84c35cc.js",
  });
  expect(yurucommuInput("worker_bundle_sha256")).toMatchObject({
    advanced: true,
    defaultValue:
      "4f184e34c3ddf25c4be6a6c5ade5381173cef04e7fe8068b849ae88bd84c35cc",
  });
  expect(yurucommuInput("worker_bundle_url")?.defaultValue).toBe(
    "https://github.com/tako0614/yurucommu/releases/download/v2.0.3/takos-worker-4f184e34c3ddf25c4be6a6c5ade5381173cef04e7fe8068b849ae88bd84c35cc.js",
  );
  expect(yurucommuInput("worker_bundle_sha256")?.defaultValue).toBe(
    "4f184e34c3ddf25c4be6a6c5ade5381173cef04e7fe8068b849ae88bd84c35cc",
  );
  expect(yurucommuInput("enable_cloudflare_resources")?.advanced).toBe(true);
  expect(yurucommuInput("enable_cloudflare_worker_script")?.advanced).toBe(
    true,
  );
  expect(yurucommu?.catalog?.installExperience).toEqual({
    projections: [
      { kind: "service_name", variable: "project_name" },
      {
        kind: "public_endpoint",
        variables: {
          subdomain: "worker_name",
          url: "app_url",
          routePattern: "cloudflare_route_pattern",
        },
        baseDomain: "app.takos.jp",
      },
      {
        kind: "initial_secret",
        variable: "auth_password_hash",
        secretKind: "password_or_hash",
        optional: true,
      },
      {
        kind: "oidc_client",
        variables: {
          issuerUrl: "takosumi_accounts_issuer_url",
          clientId: "takosumi_accounts_client_id",
        },
        callbackPath: "/api/auth/callback/takos",
      },
      {
        kind: "artifact",
        variables: {
          url: "worker_bundle_url",
          sha256: "worker_bundle_sha256",
        },
      },
    ],
  });
  expect(yurucommu?.outputAllowlist.takosumi_release).toEqual({
    from: "takosumi_release",
    type: "json",
  });
  expect(yurucommu?.outputAllowlist).toMatchObject({
    launch_url: { from: "launch_url", type: "url" },
    cloudflare_account_id: {
      from: "cloudflare_account_id",
      type: "string",
    },
    cloudflare_d1_database_id: {
      from: "cloudflare_d1_database_id",
      type: "string",
    },
    cloudflare_d1_database_name: {
      from: "cloudflare_d1_database_name",
      type: "string",
    },
    cloudflare_kv_namespace_id: {
      from: "cloudflare_kv_namespace_id",
      type: "string",
    },
    cloudflare_r2_bucket_name: {
      from: "cloudflare_r2_bucket_name",
      type: "string",
    },
    cloudflare_queue_names: {
      from: "cloudflare_queue_names",
      type: "json",
    },
  });
  expect(office?.sourceKind).toBe("generic_capsule");
  expect(office?.catalog?.source.git).toBe(
    "https://github.com/tako0614/takos-office.git",
  );
  expect(office?.catalog?.source.ref).toBe(
    "0c74008efda973f1820a07bd77d305b7d7340c2e",
  );
  expect(office?.catalog?.source.path).toBe(".");
  expect(office?.catalog?.iconUrl).toContain("office.svg");
  expect(officeInput("worker_bundle_url")).toMatchObject({
    advanced: true,
    defaultValue:
      "https://github.com/tako0614/takos-office/releases/download/v0.1.0/worker-f3267ebffba084c891882f993094df475c0ca94bb1ff97411a168bc6fccffe50.js",
  });
  expect(officeInput("worker_bundle_sha256")).toMatchObject({
    advanced: true,
    defaultValue:
      "f3267ebffba084c891882f993094df475c0ca94bb1ff97411a168bc6fccffe50",
  });
  expect(office?.outputAllowlist.service_exports).toEqual({
    from: "service_exports",
    type: "json",
  });
  expect(office?.outputAllowlist.worker_name).toEqual({
    from: "worker_name",
    type: "string",
  });
  expect(storage?.catalog?.iconUrl).toContain("storage.svg");
  expect(storage?.catalog?.source.ref).toBe(
    "db5e829f92ce5f96b541ad18912f5956265ec28b",
  );
  expect(storageInput("worker_bundle_url")).toMatchObject({
    advanced: true,
    defaultValue:
      "https://github.com/tako0614/takos-storage/releases/download/v0.1.1/worker.js",
  });
  expect(storageInput("worker_bundle_sha256")).toMatchObject({
    advanced: true,
    defaultValue:
      "9f9e3a8584048ec49fce4aa2ca9f8b3b942a35c6339c4e4e39aee306a4587a1b",
  });
  expect(storage?.outputAllowlist.worker_name).toEqual({
    from: "worker_name",
    type: "string",
  });
  expect(git?.catalog?.iconUrl).toContain("git.svg");
  expect(git?.catalog?.source.ref).toBe(
    "7e92bffd9aa741d41d48c3edc2746a2086e55a16",
  );
  expect(gitInput("worker_bundle_url")).toMatchObject({
    advanced: true,
    defaultValue:
      "https://github.com/tako0614/takos-git/releases/download/v0.1.1/worker.js",
  });
  expect(gitInput("worker_bundle_sha256")).toMatchObject({
    advanced: true,
    defaultValue:
      "0f75a091e58d463dd45b20f1d1570fa69a9b2a06fe6b1e2f6c5914e75bf209eb",
  });
  expect(git?.outputAllowlist.worker_name).toEqual({
    from: "worker_name",
    type: "string",
  });
  expect(takos?.sourceKind).toBe("generic_capsule");
  expect(takos?.catalog?.source.ref).toBe(
    "3b5f46cce2c92d343580a6dd6ac5fe3c7a21a35d",
  );
  expect(takos?.catalog?.source.path).toBe("deploy/opentofu");
  expect(takos?.modulePath).toBe("deploy/opentofu");
  expect(takos?.outputAllowlist.worker_name).toEqual({
    from: "worker_name",
    type: "string",
  });
  expect(takos?.catalog?.installExperience).toEqual({
    projections: [
      { kind: "service_name", variable: "project_name" },
      {
        kind: "public_endpoint",
        variables: {
          subdomain: "worker_name",
          url: "app_url",
        },
        baseDomain: "app.takos.jp",
      },
      {
        kind: "oidc_client",
        variables: {
          issuerUrl: "takosumi_accounts_issuer_url",
          accountsUrl: "takosumi_accounts_url",
          clientId: "takosumi_accounts_client_id",
          redirectUri: "takosumi_accounts_redirect_uri",
        },
        callbackPath: "/auth/oidc/callback",
      },
    ],
  });
  expect(takos?.outputAllowlist.takosumi_release).toEqual({
    from: "takosumi_release",
    type: "json",
  });
  const releaseImagesDefault = takos?.catalog?.inputs.find(
    (input) => input.name === "release_container_images",
  )?.defaultValue;
  expect(takosInput("release_container_images")?.advanced).toBe(true);
  expect(releaseImagesDefault).toContain("0.10.0-3cfcc10f7ad1");
  expect(releaseImagesDefault).not.toContain("0.10.0-bfdd9f8bb79c");
});

test("official catalog source can be operator-selected without changing templates", () => {
  const configs = officialInstallConfigs({
    now: NOW,
    officialCatalogSource: {
      git: "https://github.com/example/takosumi-release.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
    },
  });
  const hello = configs.find(
    (config) => config.catalog?.templateId === "cloudflare-hello-worker",
  );
  expect(hello?.catalog?.source?.git).toBe(
    "https://github.com/example/takosumi-release.git",
  );
  expect(hello?.catalog?.source?.ref).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
});

test("seeded config output allowlist mirrors the template public outputs", () => {
  const template = defaultTemplateRegistry.require(
    "cloudflare-hello-worker",
    "1.0.0",
  );
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.name === "cloudflare-hello-worker",
  );
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    expect(config?.outputAllowlist[name]?.from).toBe(spec.from);
    expect(config?.outputAllowlist[name]?.type).toBe("string");
  }
});

test("seeded config policy mirrors the template policy spec", () => {
  const template = defaultTemplateRegistry.require(
    "cloudflare-hello-worker",
    "1.0.0",
  );
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.name === "cloudflare-hello-worker",
  );
  expect(config?.policy.allowedProviders).toEqual(
    template.policy.allowedProviders,
  );
  expect(config?.policy.allowedResourceTypes).toEqual(
    template.policy.allowedResourceTypes,
  );
  expect(config?.policy.destructiveChanges?.requireExplicitConfirmation).toBe(
    template.policy.destructiveChanges.requireExplicitConfirmation,
  );
});

test("seedOfficialInstallConfigs persists every official config (idempotent)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedOfficialInstallConfigs(store, { now: NOW });
  const expected = officialInstallConfigs({ now: NOW });
  const persisted = await store.listInstallConfigs();
  expect(persisted.length).toBe(expected.length);
  // Re-seeding is an idempotent upsert by the derived id, not a duplicate.
  await seedOfficialInstallConfigs(store, { now: NOW });
  expect((await store.listInstallConfigs()).length).toBe(expected.length);
  expect(
    (await store.getInstallConfig(DEFAULT_CAPSULE_INSTALL_CONFIG_ID))
      ?.sourceKind,
  ).toBe("generic_capsule");
  // The named official alias is reachable by its friendly id.
  for (const named of NAMED) {
    const fetched = await store.getInstallConfig(
      installConfigIdForName(named.name),
    );
    expect(fetched?.installType).toBe(named.installType);
    expect(fetched?.name).toBe(named.name);
  }
});
