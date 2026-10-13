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

  test("run stages read as review and deploy, never the engine's nouns", () => {
    // The add flow, workload detail and connections screens had drifted back
    // to "Approve Plan", "Plan Run", "SourceSnapshot" and "runner capability".
    // The product names the stages 変更の確認 / review and デプロイ / deploy
    // (see `op.*`). Lower-case "plan" and プラン stay allowed: a pricing plan
    // is ordinary product language.
    const blocked: readonly (string | RegExp)[] = [
      /\bPlan\b/,
      "Plan run",
      "Apply run",
      "Apply 実行",
      "SourceSnapshot",
      "coordinator",
      "永続記録",
      "provider policy",
      "runner capability",
      "Run approval",
      "Recipe",
      "state 境界",
      "state boundary",
      "root module",
      "module path",
    ];
    for (const [locale, messages] of [
      ["ja", ja],
      ["en", en],
    ] as const) {
      for (const [key, value] of Object.entries(messages)) {
        for (const term of blocked) {
          const leaked =
            typeof term === "string" ? value.includes(term) : term.test(value);
          expect({ locale, key, term: String(term), leaked }).toEqual({
            locale,
            key,
            term: String(term),
            leaked: false,
          });
        }
      }
    }
  });

  test("the install flow keeps one verb for adding a service", () => {
    // tests/dashboard/src/views/store/store-browser-ui_test.ts already forbids
    // インストール in the store's own table: the card, the progress line, the
    // done line and the error line all say 追加, so a button on another verb
    // made one click read as two different actions. The shared dictionary kept
    // four installStore keys on the other verb, outside that guard's reach.
    const keys = (Object.keys(ja) as (keyof typeof ja)[]).filter(
      (key) =>
        key.startsWith("installStore.") ||
        key.startsWith("account.installTarget."),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const value = ja[key];
      expect({ key, value }).not.toEqual(
        expect.objectContaining({ value: expect.stringContaining("インストール") }),
      );
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
