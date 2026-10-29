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

  test("the install actions consistently use the user's Install terminology", () => {
    // TASK-0115: two decisions, one label each. Install states the intent
    // and only "Allow and install" applies; the Plan in between is made on
    // its own, so no "Review" step label remains.
    expect(ja["installStore.install"]).toBe("インストール");
    expect(ja["installStore.allowInstall"]).toBe("許可してインストール");
    expect(ja["installStore.installing"]).toContain("インストール");
    expect(en["installStore.install"]).toBe("Install");
    expect(en["installStore.allowInstall"]).toBe("Allow and install");
    expect(Object.hasOwn(ja, "installStore.reviewChanges")).toBe(false);
    expect(Object.hasOwn(en, "installStore.reviewChanges")).toBe(false);
    expect(ja["installStore.applyWait.connections"]).toBe("接続を選ぶと確認できます");
    expect(ja["installStore.applyWait.settings"]).toBe("必須の設定を入力してください");
    expect(ja["installStore.applyWait.checking"]).toBe("確認しています…");
    expect(ja["installStore.progress.reading"]).toBe("リポジトリを読んでいます");
    expect(ja["installStore.progress.planning"]).toBe("作られるものを確認しています");
    expect(ja["installStore.progress.replanning"]).toBe("内容を作り直しています");
  });

  test("the install and app surfaces use the app vocabulary only", () => {
    // The thing a user installs is an app. Old nouns and verbs (service,
    // workload, add, deploy) must not come back into the install surface,
    // its sign-in context, or its recovery copy.
    const installKeys = (Object.keys(ja) as Array<keyof typeof ja>).filter(
      (key) => key.startsWith("installStore.") || key.startsWith("auth.install"),
    );
    expect(installKeys.length).toBeGreaterThan(50);
    for (const key of installKeys) {
      expect({ key, value: ja[key] }).not.toEqual(
        expect.objectContaining({ value: expect.stringMatching(/サービス|ワークロード|追加|デプロイ|公開(?!リポジトリ)|反映/u) }),
      );
      expect({ key, value: en[key] }).not.toEqual(
        expect.objectContaining({ value: expect.stringMatching(/\b(?:services?|workloads?|add|adding|deploy(?:ed|ing)?)\b/iu) }),
      );
    }
  });

  test("navigation, connections, account, workspace, billing and sign-in copy use the app vocabulary", () => {
    // TASK-0115: every surface says アプリ / 画面 / リソース / 接続 / スペース.
    // These namespaces belong to the navigation and account side.
    const prefixes = [
      "nav.",
      "shell.",
      "conn.",
      "account.",
      "members.",
      "workspace.",
      "billing.",
      "auth.",
      "notif.",
    ];
    const keys = (Object.keys(ja) as Array<keyof typeof ja>).filter((key) =>
      prefixes.some((prefix) => key.startsWith(prefix)),
    );
    expect(keys.length).toBeGreaterThan(300);
    for (const key of keys) {
      expect({ key, value: ja[key] }).not.toEqual(
        expect.objectContaining({
          value: expect.stringMatching(
            /ワークスペース|サービス|ワークロード|デプロイ|公開(?!リポジトリ)|反映/u,
          ),
        }),
      );
      // "Terms of Service" is the legal document's name.
      if (key === "auth.termsOfService") continue;
      expect({ key, value: en[key] }).not.toEqual(
        expect.objectContaining({
          value: expect.stringMatching(
            /\b(?:services?|workloads?|deploy(?:s|ed|ing)?)\b/iu,
          ),
        }),
      );
    }
    expect(ja["nav.connections"]).toBe("接続");
    // Account has personal connections and usage; workspace UI is retired.
    expect(Object.hasOwn(ja, "account.section.workspace")).toBe(false);
    expect(Object.hasOwn(en, "account.section.workspace")).toBe(false);
    for (const key of keys) {
      expect({ key, retiredAlias: /\bspaces?\b/iu.test(en[key]) }).toEqual({
        key,
        retiredAlias: false,
      });
    }
    // The app page is titled as an app in the top bar.
    expect(ja["nav.app"]).toBe("アプリ");
    expect(en["nav.app"]).toBe("App");
  });

  test("the settings hub, manage catalog and removed workspace tools have no copy left", () => {
    for (const removed of [
      "settings.",
      "workspaceSettings.",
      "shares.",
      "backups.",
      "interfaceRecovery.",
      "hostedResources.",
      "graph.",
      "runList.",
    ]) {
      expect({
        removed,
        keys: Object.keys(ja).filter((key) => key.startsWith(removed)),
      }).toEqual({ removed, keys: [] });
    }
    // Generated API handles never appear in copy as if they were names.
    for (const [locale, messages] of [
      ["ja", ja],
      ["en", en],
    ] as const) {
      for (const [key, value] of Object.entries(messages)) {
        expect({ locale, key, leaked: value.includes("@workspace-") }).toEqual({
          locale,
          key,
          leaked: false,
        });
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
