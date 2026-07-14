import { describe, expect, test } from "bun:test";
import {
  installReturnContext,
  installReturnPathFromPrefill,
  installReturnPathFromReturnParam,
  providerConnectionsHrefForInstallReturn,
} from "../../../../dashboard/src/lib/install-return-context.ts";

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
      "/services",
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

  test("builds a canonical /new return path from current install fields", () => {
    const returnPath = installReturnPathFromPrefill({
      git: "https://github.com/acme/worker.git",
      ref: "main",
      path: "deploy/opentofu",
    });
    expect(returnPath).toEqual(
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy%2Fopentofu",
    );
    expect(installReturnContext(returnPath)).toMatchObject({
      git: "https://github.com/acme/worker.git",
      ref: "main",
      path: "deploy/opentofu",
      label: "worker",
    });
  });

  test("omits ref when the flow uses the Git default branch", () => {
    const returnPath = installReturnPathFromPrefill({
      git: "https://github.com/acme/worker.git",
      ref: "",
      path: "deploy/opentofu",
    });
    expect(returnPath).toEqual(
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&path=deploy%2Fopentofu",
    );
    expect(installReturnContext(returnPath)).toMatchObject({
      git: "https://github.com/acme/worker.git",
      ref: "",
      path: "deploy/opentofu",
      label: "worker",
    });
  });

  test("drops OpenTofu variable side channels from canonical return paths", () => {
    const returnPath = installReturnPathFromReturnParam(
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy%2Fopentofu&varjson.cloudflare=%7B%7D&varjson.enable_cloudflare_resources=true&var.project_name=takos-space",
    );
    expect(returnPath).toEqual(
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy%2Fopentofu",
    );
    expect(installReturnContext(returnPath)).not.toHaveProperty("vars");
  });

  test("preserves the typed Capsule name through install return links", () => {
    const returnPath = installReturnPathFromPrefill({
      git: "https://github.com/acme/worker.git",
      ref: "main",
      path: "deploy/opentofu",
      name: "Customer API",
    });
    expect(returnPath).toEqual(
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy%2Fopentofu&name=Customer+API",
    );
    expect(installReturnContext(returnPath)).toMatchObject({
      git: "https://github.com/acme/worker.git",
      ref: "main",
      path: "deploy/opentofu",
      name: "Customer API",
      label: "Customer API",
    });
  });

  test("builds Provider Connections hrefs with a safe /new return parameter", () => {
    const returnPath = installReturnPathFromPrefill({
      git: "https://github.com/acme/worker.git",
      ref: "main",
      path: "deploy/opentofu",
    });
    expect(returnPath).toBeDefined();
    const href = providerConnectionsHrefForInstallReturn(returnPath);
    const url = new URL(href, "https://app.takosumi.test");

    expect(url.pathname).toEqual("/connections");
    expect(url.searchParams.get("return")).toEqual(returnPath);
    expect(
      installReturnPathFromReturnParam(url.searchParams.get("return")),
    ).toEqual(returnPath);
    expect(
      installReturnContext(url.searchParams.get("return")),
    ).not.toHaveProperty("vars");
  });

  test("keeps pinned full commit refs in Provider Connections return hrefs", () => {
    const fullRef = "e343560dc63bb0440614da2589169404d8543efa";
    const returnPath = installReturnPathFromPrefill({
      git: "https://github.com/acme/worker.git",
      ref: fullRef,
      path: "deploy/opentofu",
    });
    expect(returnPath).toContain(fullRef);

    const href = providerConnectionsHrefForInstallReturn(returnPath);
    const url = new URL(href, "https://app.takosumi.test");

    expect(url.pathname).toEqual("/connections");
    expect(url.searchParams.get("return")).toEqual(returnPath);
    expect(installReturnContext(url.searchParams.get("return"))).toMatchObject({
      ref: fullRef,
      displayRef: "e343560d",
    });
  });

  test("preserves App Handoff params through Provider Connections return hrefs", () => {
    const returnPath =
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy%2Fopentofu&product=notes-app&return_uri=notesapp%3A%2F%2Fconnect";
    const href = providerConnectionsHrefForInstallReturn(returnPath);
    const url = new URL(href, "https://app.takosumi.test");

    expect(url.pathname).toEqual("/connections");
    expect(url.searchParams.get("return")).toEqual(returnPath);
    expect(
      installReturnPathFromReturnParam(url.searchParams.get("return")),
    ).toEqual(returnPath);
  });

  test("omits return parameters for unsafe install return material", () => {
    expect(
      installReturnPathFromPrefill({
        git: "https://user:secret@github.com/acme/worker.git",
        ref: "main",
        path: "deploy/opentofu",
      }),
    ).toBeUndefined();
    expect(
      providerConnectionsHrefForInstallReturn(
        "/new?git=http%3A%2F%2Fexample.com%2Facme%2Fworker.git&ref=main&path=deploy",
      ),
    ).toEqual("/connections");
    expect(
      providerConnectionsHrefForInstallReturn(
        "//evil.example/new?git=https://github.com/acme/worker.git",
      ),
    ).toEqual("/connections");
    expect(
      installReturnPathFromReturnParam(
        "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy&product=notes-app&return_uri=http%3A%2F%2Fexample.com%2Fconnect",
      ),
    ).toEqual(
      "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fworker.git&ref=main&path=deploy",
    );
  });
});
