import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { canonicalJsonBytes } from "../../core/adapters/takoform/canonical_json.ts";
import {
  main,
  prepareInstallEnvelopes,
} from "../../scripts/prepare-takoform-install-envelopes.ts";
import type { ReviewedPublishedPackageInstallSet } from "../../scripts/verify-takoform-published-package-host-proof.ts";

const sandboxes: string[] = [];
const KINDS = [
  "ContainerService",
  "EdgeWorker",
  "KeyValueStore",
  "ObjectBucket",
  "Queue",
  "RelationalDatabase",
  "Schedule",
  "StatefulEntity",
  "VectorIndex",
] as const;

afterEach(async () => {
  await Promise.all(
    sandboxes
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("writes one deterministic canonical reviewed set with private modes", async () => {
  const { root, takoformRoot } = await sandbox();
  const reviewed = fakeReviewedSet();
  const first = join(root, "first-output");
  const second = join(root, "second-output");
  const dependency = { loadReviewedSet: async () => reviewed };

  const result = await prepareInstallEnvelopes(
    { takoformRoot, outputDir: first },
    dependency,
  );
  await prepareInstallEnvelopes(
    { takoformRoot, outputDir: second },
    dependency,
  );

  expect(result.packageCount).toBe(9);
  expect((await lstat(first)).mode & 0o777).toBe(0o700);
  const firstFiles = (await readdir(first)).sort();
  const secondFiles = (await readdir(second)).sort();
  expect(firstFiles).toEqual(secondFiles);
  expect(firstFiles).toHaveLength(29);
  for (const name of firstFiles) {
    expect((await lstat(join(first, name))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(first, name))).toEqual(
      await readFile(join(second, name)),
    );
  }

  const manifestBytes = new Uint8Array(
    await readFile(join(first, "install-envelope-manifest.json")),
  );
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    format: string;
    repository: string;
    historicalCheckpoint: { root: string; version: string };
    historicalPublication: { repository: string };
    trustedRoot: { digest: string; file: string; r2Key: string };
    packages: Array<{
      kind: string;
      definitionVersion: string;
      packageDigest: string;
      envelopeDigest: string;
      envelopeFile: string;
      r2Key: string;
      installRequest: { body: { artifactRef: string } };
      reverifyRequest: {
        body: {
          type: string;
          version: string;
          schemaDigest: string;
          packageDigest: string;
        };
      };
    }>;
  };
  expect(manifest.format).toBe("takosumi.takoform-install-envelope-set@v3");
  expect(manifest.repository).toBe(
    "tako0614/terraform-provider-takoform",
  );
  expect(manifest.historicalCheckpoint).toMatchObject({
    root: "admission/v4",
    version: "1.0.7",
  });
  expect(manifest.historicalPublication.repository).toBe(
    "tako0614/terraform-provider-takoform",
  );
  expect(manifest.trustedRoot).toEqual({
    digest: reviewed.trustedRoot.digest,
    file: "trusted-root.json",
    r2Key: "trust/sigstore-public-good-root.json",
  });
  expect(manifest.packages.map(({ kind }) => kind)).toEqual(
    [...KINDS].sort((left, right) => left.localeCompare(right)),
  );
  for (const entry of manifest.packages) {
    const envelope = new Uint8Array(
      await readFile(join(first, entry.envelopeFile)),
    );
    expect(entry.envelopeDigest).toBe(digest(envelope));
    expect(entry.r2Key).toEndWith(
      `/${entry.envelopeDigest.slice("sha256:".length)}.json`,
    );
    expect(entry.r2Key).toStartWith(
      `packages/takoform/${entry.definitionVersion}/`,
    );
    expect(entry.installRequest.body.artifactRef).toBe(`r2:${entry.r2Key}`);
    expect(entry.reverifyRequest.body.packageDigest).toBe(entry.packageDigest);
    expect(entry.reverifyRequest.body.version).toBe(entry.definitionVersion);
    expect(entry.reverifyRequest.body.type).toMatch(/^[a-z][a-z0-9_]+$/);
  }
  expect(manifestBytes).toEqual(canonicalJsonBytes(manifest as never));
});

test("verifies the full set before publishing any output", async () => {
  const { root, takoformRoot } = await sandbox();
  const outputDir = join(root, "failed-output");
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir },
      {
        loadReviewedSet: async () => {
          throw new Error("real verifier rejected package 9");
        },
      },
    ),
  ).rejects.toThrow("real verifier rejected");
  await expect(lstat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    (await readdir(root)).filter((name) => name.includes(".tmp-")),
  ).toEqual([]);
});

test("rejects noncanonical or incomplete reviewed data before creating output", async () => {
  const { root, takoformRoot } = await sandbox();
  const noncanonicalOutput = join(root, "noncanonical-output");
  const reviewed = fakeReviewedSet();
  const noncanonical = {
    ...reviewed,
    packages: reviewed.packages.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            envelopeBytes: new TextEncoder().encode('{"z":1,"a":2}'),
          }
        : entry,
    ),
  };
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir: noncanonicalOutput },
      { loadReviewedSet: async () => noncanonical },
    ),
  ).rejects.toThrow("not canonical JSON");
  await expect(lstat(noncanonicalOutput)).rejects.toMatchObject({
    code: "ENOENT",
  });

  const incompleteOutput = join(root, "incomplete-output");
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir: incompleteOutput },
      {
        loadReviewedSet: async () => ({
          ...reviewed,
          packages: reviewed.packages.slice(1),
        }),
      },
    ),
  ).rejects.toThrow("incomplete");
  await expect(lstat(incompleteOutput)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("never overwrites an existing output directory", async () => {
  const { root, takoformRoot } = await sandbox();
  const outputDir = join(root, "existing-output");
  await mkdir(outputDir, { mode: 0o700 });
  let loaded = false;
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir },
      {
        loadReviewedSet: async () => {
          loaded = true;
          return fakeReviewedSet();
        },
      },
    ),
  ).rejects.toThrow("refusing to overwrite");
  expect(loaded).toBeFalse();
});

test("rejects symlinked source and output paths", async () => {
  const { root, takoformRoot } = await sandbox();
  const rootLink = join(root, "takoform-link");
  const parentLink = join(root, "parent-link");
  const realParent = join(root, "real-parent");
  await mkdir(realParent);
  await symlink(takoformRoot, rootLink);
  await symlink(realParent, parentLink);
  const dependency = { loadReviewedSet: async () => fakeReviewedSet() };

  await expect(
    prepareInstallEnvelopes(
      { takoformRoot: rootLink, outputDir: join(root, "root-link-output") },
      dependency,
    ),
  ).rejects.toThrow("real directory");
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir: join(parentLink, "output") },
      dependency,
    ),
  ).rejects.toThrow("parent must not traverse a symlink");
});

test("rejects output inside either source repository", async () => {
  const { takoformRoot } = await sandbox();
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir: join(takoformRoot, "private-output") },
      { loadReviewedSet: async () => fakeReviewedSet() },
    ),
  ).rejects.toThrow("outside source repositories");
  expect(await readdir(takoformRoot)).toEqual([]);

  const sourcePath = join(
    new URL("../../", import.meta.url).pathname,
    "forbidden-output",
  );
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir: sourcePath },
      { loadReviewedSet: async () => fakeReviewedSet() },
    ),
  ).rejects.toThrow("outside source repositories");
});

test("requires a current-user-owned 0700 output parent", async () => {
  const { root, takoformRoot } = await sandbox();
  await chmod(root, 0o755);
  await expect(
    prepareInstallEnvelopes(
      { takoformRoot, outputDir: join(root, "unsafe-parent-output") },
      { loadReviewedSet: async () => fakeReviewedSet() },
    ),
  ).rejects.toThrow("owned by the current user with mode 0700");
  expect(await readdir(root)).toEqual(["takoform"]);
});

test("CLI parser rejects unknown, duplicate, and relative path arguments", async () => {
  await expect(main(["--unknown"])).rejects.toThrow("unexpected argument");
  await expect(
    main([
      "--takoform-root",
      "/tmp/a",
      "--takoform-root",
      "/tmp/b",
      "--output-dir",
      "/tmp/c",
    ]),
  ).rejects.toThrow("duplicate argument");
  await expect(
    main(["--takoform-root", "relative", "--output-dir", "/tmp/c"]),
  ).rejects.toThrow("absolute path");
});

test("preparation source has no network, R2, or secret integration", async () => {
  const source = await readFile(
    new URL(
      "../../scripts/prepare-takoform-install-envelopes.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source).not.toContain("fetch(");
  expect(source).not.toContain("R2Bucket");
  expect(source).not.toContain("TAKOSUMI_DEPLOY_CONTROL_TOKEN");
  expect(source).not.toContain("wrangler");
});

async function sandbox(): Promise<{ root: string; takoformRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "takosumi-envelope-test-"));
  sandboxes.push(root);
  const takoformRoot = join(root, "takoform");
  await mkdir(takoformRoot);
  return { root, takoformRoot };
}

function fakeReviewedSet(): ReviewedPublishedPackageInstallSet {
  const trustedRootBytes = canonicalJsonBytes({ root: "test-public-root" });
  return {
    format: "takosumi.reviewed-takoform-package-install-set@v3",
    repository: "tako0614/terraform-provider-takoform",
    checkoutCommit: "a".repeat(40),
    checkoutVersion: "1.0.2",
    historicalCheckpoint: {
      root: "admission/v4",
      version: "1.0.7",
      tag: "forms/admissions/v1.0.7",
      commit: "b".repeat(40),
      tree: "c".repeat(40),
    },
    historicalPublication: {
      repository: "tako0614/terraform-provider-takoform",
      publicationSet: {
        path: "admission/v4/form-package-publication-set.json",
        digest: `sha256:${"1".repeat(64)}`,
      },
    },
    checkpointVersion: {
      path: "admission/v4/version.json",
      digest: `sha256:${"3".repeat(64)}`,
    },
    publishedTrust: {
      path: "admission/v4/trust/published-package-trust.json",
      digest: `sha256:${"4".repeat(64)}`,
    },
    packageIndexPolicy: {
      path: "admission/v4/trust/package-index-policy.json",
      digest: `sha256:${"5".repeat(64)}`,
    },
    trustedRoot: {
      path: "admission/v4/trust/trusted-root.json",
      digest: digest(trustedRootBytes),
      bytes: trustedRootBytes,
    },
    publisher: {
      oidcIssuer: "https://token.actions.githubusercontent.com",
      sourceRepository: "tako0614/terraform-provider-takoform",
      workflow: ".github/workflows/form-package-release.yml",
      refPattern: "refs/heads/main",
    },
    verifierId: "takoform.form-package.v1alpha1+takoform.sigstore-keyless.v1",
    packages: KINDS.map((kind, index) => ({
      kind,
      releaseCommit: String(index + 1).padStart(40, "d"),
      releaseTag: `forms/k-${kind.toLowerCase()}/v${
        index % 2 === 0 ? "3.0.0" : "2.0.0"
      }`,
      packageDigest: `sha256:${String(index + 1).padStart(64, "0")}`,
      formRef: {
        apiVersion: "forms.takoform.com/v1alpha1",
        kind,
        definitionVersion: index % 2 === 0 ? "3.0.0" : "2.0.0",
        schemaDigest: `sha256:${String(index + 11).padStart(64, "0")}`,
      },
      hostFormRef: {
        type: kind
          .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
          .toLowerCase(),
        version: index % 2 === 0 ? "3.0.0" : "2.0.0",
        schemaDigest: `sha256:${String(index + 11).padStart(64, "0")}`,
      },
      envelopeBytes: canonicalJsonBytes({ kind, index }),
    })),
  };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
