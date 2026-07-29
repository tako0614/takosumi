import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  parseRepositoryManifestText,
  TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES,
} from "../../contract/repository-manifest.ts";

const fixtureDirectory = join(
  import.meta.dir,
  "fixtures",
  "repository-manifest",
);

async function fixture(name: string): Promise<string> {
  return await Bun.file(join(fixtureDirectory, name)).text();
}

test("repository manifest accepts the closed v1alpha1 install proposal", async () => {
  const parsed = parseRepositoryManifestText(await fixture("valid.json"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.apiVersion).toBe("takosumi.com/v1alpha1");
  expect(parsed.document.kind).toBe("Repository");
  expect(
    parsed.document.install.modules["."]?.inputs.map((input) => input.name),
  ).toEqual([
    "project_name",
    "app_url",
    "notification_push_gateway_url",
    "notification_push_gateway_token",
  ]);
  expect(
    parsed.document.install.modules[
      "."
    ]?.installExperience?.projections.map(
      (projection) => projection.kind,
    ),
  ).toEqual([
    "service_name",
    "public_endpoint",
    "initial_secret",
    "oidc_client",
    "artifact",
  ]);
});

test("repository manifest rejects unknown authority, fields, and versions", async () => {
  expect(
    parseRepositoryManifestText(await fixture("unknown-key.json")),
  ).toEqual({
    ok: false,
    error: "contains unsupported field providers",
  });
  expect(
    parseRepositoryManifestText(await fixture("unknown-version.json")),
  ).toEqual({
    ok: false,
    error: "apiVersion must be takosumi.com/v1alpha1",
  });
  expect(
    parseRepositoryManifestText(
      '{"schemaVersion":"takosumi.install-ux/v1","modules":{".":{"inputs":[]}}}',
    ),
  ).toEqual({
    ok: false,
    error: "contains unsupported field schemaVersion",
  });
  const schemaHint = JSON.parse(await fixture("valid.json"));
  schemaHint.$schema = "https://example.test/takosumi.schema.json";
  expect(parseRepositoryManifestText(JSON.stringify(schemaHint))).toEqual({
    ok: false,
    error: "contains unsupported field $schema",
  });
});

test("repository manifest rejects traversal and duplicate app vocabulary", async () => {
  expect(
    parseRepositoryManifestText(await fixture("traversal.json")).ok,
  ).toBe(false);
  expect(
    parseRepositoryManifestText(await fixture("duplicate.json")),
  ).toEqual({
    ok: false,
    error: 'install.modules.".".inputs[1].name must be unique',
  });
});

test("repository manifest rejects secret env maps and unsupported projections", async () => {
  expect(
    parseRepositoryManifestText(await fixture("secret-leak.json")),
  ).toEqual({
    ok: false,
    error:
      'install.modules.".".inputs[0].secret must not target the plain env variable',
  });
  expect(
    parseRepositoryManifestText(
      await fixture("unsupported-projection.json"),
    ),
  ).toEqual({
    ok: false,
    error:
      'install.modules.".".installExperience.projections[0].kind is unsupported',
  });

  const unknownSource = JSON.parse(await fixture("valid.json"));
  unknownSource.install.modules["."].inputs[0].source.kind = "command";
  expect(
    parseRepositoryManifestText(JSON.stringify(unknownSource)),
  ).toEqual({
    ok: false,
    error: 'install.modules.".".inputs[0].source.kind is unsupported',
  });
});

test("repository manifest enforces the UTF-8 byte limit", () => {
  const oversized = "界".repeat(
    Math.floor(TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES / 3) + 1,
  );
  expect(parseRepositoryManifestText(oversized)).toEqual({
    ok: false,
    error: "document exceeds 128 KiB",
  });
});

test("repository manifest rejects module aliases and unsafe callback paths", async () => {
  const alias = JSON.parse(await fixture("valid.json"));
  alias.install.modules["./deploy"] = alias.install.modules["."];
  delete alias.install.modules["."];
  expect(parseRepositoryManifestText(JSON.stringify(alias)).ok).toBe(false);

  const originCallback = JSON.parse(await fixture("valid.json"));
  originCallback.install.modules[
    "."
  ].installExperience.projections[3].callbackPath =
      "https://example.com/callback";
  expect(
    parseRepositoryManifestText(JSON.stringify(originCallback)).ok,
  ).toBe(false);
});

test("repository manifest treats special module names as data, not object prototypes", () => {
  const parsed = parseRepositoryManifestText(
    '{"apiVersion":"takosumi.com/v1alpha1","kind":"Repository","install":{"modules":{"__proto__":{"inputs":[]}}}}',
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(
    Object.hasOwn(parsed.document.install.modules, "__proto__"),
  ).toBe(true);
  expect(parsed.document.install.modules.__proto__).toEqual({ inputs: [] });
});
