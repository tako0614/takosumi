import { expect, test } from "bun:test";

import {
  isCanonicalRepositoryDirectoryPath,
  parseRepositoryModulesSnapshot,
  sourceSnapshotInstallModulesProjection,
  type SourceSnapshot,
} from "../../contract/sources.ts";

test("repository directory coordinates reject aliases instead of normalizing", () => {
  for (const value of [".", "infra", "deploy/selected", "a-b/c_d"]) {
    expect(isCanonicalRepositoryDirectoryPath(value), value).toBe(true);
  }
  for (const value of [
    "",
    "./infra",
    "/infra",
    "infra/",
    "infra//nested",
    "infra/./nested",
    "infra/../other",
    "infra\\nested",
    "C:/infra",
  ]) {
    expect(isCanonicalRepositoryDirectoryPath(value), value).toBe(false);
  }
});

const validIndex = {
  status: "ready" as const,
  scopePath: ".",
  modules: [
    {
      path: ".",
      providerPackages: [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          version: "5.8.2",
        },
      ],
      rootProviderRequirements: [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "cloudflare",
          childAlias: "account",
          version: "5.8.2",
        },
      ],
    },
    {
      path: "deploy/takoform",
      providerPackages: [
        { source: "registry.opentofu.org/takos/takoform" },
      ],
      rootProviderRequirements: [
        {
          source: "registry.opentofu.org/takos/takoform",
          moduleLocalName: "takoform",
        },
      ],
    },
  ],
};

test("repository module index parser accepts only canonical bounded observations", () => {
  expect(parseRepositoryModulesSnapshot(validIndex)).toEqual(validIndex);
  expect(
    parseRepositoryModulesSnapshot({
      ...validIndex,
      modules: [
        {
          path: "../escape",
          providerPackages: [],
          rootProviderRequirements: [],
        },
      ],
    }),
  ).toBeUndefined();
  expect(
    parseRepositoryModulesSnapshot({
      ...validIndex,
      modules: [
        {
          path: ".",
          providerPackages: [
            { source: "cloudflare/cloudflare" },
          ],
          rootProviderRequirements: [
            {
              source: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
            },
          ],
        },
      ],
    }),
  ).toBeUndefined();
  expect(
    parseRepositoryModulesSnapshot({
      ...validIndex,
      modules: [
        {
          path: ".",
          providerRequirements: [],
        },
      ],
    }),
  ).toBeUndefined();
  expect(
    parseRepositoryModulesSnapshot({
      status: "invalid",
      scopePath: ".",
      reason: "configuration_invalid",
    }),
  ).toEqual({
    status: "invalid",
    scopePath: ".",
    reason: "configuration_invalid",
  });
});

test("install-modules projects the immutable file-derived index, including zero modules", () => {
  const snapshot = {
    id: "snap_1",
    repositoryModules: validIndex,
  } as SourceSnapshot;
  expect(sourceSnapshotInstallModulesProjection(snapshot)).toEqual({
    status: "ready",
    sourceSnapshotId: "snap_1",
    scopePath: ".",
    modules: validIndex.modules,
  });
  expect(
    sourceSnapshotInstallModulesProjection({
      ...snapshot,
      repositoryModules: { status: "ready", scopePath: ".", modules: [] },
    }),
  ).toEqual({
    status: "ready",
    sourceSnapshotId: "snap_1",
    scopePath: ".",
    modules: [],
  });
});

test("manifest-only paths and legacy snapshots never become module candidates", () => {
  const snapshot = {
    id: "snap_legacy",
    repositoryManifest: {
      status: "present",
      digest: `sha256:${"a".repeat(64)}`,
      document: {
        apiVersion: "takosumi.com/v2.3",
        kind: "RepositoryManifest",
        install: { modules: { "manifest/only": {} } },
      },
    },
  } as unknown as SourceSnapshot;
  expect(sourceSnapshotInstallModulesProjection(snapshot)).toEqual({
    status: "invalid",
    sourceSnapshotId: "snap_legacy",
    scopePath: ".",
    reason: "scan_unavailable",
    modules: [],
  });
});
