/**
 * Root `takosumi-contract` exports the public contract facade. Internal ledger
 * fields such as InstallConfig.installType and templateBinding remain available
 * from the explicit `takosumi-contract/installations` subpath only.
 */
import { expect, test } from "bun:test";

import type {
  InstallConfig as RootInstallConfig,
  Installation as RootInstallation,
} from "./index.ts";

test("root contract facade exports public Installation projections", async () => {
  const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  expect(source).not.toContain('export * from "./installations.ts"');
  const deployControlSource = await Bun.file(
    new URL("./deploy-control-api.ts", import.meta.url),
  ).text();
  expect(deployControlSource).not.toContain(
    'export * from "./installations.ts"',
  );

  const config = {
    id: "cfg_public",
    name: "public",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootInstallConfig;
  expect("installType" in config).toBe(false);
  expect("templateBinding" in config).toBe(false);

  const installation = {
    id: "inst_public",
    spaceId: "space_public",
    name: "public",
    slug: "public",
    sourceId: "src_public",
    installConfigId: "cfg_public",
    environment: "prod",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
  } satisfies RootInstallation;
  expect("installType" in installation).toBe(false);
});

const publicConfig = {
  id: "cfg_public",
  name: "public",
  trustLevel: "space",
  variableMapping: {},
  outputAllowlist: {},
  policy: {},
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
} satisfies RootInstallConfig;

// @ts-expect-error root public InstallConfig must not expose the internal ledger discriminator.
({ ...publicConfig, installType: "opentofu_module" } satisfies RootInstallConfig);

const publicInstallation = {
  id: "inst_public",
  spaceId: "space_public",
  name: "public",
  slug: "public",
  sourceId: "src_public",
  installConfigId: "cfg_public",
  environment: "prod",
  currentStateGeneration: 0,
  status: "pending",
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
} satisfies RootInstallation;

// @ts-expect-error root public Installation must not expose the internal ledger discriminator.
({ ...publicInstallation, installType: "opentofu_module" } satisfies RootInstallation);
