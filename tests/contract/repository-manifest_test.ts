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

test("repository manifest accepts the closed v1 install proposal", async () => {
  const parsed = parseRepositoryManifestText(await fixture("valid.json"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.apiVersion).toBe("takosumi.com/v1");
  expect(parsed.document.kind).toBe("Repository");
  expect(
    parsed.document.install.modules["."]?.inputs.map((input) => input.name),
  ).toEqual([
    "project_name",
    "app_url",
    "notification_push_gateway_url",
    "notification_push_gateway_token",
    "accounts_issuer_url",
    "accounts_client_id",
  ]);
  expect(
    parsed.document.install.modules["."]?.requires?.map(
      (requirement) => requirement.kind,
    ),
  ).toEqual(["http.endpoint", "identity.oidc", "secret.generated"]);
  expect(
    parsed.document.install.modules["."]?.inputs.find(
      (input) => input.role !== undefined,
    ),
  ).toMatchObject({ name: "project_name", role: "service_name" });
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
    error: "apiVersion must be takosumi.com/v1",
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

test("repository manifest rejects secret env maps and unsupported requirements", async () => {
  expect(
    parseRepositoryManifestText(await fixture("secret-leak.json")),
  ).toEqual({
    ok: false,
    error:
      'install.modules.".".inputs[0].secret must not target the plain env variable',
  });
  expect(
    parseRepositoryManifestText(
      await fixture("unsupported-requirement.json"),
    ),
  ).toEqual({
    ok: false,
    error: 'install.modules.".".requires[0].kind is unsupported',
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
  originCallback.install.modules["."].requires[1].callbackPath =
    "https://example.com/callback";
  expect(
    parseRepositoryManifestText(JSON.stringify(originCallback)).ok,
  ).toBe(false);
});

test("a requirement names exactly one delivery surface", async () => {
  const both = JSON.parse(await fixture("valid.json"));
  both.install.modules["."].requires[2].deliver = {
    variables: { value: "app_url" },
    bindings: { value: "ENCRYPTION_KEY" },
  };
  expect(parseRepositoryManifestText(JSON.stringify(both))).toEqual({
    ok: false,
    error:
      'install.modules.".".requires[2].deliver must declare exactly one of variables or bindings',
  });

  const neither = JSON.parse(await fixture("valid.json"));
  neither.install.modules["."].requires[2].deliver = {};
  expect(parseRepositoryManifestText(JSON.stringify(neither)).ok).toBe(false);
});

test("a generated secret stays inside reviewed size bounds", async () => {
  for (const bytes of [8, 128, 32.5]) {
    const document = JSON.parse(await fixture("valid.json"));
    document.install.modules["."].requires[2].bytes = bytes;
    expect(parseRepositoryManifestText(JSON.stringify(document))).toEqual({
      ok: false,
      error:
        'install.modules.".".requires[2].bytes must be an integer between 16 and 64',
    });
  }
});

test("two requirements cannot claim the same delivered name", async () => {
  const document = JSON.parse(await fixture("valid.json"));
  document.install.modules["."].requires[1].deliver = {
    variables: { issuerUrl: "app_url" },
  };
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("repository manifest treats special module names as data, not object prototypes", () => {
  const parsed = parseRepositoryManifestText(
    '{"apiVersion":"takosumi.com/v1","kind":"Repository","install":{"modules":{"__proto__":{"inputs":[]}}}}',
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(
    Object.hasOwn(parsed.document.install.modules, "__proto__"),
  ).toBe(true);
  expect(parsed.document.install.modules.__proto__).toEqual({ inputs: [] });
});
