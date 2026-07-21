/**
 * Locale-parity tests. The TypeScript constraint (`en: Record<keyof typeof ja,
 * string>`) already forces the KEY sets to match at compile time; these tests
 * additionally lock in that every `{param}` placeholder used by one locale is
 * present in the other, so an interpolation can never silently render a raw
 * `{name}` in one language only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ja } from "../../../../dashboard/src/i18n/ja.ts";
import { en } from "../../../../dashboard/src/i18n/en.ts";

const here = dirname(fileURLToPath(import.meta.url));

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
    // Internal ledger nouns, migration-compatibility aliases and retired public
    // vocabulary must never be the words a user reads. `Resource Shape` is a
    // documented migration alias and `SpacePolicy`/`TargetPool` are host-side
    // types — all three used to be the settings-hub description of a nav card.
    const blockedTerms = [
      "InstallConfig",
      "fail-closed",
      "Capsule",
      "TargetPool",
      "SpacePolicy",
      "Resource Shape",
      "OpenTofu",
      "Terraform",
    ];
    // "any OpenTofu / Terraform provider runs" is the product's actual promise
    // on the bring-your-own-key screen — naming the ecosystem there is the
    // point, not a leak.
    const allowed = new Set(["conn.byok.body"]);

    for (const [locale, messages] of [
      ["ja", ja],
      ["en", en],
    ] as const) {
      for (const [key, value] of Object.entries(messages)) {
        if (allowed.has(key)) continue;
        for (const term of blockedTerms) {
          expect({ locale, key, term, value }).not.toEqual(
            expect.objectContaining({ value: expect.stringContaining(term) }),
          );
        }
      }
    }
  });

  test("no dictionary key is left behind by removed UI", () => {
    // Key-set parity is compile-enforced, but nothing caught copy whose SCREEN
    // was deleted — 10 such keys had accumulated, including a copy-to-clipboard
    // label with no clipboard code and an API-keys tab that no longer exists.
    const roots = ["views", "lib", "components", "i18n"];
    const sources = roots
      .flatMap((root) =>
        [
          ...new Bun.Glob("**/*.{ts,tsx}").scanSync({
            cwd: resolve(here, `../../../../dashboard/src/${root}`),
            absolute: true,
          }),
        ].filter(
          (file) => !file.endsWith("/ja.ts") && !file.endsWith("/en.ts"),
        ),
      )
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    // Families composed at runtime (`billing.usage.kind.${kind}`) cannot be
    // found by a literal scan; their prefix is what the code references.
    const dynamicPrefixes = ["billing.usage.kind."];
    const unreferenced = Object.keys(ja).filter(
      (key) =>
        !sources.includes(key) &&
        !dynamicPrefixes.some((prefix) => key.startsWith(prefix)),
    );
    expect(unreferenced).toEqual([]);
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
