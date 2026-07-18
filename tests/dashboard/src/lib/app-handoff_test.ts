import { describe, expect, test } from "bun:test";
import {
  appendAppHandoff,
  appHandoffFromSearch,
  appHandoffProductLabel,
  createAppHandoffConnectHref,
} from "../../../../dashboard/src/lib/app-handoff.ts";

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
    ]) {
      expect(appHandoffFromSearch(search)).toBeUndefined();
    }
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
