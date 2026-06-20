/**
 * Client-handled external install link parsing. The link only PRE-FILLS the
 * add form (never installs); these tests pin both link forms and the
 * browser-safe guards.
 */
import { describe, expect, test } from "bun:test";
import { capsuleNameFromUrl, parseInstallPrefill } from "../../../../dashboard/src/lib/install-link.ts";

describe("parseInstallPrefill", () => {
  test("parses the simple git/ref/path form", () => {
    expect(
      parseInstallPrefill(
        "?git=https://github.com/acme/repo.git&ref=main&path=deploy",
      ),
    ).toEqual({
      git: "https://github.com/acme/repo.git",
      ref: "main",
      path: "deploy",
    });
  });

  test("parses the packed source=git:: module-address form", () => {
    expect(
      parseInstallPrefill(
        "?source=" +
          encodeURIComponent(
            "git::https://github.com/acme/repo.git//deploy?ref=main",
          ),
      ),
    ).toEqual({
      git: "https://github.com/acme/repo.git",
      ref: "main",
      path: "deploy",
    });
  });

  test("ref and path are optional", () => {
    expect(
      parseInstallPrefill("?git=https://github.com/acme/repo.git"),
    ).toEqual({ git: "https://github.com/acme/repo.git", ref: "", path: "" });
  });

  test("refuses to seed the form from unsafe or absent links", () => {
    // no params at all
    expect(parseInstallPrefill("")).toBeUndefined();
    // https only — ssh / scp-like / http are not browser-safe link material
    expect(
      parseInstallPrefill("?git=ssh%3A%2F%2Fgit%40github.com%2Facme%2Frepo"),
    ).toBeUndefined();
    expect(
      parseInstallPrefill("?git=git%40github.com%3Aacme%2Frepo.git"),
    ).toBeUndefined();
    expect(
      parseInstallPrefill("?git=http%3A%2F%2Fexample.com%2Frepo.git"),
    ).toBeUndefined();
    // embedded credentials never reach the form
    expect(
      parseInstallPrefill(
        "?git=" + encodeURIComponent("https://user:secret@github.com/a/b.git"),
      ),
    ).toBeUndefined();
    expect(
      parseInstallPrefill(
        "?git=" +
          encodeURIComponent("https://github.com/acme/repo.git\nLocation: /"),
      ),
    ).toBeUndefined();
    // junk
    expect(parseInstallPrefill("?git=nonsense")).toBeUndefined();
  });
});

describe("capsuleNameFromUrl", () => {
  test("uses the last path segment without .git", () => {
    expect(capsuleNameFromUrl("https://github.com/acme/repo.git")).toEqual(
      "repo",
    );
    expect(capsuleNameFromUrl("https://github.com/acme/talk")).toEqual("talk");
  });
});
