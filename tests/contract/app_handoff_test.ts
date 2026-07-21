import { describe, expect, test } from "bun:test";
import {
  appendTakosumiAppHandoff,
  createTakosumiAppConnectHref,
  createTakosumiAppHandoffUrl,
  isSafeLinkHref,
  parseTakosumiAppProductKey,
  parseTakosumiAppReturnUri,
  takosumiAppHandoffFromSearch,
} from "../../contract/app-handoff.ts";

describe("Takosumi App Handoff contract", () => {
  test("builds OpenTofu-native handoff URLs from plain source coordinates", () => {
    expect(
      createTakosumiAppHandoffUrl({
        baseUrl: "https://operator.example/install",
        product: "notes-app",
        returnUri: "notesapp://connect",
        git: "https://github.com/acme/notes.git",
        ref: "v1.2.3",
        path: "deploy/opentofu",
        name: "Notes",
      }),
    ).toBe(
      "https://operator.example/install?product=notes-app&return_uri=notesapp%3A%2F%2Fconnect&git=https%3A%2F%2Fgithub.com%2Facme%2Fnotes.git&ref=v1.2.3&path=deploy%2Fopentofu&name=Notes",
    );
  });

  test("builds ordinary install URLs without client handoff params", () => {
    expect(
      createTakosumiAppHandoffUrl({
        baseUrl: "https://operator.example/install",
        git: "https://github.com/acme/notes.git",
        ref: "main",
        path: "deploy/opentofu",
      }),
    ).toBe(
      "https://operator.example/install?git=https%3A%2F%2Fgithub.com%2Facme%2Fnotes.git&ref=main&path=deploy%2Fopentofu",
    );
  });

  test("never carries a caller-selected service-side InstallConfig", () => {
    const url = createTakosumiAppHandoffUrl({
      baseUrl:
        "https://operator.example/install?installConfigId=cfg_base&var.secret=hidden&varjson.runtime=%7B%7D",
      git: "https://github.com/acme/notes.git",
      installConfigId: "cfg_attacker_selected",
    } as Parameters<typeof createTakosumiAppHandoffUrl>[0] & {
      installConfigId: string;
    });
    expect(new URL(url).searchParams.has("installConfigId")).toBe(false);
    expect(new URL(url).searchParams.has("var.secret")).toBe(false);
    expect(new URL(url).searchParams.has("varjson.runtime")).toBe(false);
  });

  test("rejects product-only URLs because product is not an install target", () => {
    expect(() =>
      createTakosumiAppHandoffUrl({
        baseUrl: "https://operator.example/install",
        product: "notes-app",
      }),
    ).toThrow("App handoff URL requires git or source.");
    expect(() =>
      createTakosumiAppHandoffUrl({
        baseUrl: "https://operator.example/install",
        git: "https://github.com/acme/notes.git",
        product: "notes-app",
      }),
    ).toThrow("App handoff return_uri is invalid.");
    expect(() =>
      createTakosumiAppHandoffUrl({
        baseUrl: "https://operator.example/install",
        git: "https://github.com/acme/notes.git",
        source: "git::https://github.com/acme/other.git//.",
      }),
    ).toThrow("exactly one of git or source");
  });

  test("parses product keys and return URIs with conservative URL rules", () => {
    expect(parseTakosumiAppProductKey("vendor.chat")).toBe("vendor.chat");
    expect(parseTakosumiAppProductKey("Vendor")).toBeUndefined();
    expect(parseTakosumiAppReturnUri("notesapp://connect")).toBe(
      "notesapp://connect",
    );
    expect(parseTakosumiAppReturnUri("https://app.example/connect")).toBe(
      "https://app.example/connect",
    );
    expect(
      parseTakosumiAppReturnUri("http://app.example/connect"),
    ).toBeUndefined();
    expect(
      parseTakosumiAppReturnUri("https://app.example/connect?debug=1"),
    ).toBeUndefined();
  });

  test("rejects script-capable return URI schemes in their authority form", () => {
    // `javascript:alert(1)` was already rejected for lacking `://`, but the
    // authority form parses cleanly and still executes: the connect payload
    // appended by createTakosumiAppConnectHref lands after the `//` comment.
    for (const raw of [
      "javascript://x/%0Aalert(1)//",
      "JavaScript://x/%0Aalert(1)//",
      "vbscript://x/%0Amsgbox(1)//",
      "data://text/html,<script>alert(1)</script>",
      "blob://x/y",
      "file://host/etc/passwd",
    ]) {
      expect(parseTakosumiAppReturnUri(raw)).toBeUndefined();
      expect(isSafeLinkHref(raw)).toBe(false);
    }
    // Ordinary client schemes and in-app paths stay usable.
    expect(isSafeLinkHref("notesapp://connect")).toBe(true);
    expect(isSafeLinkHref("https://app.example/connect")).toBe(true);
    expect(isSafeLinkHref("/runs/run_1")).toBe(true);
    expect(isSafeLinkHref(undefined)).toBe(false);
  });

  test("round-trips dashboard paths and connect payloads", () => {
    const handoff = takosumiAppHandoffFromSearch(
      "?product=notes-app&return_uri=https%3A%2F%2Fapp.example%2Fconnect",
    );

    expect(appendTakosumiAppHandoff("/runs/run_1", handoff)).toBe(
      "/runs/run_1?product=notes-app&return_uri=https%3A%2F%2Fapp.example%2Fconnect",
    );
    expect(
      createTakosumiAppConnectHref({
        handoff: handoff!,
        hostUrl: "https://host.example/path",
        runId: "run_1",
        capsuleId: "cap_1",
      }),
    ).toBe(
      "https://app.example/connect?host_url=https%3A%2F%2Fhost.example&product=notes-app&run_id=run_1&capsule_id=cap_1",
    );
  });
});
