/**
 * Vocabulary gate for the app, install and run surfaces, including the run
 * operation names (op.*) that also appear inside notification sentences
 * (TASK-0115).
 *
 * The thing a person installs is an app (アプリ); a launchable Interface is a
 * screen (画面); what it makes in the cloud are resources (リソース); credentials
 * are connections (接続). Changes are reviewed (内容を確認) and applied only by
 * "Allow and install / update / apply". The old nouns and verbs — service,
 * workload, deploy, publish, reflect — must not come back on these surfaces.
 */
import { describe, expect, test } from "bun:test";
import { en } from "../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../dashboard/src/i18n/ja.ts";

const NAMESPACES = /^(app|apps|installStore|run|op|workloads?|services?|capsules?)\./u;

/**
 * Keys in these namespaces still read by another owner's surfaces; they move
 * with those surfaces (apps.add: notifications and activity empty states).
 */
const OTHER_OWNER_KEYS = new Set<string>(["apps.add"]);

// 非公開 (private) and 公開リポジトリ (public repository) are ordinary words.
// A workspace is a スペース / space in the UI.
const BANNED_JA = /サービス|ワークロード|デプロイ|(?<!非)公開(?!リポジトリ)|反映|ワークスペース/u;
const BANNED_EN = /\b(?:services?|workloads?|deploy(?:s|ed|ing|ment)?|workspaces?)\b/iu;

const keys = (Object.keys(ja) as Array<keyof typeof ja>).filter(
  (key) => NAMESPACES.test(key) && !OTHER_OWNER_KEYS.has(key),
);

describe("app, install and run vocabulary", () => {
  test("covers the app page, Home, install and run surfaces", () => {
    expect(keys.some((key) => key.startsWith("app."))).toBe(true);
    expect(keys.some((key) => key.startsWith("apps."))).toBe(true);
    expect(keys.some((key) => key.startsWith("installStore."))).toBe(true);
    expect(keys.some((key) => key.startsWith("run."))).toBe(true);
    expect(keys.length).toBeGreaterThan(400);
  });

  test("Japanese copy says アプリ・画面・リソース・接続, never the old words", () => {
    for (const key of keys) {
      expect({ key, banned: BANNED_JA.test(ja[key]) ? ja[key] : null }).toEqual({ key, banned: null });
    }
  });

  test("English copy says app, screen, resource and connection, never the old words", () => {
    for (const key of keys) {
      expect({ key, banned: BANNED_EN.test(en[key]) ? en[key] : null }).toEqual({ key, banned: null });
    }
  });

  test("the apply verbs are explicit and shared by every review", () => {
    expect(ja["installStore.allowInstall"]).toBe("許可してインストール");
    expect(ja["app.review.allowUpdate"]).toBe("許可して更新");
    expect(ja["app.review.allowApply"]).toBe("許可して適用");
    expect(ja["app.settings.review"]).toBe("内容を確認");
    expect(ja["app.version.pinReview"]).toBe("内容を確認");
    expect(ja["app.uninstall.cta"]).toBe("アンインストール");
    expect(ja["app.uninstall.cancel"]).toBe("アンインストールを取り消す");
    expect(en["app.review.allowUpdate"]).toBe("Allow and update");
    expect(en["app.review.allowApply"]).toBe("Allow and apply");
  });
});
