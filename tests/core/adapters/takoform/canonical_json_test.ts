import { expect, test } from "bun:test";
import { parseCanonicalJson } from "../../../../core/adapters/takoform/canonical_json.ts";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test("strict I-JSON nesting limit is exactly 128 containers", () => {
  const arrayAtLimit = "[".repeat(128) + "]".repeat(128);
  const parsed = parseCanonicalJson(bytes(arrayAtLimit));
  expect(Array.isArray(parsed)).toBe(true);

  const arrayOverLimit = "[".repeat(129) + "]".repeat(129);
  expect(() => parseCanonicalJson(bytes(arrayOverLimit))).toThrow(
    "JSON nesting exceeds 128 containers",
  );

  const objectAtLimit = '{"a":'.repeat(127) + '{"a":1}' + "}".repeat(127);
  expect(parseCanonicalJson(bytes(objectAtLimit))).toBeDefined();

  const objectOverLimit = '{"a":'.repeat(128) + '{"a":1}' + "}".repeat(128);
  expect(() => parseCanonicalJson(bytes(objectOverLimit))).toThrow(
    "JSON nesting exceeds 128 containers",
  );
});
