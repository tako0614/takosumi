import { describe, expect, test } from "bun:test";
import { metaString } from "../../../../dashboard/src/lib/activity-metadata.ts";

describe("metaString", () => {
  test("returns non-empty and whitespace strings unchanged", () => {
    const metadata = {
      value: "recorded value",
      whitespace: "   ",
    };

    expect(metaString(metadata, "value")).toBe("recorded value");
    expect(metaString(metadata, "whitespace")).toBe("   ");
  });

  test("returns undefined for empty, missing, and non-string values", () => {
    const metadata: Record<string, unknown> = {
      empty: "",
      nullValue: null,
      number: 42,
      object: { value: "nested" },
    };

    expect(metaString(metadata, "empty")).toBeUndefined();
    expect(metaString(metadata, "missing")).toBeUndefined();
    expect(metaString(metadata, "nullValue")).toBeUndefined();
    expect(metaString(metadata, "number")).toBeUndefined();
    expect(metaString(metadata, "object")).toBeUndefined();
  });
});
