import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  parseRepositoryInstallUxText,
  TAKOSUMI_INSTALL_UX_MAX_BYTES,
} from "../../contract/install-ux.ts";

const fixtureDirectory = join(import.meta.dir, "fixtures", "install-ux");

async function fixture(name: string): Promise<string> {
  return await Bun.file(join(fixtureDirectory, name)).text();
}

test("repository install UX accepts the closed v1 proposal shape", async () => {
  const parsed = parseRepositoryInstallUxText(await fixture("valid.json"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.schemaVersion).toBe("takosumi.install-ux/v1");
  expect(parsed.document.modules["."]?.inputs.map((input) => input.name)).toEqual(
    [
      "project_name",
      "app_url",
      "notification_push_gateway_url",
      "notification_push_gateway_token",
    ],
  );
  expect(
    parsed.document.modules["."]?.installExperience?.projections.map(
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

test("repository install UX rejects unknown authority and unknown versions", async () => {
  expect(
    parseRepositoryInstallUxText(await fixture("unknown-key.json")),
  ).toEqual({
    ok: false,
    error: "contains unsupported field providers",
  });
  expect(
    parseRepositoryInstallUxText(await fixture("unknown-version.json")),
  ).toEqual({
    ok: false,
    error: "schemaVersion must be takosumi.install-ux/v1",
  });
});

test("repository install UX rejects traversal and duplicate app vocabulary", async () => {
  expect(
    parseRepositoryInstallUxText(await fixture("traversal.json")).ok,
  ).toBe(false);
  expect(
    parseRepositoryInstallUxText(await fixture("duplicate.json")),
  ).toEqual({
    ok: false,
    error: 'modules.".".inputs[1].name must be unique',
  });
});

test("repository install UX rejects secret env maps and unsupported projections", async () => {
  expect(
    parseRepositoryInstallUxText(await fixture("secret-leak.json")),
  ).toEqual({
    ok: false,
    error: 'modules.".".inputs[0].secret must not target the plain env variable',
  });
  expect(
    parseRepositoryInstallUxText(
      await fixture("unsupported-projection.json"),
    ),
  ).toEqual({
    ok: false,
    error:
      'modules.".".installExperience.projections[0].kind is unsupported',
  });

  const unknownSource = JSON.parse(await fixture("valid.json"));
  unknownSource.modules["."].inputs[0].source.kind = "command";
  expect(
    parseRepositoryInstallUxText(JSON.stringify(unknownSource)),
  ).toEqual({
    ok: false,
    error: 'modules.".".inputs[0].source.kind is unsupported',
  });
});

test("repository install UX enforces the UTF-8 byte limit", () => {
  const oversized = "界".repeat(
    Math.floor(TAKOSUMI_INSTALL_UX_MAX_BYTES / 3) + 1,
  );
  expect(parseRepositoryInstallUxText(oversized)).toEqual({
    ok: false,
    error: "document exceeds 128 KiB",
  });
});

test("repository install UX rejects module aliases and unsafe callback paths", async () => {
  const alias = JSON.parse(await fixture("valid.json"));
  alias.modules["./deploy"] = alias.modules["."];
  delete alias.modules["."];
  expect(parseRepositoryInstallUxText(JSON.stringify(alias)).ok).toBe(false);

  const originCallback = JSON.parse(await fixture("valid.json"));
  originCallback.modules["."].installExperience.projections[3].callbackPath =
    "https://example.com/callback";
  expect(
    parseRepositoryInstallUxText(JSON.stringify(originCallback)).ok,
  ).toBe(false);
});

test("repository install UX treats special module names as data, not object prototypes", () => {
  const parsed = parseRepositoryInstallUxText(
    '{"schemaVersion":"takosumi.install-ux/v1","modules":{"__proto__":{"inputs":[]}}}',
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(Object.hasOwn(parsed.document.modules, "__proto__")).toBe(true);
  expect(parsed.document.modules.__proto__).toEqual({ inputs: [] });
});
