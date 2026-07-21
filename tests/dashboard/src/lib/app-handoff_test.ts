import { describe, expect, test } from "bun:test";
import {
  appendAppHandoff,
  appHandoffFromSearch,
  appHandoffProductLabel,
  createAppHandoffConnectHref,
  installHandoffTarget,
} from "../../../../dashboard/src/lib/app-handoff.ts";
import {
  createTakosumiAppInstallScheme,
  parseTakosumiAppInstallScheme,
} from "takosumi-contract";

describe("Takosumi App Handoff", () => {
  test("parses typed app return targets from Host Center query params", () => {
    expect(
      appHandoffFromSearch(
        "?product=notes-app&return_uri=notesapp%3A%2F%2Fconnect",
      ),
    ).toEqual({
      product: "notes-app",
      returnUri: "notesapp://connect",
    });
    expect(
      appHandoffFromSearch(
        "product=vendor.chat&return_uri=https%3A%2F%2Fchat.example%2Fconnect",
      ),
    ).toEqual({
      product: "vendor.chat",
      returnUri: "https://chat.example/connect",
    });
  });

  test("rejects ambiguous or unsafe return targets", () => {
    for (const search of [
      "",
      "?product=Notes&return_uri=notesapp%3A%2F%2Fconnect",
      "?product=notes/app&return_uri=notesapp%3A%2F%2Fconnect",
      "?product=notes-app&return_uri=http%3A%2F%2Fexample.com%2Fconnect",
      "?product=notes-app&return_uri=notesapp%3A%2F%2Fconnect%3Fdebug%3D1",
      "?product=notes-app&return_uri=notesapp%3A%2F%2Fconnect%23debug",
      "?product=notes-app&return_uri=javascript%3Aalert(1)",
      // Authority form: the URL parser keeps `javascript:` as the protocol and
      // the appended connect payload lands after the `//` line comment, so the
      // anchor would execute in the dashboard origin.
      "?product=notes-app&return_uri=javascript%3A%2F%2Fx%2F%250Aalert(1)%2F%2F",
      "?product=notes-app&return_uri=vbscript%3A%2F%2Fx%2F%250Amsgbox(1)%2F%2F",
      "?product=notes-app&return_uri=data%3A%2F%2Ftext%2Fhtml%2C%3Cscript%3E1%3C%2Fscript%3E",
    ]) {
      expect(appHandoffFromSearch(search)).toBeUndefined();
    }
  });

  test("never hands a script-capable connect href to an anchor", () => {
    // Defence in depth for the two run-screen anchors: even if a return_uri
    // reached the handoff record, the connect href must not become an href.
    expect(
      createAppHandoffConnectHref(
        {
          product: "notes-app",
          returnUri: "javascript://x/%0Aalert(1)//",
        },
        "https://app.takosumi.example",
      ),
    ).toBeUndefined();
    expect(
      createAppHandoffConnectHref(
        { product: "notes-app", returnUri: "notesapp://connect" },
        "https://app.takosumi.example",
      ),
    ).toBe(
      "notesapp://connect?host_url=https%3A%2F%2Fapp.takosumi.example&product=notes-app",
    );
  });

  test("appends the handoff to local dashboard paths only", () => {
    const handoff = {
      product: "notes-app",
      returnUri: "notesapp://connect",
    };

    expect(appendAppHandoff("/runs/run_1", handoff)).toEqual(
      "/runs/run_1?product=notes-app&return_uri=notesapp%3A%2F%2Fconnect",
    );
    expect(
      appendAppHandoff("/new?git=https%3A%2F%2Fexample.com", handoff),
    ).toEqual(
      "/new?git=https%3A%2F%2Fexample.com&product=notes-app&return_uri=notesapp%3A%2F%2Fconnect",
    );
    expect(appendAppHandoff("//evil.example/new", handoff)).toEqual(
      "//evil.example/new",
    );
    expect(appendAppHandoff("https://evil.example/new", handoff)).toEqual(
      "https://evil.example/new",
    );
  });

  test("creates connect links only for HTTPS host URLs", () => {
    const handoff = {
      product: "notes-app",
      returnUri: "notesapp://connect",
    };
    const href = createAppHandoffConnectHref(
      handoff,
      "https://community.example/path?debug=1",
    );
    expect(href).toBe(
      "notesapp://connect?host_url=https%3A%2F%2Fcommunity.example&product=notes-app",
    );
    expect(new URL(href ?? "").searchParams.get("host_url")).toBe(
      "https://community.example",
    );
    expect(
      createAppHandoffConnectHref(handoff, "http://example.com"),
    ).toBeUndefined();
    expect(
      createAppHandoffConnectHref(handoff, "javascript:alert(1)"),
    ).toBeUndefined();
  });

  test("formats arbitrary product keys for dashboard copy", () => {
    expect(appHandoffProductLabel("notes-app")).toBe("Notes App");
    expect(appHandoffProductLabel("vendor.chat")).toBe("Vendor Chat");
  });
});

describe("web+takosumi: install scheme", () => {
  test("builds the opaque form and round-trips the git/ref/path/name payload", () => {
    const scheme = createTakosumiAppInstallScheme({
      git: "https://github.com/acme/repo.git",
      ref: "main",
      path: "deploy/opentofu",
      name: "Customer API",
    });
    // Opaque form: scheme + `install` action in the pathname, never `//install`.
    const url = new URL(scheme);
    expect(url.protocol).toBe("web+takosumi:");
    expect(url.pathname).toBe("install");
    expect(parseTakosumiAppInstallScheme(scheme)).toEqual({
      git: "https://github.com/acme/repo.git",
      ref: "main",
      path: "deploy/opentofu",
      name: "Customer API",
    });
  });

  test("round-trips a git URL containing :// ? and & through double-encoding", () => {
    const git = "https://host.example/a/b?token=x&y=z";
    const scheme = createTakosumiAppInstallScheme({ git });
    // Simulate the browser's registerProtocolHandler `%s` substitution
    // (component percent-encode) and the landing decode.
    const handoffParam = encodeURIComponent(scheme);
    const landed = new URL(
      `https://app.takosumi.com/install?handoff=${handoffParam}`,
    );
    const decoded = landed.searchParams.get("handoff") ?? "";
    expect(parseTakosumiAppInstallScheme(decoded)).toEqual({ git });
  });

  test("carries product/return_uri together and round-trips them", () => {
    const scheme = createTakosumiAppInstallScheme({
      git: "https://github.com/acme/repo.git",
      product: "notes-app",
      returnUri: "notesapp://connect",
    });
    expect(parseTakosumiAppInstallScheme(scheme)).toEqual({
      git: "https://github.com/acme/repo.git",
      product: "notes-app",
      returnUri: "notesapp://connect",
    });
  });

  test("builder rejects both or neither of git/source", () => {
    expect(() =>
      createTakosumiAppInstallScheme({
        git: "https://github.com/a/b.git",
        source: "git::https://github.com/a/b.git",
      }),
    ).toThrow();
    expect(() => createTakosumiAppInstallScheme({})).toThrow();
  });

  test("parser rejects the wrong scheme, wrong action, and unsafe payloads", () => {
    expect(
      parseTakosumiAppInstallScheme("https://app.takosumi.com/install?git=x"),
    ).toBeUndefined();
    // authority form lands the keyword in host, not the `install` action
    expect(
      parseTakosumiAppInstallScheme(
        "web+takosumi://install?git=https%3A%2F%2Fgithub.com%2Fa%2Fb.git",
      ),
    ).toBeUndefined();
    expect(
      parseTakosumiAppInstallScheme("web+takosumi:uninstall?git=x"),
    ).toBeUndefined();
    // CR/LF/NUL screen on the whole decoded string (covers ref/path)
    expect(
      parseTakosumiAppInstallScheme(
        "web+takosumi:install?git=https%3A%2F%2Fgithub.com%2Fa%2Fb.git&ref=main%0AX",
      ),
    ).toBeUndefined();
    // neither git nor source
    expect(
      parseTakosumiAppInstallScheme("web+takosumi:install?name=x"),
    ).toBeUndefined();
    // product without return_uri
    expect(
      parseTakosumiAppInstallScheme(
        "web+takosumi:install?git=https%3A%2F%2Fgithub.com%2Fa%2Fb.git&product=notes-app",
      ),
    ).toBeUndefined();
    // over the 4096 length cap
    expect(
      parseTakosumiAppInstallScheme(
        "web+takosumi:install?git=https%3A%2F%2Fgithub.com%2F" +
          "a".repeat(5000),
      ),
    ).toBeUndefined();
  });

  test("installHandoffTarget rebuilds a fresh /new query and drops non-whitelist params", () => {
    const scheme = createTakosumiAppInstallScheme({
      git: "https://github.com/acme/repo.git",
      name: "Customer API",
    });
    // An attacker appends the auto-install trigger + a rogue store handoff
    // INSIDE the scheme; none are whitelisted, so they must not survive.
    const poisoned = `${scheme}&auto=1&tcsBase=https%3A%2F%2Fevil.example&tcsListing=x`;
    const target = installHandoffTarget(poisoned);
    const url = new URL(target, "https://app.takosumi.com");
    expect(url.pathname).toBe("/new");
    expect(url.searchParams.get("git")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(url.searchParams.get("name")).toBe("Customer API");
    expect(url.searchParams.get("auto")).toBeNull();
    expect(url.searchParams.get("tcsBase")).toBeNull();
    expect(url.searchParams.get("tcsListing")).toBeNull();
  });

  test("installHandoffTarget falls back to bare /new on an invalid payload", () => {
    expect(installHandoffTarget("not-a-scheme")).toBe("/new");
    expect(installHandoffTarget("web+takosumi:install?name=only")).toBe("/new");
  });
});
