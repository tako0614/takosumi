import { describe, expect, test } from "bun:test";
import { CATALOG } from "../../../dashboard/src/catalog.ts";

describe("dashboard catalog", () => {
  test("curated install entries are pinned to immutable refs", () => {
    for (const entry of CATALOG) {
      expect(entry.ref, entry.id).toMatch(/^[0-9a-f]{40}$/);
      expect(["main", "latest", "HEAD"]).not.toContain(entry.ref);
    }
  });

  test("product distributions are not generic Takosumi starter cards", () => {
    expect(CATALOG.map((entry) => entry.id)).not.toContain("takos");
  });

  test("starter copy does not imply a public URL is always produced", () => {
    const hello = CATALOG.find(
      (entry) => entry.id === "cloudflare-hello-worker",
    );
    expect(hello?.description.en.toLowerCase()).toContain("connection-test");
    expect(hello?.description.en.toLowerCase()).toContain("route/dispatcher");
    expect(hello?.description.en.toLowerCase()).not.toContain(
      "public url is output",
    );
  });
});
