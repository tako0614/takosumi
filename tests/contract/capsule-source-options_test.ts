import { expect, test } from "bun:test";
import {
  capsuleSourceOptionInstallSearch,
  parseCapsuleSourceOptionsInstallLink,
  parseCapsuleSourceOptionsText,
} from "../../contract/capsule-source-options.ts";

const valid = JSON.stringify({
  apiVersion: "install.takosumi.com/v1alpha1",
  kind: "CapsuleSourceOptions",
  metadata: { name: "starter", title: "Choose a starter" },
  options: [
    {
      id: "basic",
      title: "Basic",
      source: {
        url: "https://github.com/example/basic.git",
        path: "deploy/opentofu",
      },
    },
  ],
});

test("CapsuleSourceOptions accepts the closed presentation-only shape", () => {
  const parsed = parseCapsuleSourceOptionsText(valid);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.options[0]).toEqual({
    id: "basic",
    title: "Basic",
    source: {
      url: "https://github.com/example/basic.git",
      path: "deploy/opentofu",
    },
  });
});

test("CapsuleSourceOptions rejects execution, provider, and unknown fields", () => {
  for (const field of ["providers", "interfaces", "dependencies", "install"]) {
    const value = JSON.parse(valid);
    value[field] = [];
    const parsed = parseCapsuleSourceOptionsText(JSON.stringify(value));
    expect(parsed).toEqual({
      ok: false,
      error: `contains unsupported field ${field}`,
    });
  }
});

test("CapsuleSourceOptions rejects duplicate ids and embedded credentials", () => {
  const duplicate = JSON.parse(valid);
  duplicate.options.push(duplicate.options[0]);
  expect(parseCapsuleSourceOptionsText(JSON.stringify(duplicate))).toEqual({
    ok: false,
    error: "options[1].id must be unique",
  });
  const credentials = JSON.parse(valid);
  credentials.options[0].source.url =
    "https://token@example.com/example/basic.git";
  expect(parseCapsuleSourceOptionsText(JSON.stringify(credentials)).ok).toBe(
    false,
  );

  const absolutePath = JSON.parse(valid);
  absolutePath.options[0].source.path = "/";
  expect(parseCapsuleSourceOptionsText(JSON.stringify(absolutePath)).ok).toBe(
    false,
  );
});

test("install link parser requires kind, HTTPS Git, and a safe JSON path", () => {
  const search =
    "?kind=capsule-source-options&git=https%3A%2F%2Fgithub.com%2Fexample%2Fcatalog.git&path=install%2Foptions.json";
  expect(parseCapsuleSourceOptionsInstallLink(search)).toEqual({
    git: "https://github.com/example/catalog.git",
    path: "install/options.json",
  });
  expect(
    parseCapsuleSourceOptionsInstallLink(
      "?kind=capsule-source-options&git=https://github.com/example/catalog.git&path=../options.json",
    ),
  ).toBeUndefined();
});

test("selected option handoff is an ordinary /new prefill", () => {
  const parsed = parseCapsuleSourceOptionsText(valid);
  if (!parsed.ok) throw new Error(parsed.error);
  const search = capsuleSourceOptionInstallSearch(
    parsed.document.options[0]!,
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(new URLSearchParams(search).get("ref")).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
  expect(search).not.toContain("kind=capsule-source-options");
});
