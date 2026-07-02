import { describe, expect, test } from "bun:test";
import {
  appendTakosumiAppHandoff,
  createTakosumiAppConnectHref,
  createTakosumiAppHandoffUrl,
  parseTakosumiAppProductKey,
  parseTakosumiAppReturnUri,
  takosumiAppHandoffFromSearch,
} from "../../contract/app-handoff.ts";

describe("Takosumi App Handoff contract", () => {
  test("builds OpenTofu-native handoff URLs from plain source coordinates", () => {
    expect(
      createTakosumiAppHandoffUrl({
        product: "notes-app",
        returnUri: "notesapp://connect",
        git: "https://github.com/acme/notes.git",
        ref: "v1.2.3",
        path: "deploy/opentofu",
        name: "Notes",
        vars: { project_name: "notes-prod" },
      }),
    ).toBe(
      "https://app.takosumi.com/install?product=notes-app&return_uri=notesapp%3A%2F%2Fconnect&git=https%3A%2F%2Fgithub.com%2Facme%2Fnotes.git&ref=v1.2.3&path=deploy%2Fopentofu&name=Notes&var.project_name=notes-prod",
    );
  });

  test("builds ordinary install URLs without client handoff params", () => {
    expect(
      createTakosumiAppHandoffUrl({
        git: "https://github.com/acme/notes.git",
        ref: "main",
        path: "deploy/opentofu",
      }),
    ).toBe(
      "https://app.takosumi.com/install?git=https%3A%2F%2Fgithub.com%2Facme%2Fnotes.git&ref=main&path=deploy%2Fopentofu",
    );
  });

  test("rejects product-only URLs because product is not an install target", () => {
    expect(() => createTakosumiAppHandoffUrl({ product: "notes-app" })).toThrow(
      "App handoff URL requires git, source, or installConfigId.",
    );
    expect(() =>
      createTakosumiAppHandoffUrl({
        git: "https://github.com/acme/notes.git",
        product: "notes-app",
      }),
    ).toThrow("App handoff return_uri is invalid.");
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
