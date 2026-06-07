import { expect, test } from "bun:test";

import { parseInstallLink, parseInstallSourceParam } from "./install-link.ts";

test("packed source form parses url//path?ref canonical example", () => {
  const link = new URL(
    "https://app.takosumi.com/install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main",
  );
  expect(parseInstallLink(link)).toEqual({
    url: "https://git.example.com/takos/talk.git",
    ref: "main",
    path: "deploy",
  });
});

test("packed source form without path defaults to '.'", () => {
  const target = parseInstallSourceParam(
    "git::https://git.example.com/takos/talk.git?ref=v1.2.3",
  );
  expect(target).toEqual({
    url: "https://git.example.com/takos/talk.git",
    ref: "v1.2.3",
    path: ".",
  });
});

test("packed source form without ref yields empty ref and accepts top-level fallback", () => {
  expect(
    parseInstallSourceParam(
      "git::https://git.example.com/takos/talk.git//deploy",
    ),
  ).toEqual({
    url: "https://git.example.com/takos/talk.git",
    ref: "",
    path: "deploy",
  });
  const link = new URL(
    "https://app.takosumi.com/install?source=git::https://git.example.com/takos/talk.git//deploy&ref=main",
  );
  expect(parseInstallLink(link)?.ref).toBe("main");
});

test("scheme '//' is not mistaken for the path separator", () => {
  const target = parseInstallSourceParam("git::https://host/repo.git");
  expect(target?.url).toBe("https://host/repo.git");
  expect(target?.path).toBe(".");
});

test("scp-style ssh address parses (no scheme '://')", () => {
  const target = parseInstallSourceParam(
    "git::git@git.example.com:company/internal-chat.git//deploy?ref=main",
  );
  expect(target).toEqual({
    url: "git@git.example.com:company/internal-chat.git",
    ref: "main",
    path: "deploy",
  });
});

test("simple git=&ref=&path= form parses", () => {
  const link = new URL(
    "https://app.takosumi.com/install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy",
  );
  expect(parseInstallLink(link)).toEqual({
    url: "https://git.example.com/takos/talk.git",
    ref: "main",
    path: "deploy",
  });
});

test("simple form defaults: missing ref -> empty, missing path -> '.'", () => {
  const link = new URL(
    "https://app.takosumi.com/install?git=https://git.example.com/takos/talk.git",
  );
  expect(parseInstallLink(link)).toEqual({
    url: "https://git.example.com/takos/talk.git",
    ref: "",
    path: ".",
  });
});

test("malformed inputs yield undefined, never throw", () => {
  expect(parseInstallSourceParam("https://no-prefix.example/repo.git")).toBe(
    undefined,
  );
  expect(parseInstallSourceParam("git::")).toBe(undefined);
  expect(parseInstallLink(new URL("https://app.takosumi.com/install"))).toBe(
    undefined,
  );
  expect(
    parseInstallLink(new URL("https://app.takosumi.com/install?git=")),
  ).toBe(undefined);
});
