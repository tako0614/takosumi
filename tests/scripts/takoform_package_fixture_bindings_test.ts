import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import type { InstalledFormReference } from "takosumi-contract";
import { canonicalJson } from "../../core/adapters/takoform/canonical_json.ts";
import { readExactPackageFixtureBindings } from "../../scripts/lib/takoform-package-fixture-bindings.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("standard host fixture binding reads exact retained package bytes", async () => {
  const fixture = await packageFixture();
  const bindings = await readExactPackageFixtureBindings({
    root: fixture.root,
    identity: fixture.identity,
    positiveFixtureName: "canonical",
    desired: fixture.desired,
    negativeFixtures: [
      {
        name: "reject-invalid-semantics",
        stage: "desired",
        input: fixture.negative,
        expectedErrorCode: "invalid_argument",
      },
    ],
  });
  expect(bindings).toEqual({
    positive: digest(fixture.desiredRaw),
    negative: { "reject-invalid-semantics": digest(fixture.negativeRaw) },
  });
});

test("standard host fixture binding rejects effective or retained substitution", async () => {
  const fixture = await packageFixture();
  await expect(
    readExactPackageFixtureBindings({
      root: fixture.root,
      identity: fixture.identity,
      positiveFixtureName: "canonical",
      desired: { ...fixture.desired, storageClass: "infrequent_access" },
      negativeFixtures: [
        {
          name: "reject-invalid-semantics",
          stage: "desired",
          input: fixture.negative,
          expectedErrorCode: "invalid_argument",
        },
      ],
    }),
  ).rejects.toThrow("--desired does not equal");

  await writeFile(
    join(fixture.root, "fixtures", "desired.json"),
    JSON.stringify(fixture.desired),
  );
  await expect(
    readExactPackageFixtureBindings({
      root: fixture.root,
      identity: fixture.identity,
      positiveFixtureName: "canonical",
      desired: fixture.desired,
      negativeFixtures: [
        {
          name: "reject-invalid-semantics",
          stage: "desired",
          input: fixture.negative,
          expectedErrorCode: "invalid_argument",
        },
      ],
    }),
  ).rejects.toThrow("readback digest drifted");
});

async function packageFixture() {
  const root = await mkdtemp(join(tmpdir(), "takosumi-form-package-"));
  roots.push(root);
  await mkdir(join(root, "fixtures"));
  const desired = {
    name: "assets",
    storageClass: "standard",
  };
  const negative = {
    name: "assets",
    storageClass: "cold",
  };
  const definition = {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.1",
    conformanceFixtures: [
      { name: "canonical", desiredPath: "fixtures/desired.json" },
    ],
    negativeConformanceFixtures: [
      {
        name: "reject-invalid-semantics",
        stage: "desired",
        inputPath: "fixtures/negative.json",
      },
    ],
  };
  const definitionRaw = pretty(definition);
  const desiredRaw = pretty(desired);
  const negativeRaw = pretty(negative);
  await writeFile(join(root, "definition.json"), definitionRaw);
  await writeFile(join(root, "fixtures", "desired.json"), desiredRaw);
  await writeFile(join(root, "fixtures", "negative.json"), negativeRaw);
  const formRef = {
    apiVersion: definition.apiVersion,
    kind: definition.kind,
    definitionVersion: definition.definitionVersion,
    schemaDigest: digest(canonicalJson(definition)),
  };
  await writeFile(
    join(root, "package-index.json"),
    pretty({
      apiVersion: "packages.forms.takoform.com/v1alpha1",
      kind: "FormPackage",
      packageVersion: "1.0.1",
      formRef,
      definitionPath: "definition.json",
      files: [
        { path: "definition.json", digest: digest(definitionRaw) },
        { path: "fixtures/desired.json", digest: digest(desiredRaw) },
        { path: "fixtures/negative.json", digest: digest(negativeRaw) },
      ],
    }),
  );
  const identity: InstalledFormReference = {
    formRef,
    packageDigest: `sha256:${"f".repeat(64)}`,
  };
  return {
    root,
    identity,
    desired,
    negative,
    desiredRaw,
    negativeRaw,
  };
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
