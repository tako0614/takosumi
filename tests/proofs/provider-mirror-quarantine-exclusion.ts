#!/usr/bin/env bun

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_QUARANTINE_PATH,
  materializeProviderMirror,
  readJson,
  verifyManifestSidecar,
  verifyNetworkMirrorLayout,
} from "../../scripts/lib/provider-release.mjs";

const quarantine = await readJson(PROVIDER_QUARANTINE_PATH);
const quarantineManifestDigest = await verifyManifestSidecar(
  PROVIDER_QUARANTINE_PATH,
);
const workdir = await mkdtemp(
  join(tmpdir(), "takosumi-provider-mirror-proof-"),
);

try {
  const materializedRoot = join(workdir, "materialized-network-mirror");
  let fetches = 0;
  const result = await materializeProviderMirror({
    outputRoot: materializedRoot,
    cacheRoot: join(workdir, "verified-cache"),
    fetchImpl: async () => {
      fetches += 1;
      return new Response("unexpected provider fetch", { status: 500 });
    },
  });
  if (fetches !== 0) {
    throw new Error("empty approved provider mirror attempted a network fetch");
  }
  if (result.versions.length !== 0 || result.assets.length !== 0) {
    throw new Error("quarantined provider entered the publishable mirror set");
  }
  const verified = await verifyNetworkMirrorLayout(materializedRoot, [], {
    providerAddress: quarantine.providerAddress,
  });
  const indexPath = join(
    materializedRoot,
    quarantine.providerAddress,
    "index.json",
  );
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  if (
    Object.keys(index.versions ?? {}).length !== 0 ||
    quarantine.version in (index.versions ?? {})
  ) {
    throw new Error("quarantined provider appeared in the aggregate index");
  }
  for (const asset of quarantine.mirror.assets) {
    if (await Bun.file(join(materializedRoot, asset.path)).exists()) {
      throw new Error(`quarantined provider asset was exposed: ${asset.path}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "takosumi.provider-mirror-quarantine-exclusion-proof@v1",
        providerAddress: verified.providerAddress,
        approvedVersions: verified.versions,
        quarantineVersion: quarantine.version,
        quarantineManifestDigest,
        networkFetches: fetches,
        quarantineIndexed: false,
        quarantineAssetsExposed: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}
