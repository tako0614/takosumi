import { expect, test } from "bun:test";

import {
  installExperienceValue,
  installConfigStoreValue,
  modulePathValue,
  sourceBuildValue,
  variablePresentationValue,
} from "../../../../accounts/service/src/control/parse.ts";

test("OIDC install experience uses only explicit module variable mappings", () => {
  expect(
    installExperienceValue({
      projections: [
        {
          kind: "oidc_client",
          variables: {
            issuerUrl: "identity_issuer",
            clientId: "identity_client_id",
          },
          callbackPath: "/auth/callback",
        },
      ],
    }),
  ).toEqual({
    projections: [
      {
        kind: "oidc_client",
        variables: {
          issuerUrl: "identity_issuer",
          clientId: "identity_client_id",
        },
        callbackPath: "/auth/callback",
      },
    ],
  });

  // Registering a redirect without an explicit application callback would
  // otherwise force a Takos/Takosumi-specific path convention on the module.
  expect(
    installExperienceValue({
      projections: [{ kind: "oidc_client", variables: {} }],
    }),
  ).toBeUndefined();
});

test("module paths normalize separators before enforcing a relative root", () => {
  for (const path of ["\\etc", "\\\\server\\share", "\\", "/etc", "C:\\etc", "..\\etc",
    ".\\C:\\etc", ".\\C:\\", ".\\.\\C:\\etc", ".\\.\\..", "dir/../C:/etc", "dir\\..\\C:\\etc"]) {
    expect(modulePathValue(path), path).toBeUndefined();
  }
  for (const [path, expected] of [
    [".", ""], ["./", ""], [".\\", ""],
    ["deploy\\app", "deploy/app"], ["./\\app", "app"],
    ["deploy\\..\\app", "app"], ["deploy/../app", "app"],
  ]) {
    expect(modulePathValue(path), path).toBe(expected);
  }
});

test("module paths remain canonical when the host path implementation is win32", async () => {
  const moduleUrl = new URL("../../../../accounts/service/src/control/parse.ts", import.meta.url).href;
  const script = [
    'import { mock } from "bun:test";',
    'const path = await import("node:path");',
    'mock.module("node:path", () => ({ ...path, normalize: path.win32.normalize, isAbsolute: path.win32.isAbsolute }));',
    "const { modulePathValue } = await import(" + JSON.stringify(moduleUrl) + ");",
    'console.log(JSON.stringify(["deploy/app", "deploy/../../etc", "./C:/etc", "./C:/"].map(path => modulePathValue(path) ?? null)));',
  ].join("\n");
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual(["deploy/app", null, null, null]);
});

test("sourceBuild API parsing uses the canonical repository path contract", () => {
  const valid = {
    commands: [{ argv: ["bun", "run", "build"], workingDirectory: "web" }],
    outputs: ["web/dist/app.js"],
  };
  expect(sourceBuildValue(valid)).toEqual(valid);

  for (const invalidPath of [
    ".",
    " web/dist/app.js",
    "web//dist/app.js",
    "web/../dist/app.js",
    "web\\dist\\app.js",
    "C:relative",
    "web/\u0000dist/app.js",
    "web\ndist/app.js",
    "web\u007fdist/app.js",
    "web\u2028dist/app.js",
    "web\u2029dist/app.js",
  ]) {
    expect(
      sourceBuildValue({
        commands: [{ argv: ["bun", "run", "build"] }],
        outputs: [invalidPath],
      }),
    ).toBeUndefined();
  }
});

test("InstallConfig accepts an operator-defined presentation hint", () => {
  expect(
    variablePresentationValue([
      {
        name: "region",
        format: "operator.region-picker.v1",
        label: { ja: "リージョン", en: "Region" },
      },
    ]),
  ).toEqual([
    {
      name: "region",
      format: "operator.region-picker.v1",
      label: { ja: "リージョン", en: "Region" },
    },
  ]);
});

test("Store icon metadata accepts only safe HTTPS or repository-relative paths", () => {
  const store = (iconUrl: string) =>
    installConfigStoreValue({
      source: { url: "https://github.com/example/app.git", path: "." },
      order: 1,
      surface: "apps",
      kind: "app",
      provider: "Example",
      suggestedName: "example",
      badge: { ja: "例", en: "Example" },
      name: { ja: "例", en: "Example" },
      description: { ja: "説明", en: "Description" },
      iconUrl,
    });
  expect(store("https://assets.example.test/icon.svg")?.iconUrl).toBe(
    "https://assets.example.test/icon.svg",
  );
  expect(store("public/icon.svg")?.iconUrl).toBe("public/icon.svg");
  for (const invalid of [
    "javascript:alert(1)",
    "data:image/svg+xml;base64,abc",
    "https://user:secret@assets.example.test/icon.svg",
    "https://assets.example.test/icon.svg?client_secret=abc",
    "public/icon.svg?token=abc",
    "../secret.svg",
    "//evil.example/icon.svg",
  ]) {
    expect(store(invalid)).toBeUndefined();
  }
});

test("Store deployment profiles accept only the exact bounded public shape", () => {
  const base = {
    source: { url: "https://github.com/example/app.git", path: "." },
    order: 1,
    surface: "apps",
    kind: "app",
    provider: "Example",
    suggestedName: "example",
    badge: { ja: "例", en: "Example" },
    name: { ja: "例", en: "Example" },
    description: { ja: "説明", en: "Description" },
  };
  const deploymentProfile = {
    key: "managed-v1",
    label: { ja: "おまかせ", en: "Managed" },
    description: { ja: "Takosumi hosted service", en: "Takosumi hosted service" },
    order: 10,
    recommended: true,
    management: {
      kind: "external_console",
      href: "https://console.takoserver.com/",
      label: { ja: "管理", en: "Manage" },
    },
  };

  expect(
    installConfigStoreValue({ ...base, deploymentProfile }),
  ).toMatchObject({ deploymentProfile });

  for (const invalid of [
    { ...deploymentProfile, key: "" },
    { ...deploymentProfile, key: "   " },
    { ...deploymentProfile, key: "managed\u0000v1" },
    { ...deploymentProfile, key: "x".repeat(129) },
    { ...deploymentProfile, label: { ja: "おまかせ" } },
    { ...deploymentProfile, description: { ja: "", en: "" } },
    { ...deploymentProfile, order: Number.POSITIVE_INFINITY },
    { ...deploymentProfile, recommended: "yes" },
    { ...deploymentProfile, management: { ...deploymentProfile.management, href: "http://x" } },
    { ...deploymentProfile, management: { ...deploymentProfile.management, kind: "inline" } },
    { ...deploymentProfile, modulePath: "deploy/managed" },
  ]) {
    expect(
      installConfigStoreValue({ ...base, deploymentProfile: invalid }),
    ).toBeUndefined();
  }
});
