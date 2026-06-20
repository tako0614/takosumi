import { describe, expect, test } from "bun:test";
import { installReturnContext } from "../../../../dashboard/src/lib/install-return-context.ts";

describe("installReturnContext", () => {
  test("extracts a safe /new git prefill for the sign-in screen", () => {
    expect(
      installReturnContext(
        "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy%2Fopentofu",
      ),
    ).toEqual({
      git: "https://github.com/acme/worker.git",
      ref: "main",
      path: "deploy/opentofu",
      label: "worker",
      host: "github.com",
      sourceLabel: "github.com/acme/worker",
      displayRef: "main",
    });
  });

  test("supports packed OpenTofu module source links", () => {
    expect(
      installReturnContext(
        "/new?source=" +
          encodeURIComponent(
            "git::https://github.com/acme/app.git//infra?ref=v1.2.3",
          ),
      ),
    ).toMatchObject({
      git: "https://github.com/acme/app.git",
      ref: "v1.2.3",
      path: "infra",
      label: "app",
      host: "github.com",
      sourceLabel: "github.com/acme/app",
      displayRef: "v1.2.3",
    });
  });

  test("keeps sign-in install context readable for pinned commit links", () => {
    expect(
      installReturnContext(
        "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=e343560dc63bb0440614da2589169404d8543efa&path=deploy%2Fopentofu",
      ),
    ).toMatchObject({
      sourceLabel: "github.com/acme/worker",
      ref: "e343560dc63bb0440614da2589169404d8543efa",
      displayRef: "e343560d",
      path: "deploy/opentofu",
    });
  });

  test("rejects non-install returns and unsafe source material", () => {
    for (const value of [
      undefined,
      null,
      "",
      "/",
      "/installations",
      "/new",
      "https://evil.example/new?git=https://github.com/acme/app.git",
      "//evil.example/new?git=https://github.com/acme/app.git",
      "/new?git=http%3A%2F%2Fexample.com%2Facme%2Fapp.git",
      "/new?git=https%3A%2F%2Fuser%3Asecret%40github.com%2Facme%2Fapp.git",
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fapp.git%0ALocation%3A%20evil",
    ]) {
      expect(installReturnContext(value)).toBeUndefined();
    }
  });
});
