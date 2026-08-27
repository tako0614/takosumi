/**
 * Client-handled external install link parsing. The link only PRE-FILLS the
 * add form (never installs); these tests pin both link forms and the
 * browser-safe guards.
 */
import { describe, expect, test } from "bun:test";
import {
  capsuleNameFromUrl,
  hasInstallPrefillParams,
  isSafeHttpsGitUrl,
  parseInstallPrefill,
  parseInstallPrefillFromInput,
} from "../../../../dashboard/src/lib/install-link.ts";

describe("parseInstallPrefill", () => {
  test("parses the simple git/ref/path form", () => {
    expect(
      parseInstallPrefill(
        "?git=https://github.com/acme/repo.git&ref=main&path=deploy",
      ),
    ).toEqual({
      git: "https://github.com/acme/repo.git",
      ref: "main",
      sourcePath: ".",
      path: "deploy",
    });
  });

  test("keeps the Git subtree distinct from the selected module hint", () => {
    expect(
      parseInstallPrefill(
        "?git=https://github.com/acme/repo.git&ref=main&sourcePath=infra&path=deploy%2Fselected",
      ),
    ).toEqual({
      git: "https://github.com/acme/repo.git",
      ref: "main",
      sourcePath: "infra",
      path: "deploy/selected",
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
      sourcePath: ".",
      path: "deploy",
    });
  });

  test("ref and path are optional", () => {
    expect(
      parseInstallPrefill("?git=https://github.com/acme/repo.git"),
    ).toEqual({
      git: "https://github.com/acme/repo.git",
      ref: "",
      sourcePath: ".",
      path: "",
    });
  });

  test("rejects unknown side channels instead of partially adopting a link", () => {
    expect(
      parseInstallPrefill(
        "?git=https://github.com/acme/repo.git&ref=main&path=deploy&var.project_name=takos-space&var.domain=app.example.com&var.region=ap-northeast-1&var.account_id=acc_123&var.cloudflare.workers_subdomain=team",
      ),
    ).toBeUndefined();
  });

  test("parses a safe optional Capsule name prefill", () => {
    expect(
      parseInstallPrefill(
        "?git=https://github.com/acme/repo.git&ref=main&path=deploy&name=Customer%20API",
      ),
    ).toEqual({
      git: "https://github.com/acme/repo.git",
      ref: "main",
      sourcePath: ".",
      path: "deploy",
      name: "Customer API",
    });
  });

  test("rejects an unsafe optional Capsule name prefill", () => {
    expect(
      parseInstallPrefill(
        "?git=https://github.com/acme/repo.git&name=Customer%0AAPI",
      ),
    ).toBeUndefined();
  });

  test("never adopts secret or structured values from an install URL", () => {
    expect(
      parseInstallPrefill(
        "?git=https://github.com/acme/repo.git&var.secret=hidden&var.api_key=hidden&var.bad-name=bad&var.cloudflare.api_token=hidden&var.multiline=line%0Abreak&var.zone_id=zone_123&var.project_name=visible&varjson.cloudflare=%7B%22api_token%22%3A%22hidden%22%7D&varjson.enabled=not-json",
      ),
    ).toBeUndefined();
    expect(({} as { readonly polluted?: boolean }).polluted).toBeUndefined();
  });

  test("rejects non-canonical, duplicate, and ambiguous coordinates", () => {
    for (const search of [
      "?git=https://github.com/acme/repo.git&sourcePath=./infra",
      "?git=https://github.com/acme/repo.git&sourcePath=infra%2F..%2Fother",
      "?git=https://github.com/acme/repo.git&sourcePath=%2Finfra",
      "?git=https://github.com/acme/repo.git&path=deploy%2F%2Fselected",
      "?git=https://github.com/acme/repo.git&path=deploy%5Cselected",
      "?git=https://github.com/acme/repo.git&git=https://github.com/acme/other.git",
      "?git=https://github.com/acme/repo.git&source=git%3A%3Ahttps%3A%2F%2Fgithub.com%2Facme%2Fother.git",
      "?source=git%3A%3Ahttps%3A%2F%2Fgithub.com%2Facme%2Frepo.git%2F%2Fdeploy%3Fref%3Dmain&path=other",
      "?git=https://github.com/acme/repo.git&ref=main&ref=other",
      "?git=https://github.com/acme/repo.git&unknown=value",
    ]) {
      expect(parseInstallPrefill(search), search).toBeUndefined();
    }
  });

  test("refuses to pre-fill the form from unsafe or absent links", () => {
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
          encodeURIComponent(
            "https://github.com/acme/repo.git?token=secret",
          ),
      ),
    ).toBeUndefined();
    expect(
      parseInstallPrefill(
        "?git=" +
          encodeURIComponent("https://github.com/acme/repo.git#fragment"),
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

describe("isSafeHttpsGitUrl", () => {
  test("the shared UI guard rejects URL credential side channels", () => {
    expect(isSafeHttpsGitUrl("https://github.com/acme/repo.git")).toBe(true);
    expect(
      isSafeHttpsGitUrl("https://github.com/acme/repo.git?token=secret"),
    ).toBe(false);
    expect(
      isSafeHttpsGitUrl("https://github.com/acme/repo.git#fragment"),
    ).toBe(false);
  });
});

describe("hasInstallPrefillParams", () => {
  test("detects rejected install-prefill attempts separately from normal visits", () => {
    expect(hasInstallPrefillParams("")).toBe(false);
    expect(hasInstallPrefillParams("?tab=catalog")).toBe(false);
    expect(hasInstallPrefillParams("?git=nonsense")).toBe(true);
    expect(hasInstallPrefillParams("?source=git%3A%3Anonsense")).toBe(true);
  });
});

describe("parseInstallPrefillFromInput", () => {
  test("unwraps a full external install URL pasted into the add form", () => {
    expect(
      parseInstallPrefillFromInput(
        "https://app-staging.takosumi.com/install?git=https%3A%2F%2Fgithub.com%2Ftako0614%2Ftakos.git&ref=b7544ac7890f5c85e6b55d1f869d81f809da3953&path=deploy%2Fopentofu&name=Takos",
      ),
    ).toEqual({
      git: "https://github.com/tako0614/takos.git",
      ref: "b7544ac7890f5c85e6b55d1f869d81f809da3953",
      sourcePath: ".",
      path: "deploy/opentofu",
      name: "Takos",
    });
  });

  test("leaves a plain Git URL on the normal input path", () => {
    expect(
      parseInstallPrefillFromInput("https://github.com/acme/repo.git"),
    ).toBeUndefined();
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
