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
});
