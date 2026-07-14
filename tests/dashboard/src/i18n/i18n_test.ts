/**
 * Locale-parity tests. The TypeScript constraint (`en: Record<keyof typeof ja,
 * string>`) already forces the KEY sets to match at compile time; these tests
 * additionally lock in that every `{param}` placeholder used by one locale is
 * present in the other, so an interpolation can never silently render a raw
 * `{name}` in one language only.
 */
import { describe, expect, test } from "bun:test";
import { ja } from "../../../../dashboard/src/i18n/ja.ts";
import { en } from "../../../../dashboard/src/i18n/en.ts";

function placeholders(message: string): readonly string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

describe("i18n dictionaries", () => {
  test("ja and en share the same key set", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  test("every key uses the same placeholders in both locales", () => {
    for (const key of Object.keys(ja) as (keyof typeof ja)[]) {
      expect({ key, params: placeholders(en[key]) }).toEqual({
        key,
        params: placeholders(ja[key]),
      });
    }
  });

  test("no empty messages", () => {
    for (const key of Object.keys(ja) as (keyof typeof ja)[]) {
      expect(ja[key].length).toBeGreaterThan(0);
      expect(en[key].length).toBeGreaterThan(0);
    }
  });

  test("public dashboard copy does not expose implementation-only terms", () => {
    // OpenTofu Output is a normal user-facing OpenTofu concept. Keep internal
    // service configuration and policy jargon out of the consumer copy, but
    // do not hide the boundary between ordinary Outputs and Interfaces.
    const blockedTerms = ["InstallConfig", "fail-closed"];

    for (const [locale, messages] of [
      ["ja", ja],
      ["en", en],
    ] as const) {
      for (const [key, value] of Object.entries(messages)) {
        for (const term of blockedTerms) {
          expect({ locale, key, term, value }).not.toEqual(
            expect.objectContaining({ value: expect.stringContaining(term) }),
          );
        }
      }
    }
  });

  test("standalone dashboard copy does not brand itself as Takos", () => {
    for (const [locale, messages] of [
      ["ja", ja],
      ["en", en],
    ] as const) {
      for (const [key, value] of Object.entries(messages)) {
        if (key === "nav.backToTakos") continue;
        expect({ locale, key, value }).not.toEqual(
          expect.objectContaining({ value: expect.stringContaining("Takos ") }),
        );
        expect({ locale, key, value }).not.toEqual(
          expect.objectContaining({
            value: expect.stringContaining("Takos に"),
          }),
        );
      }
    }
  });
});
