/**
 * Vocabulary gate for the app, install and run surfaces (TASK-0115).
 *
 * The thing a person installs is an app (アプリ); a launchable Interface is a
 * screen (画面); what it makes in the cloud are resources (リソース); credentials
 * are connections (接続); a workspace is a スペース in Japanese and a workspace
 * in English (Space and Installation are retired English aliases). Changes are
 * reviewed (内容を確認) and applied only by "Allow and install / update /
 * apply". The old nouns and verbs — service, workload, deploy, publish,
 * reflect — must not come back on these surfaces.
 *
 * Two checks: whole namespaces these surfaces own (including the run
 * operation names and run/control error sentences that also appear inside
 * problem cards and notifications), and every key the surfaces and the
 * helpers they call actually reference, whatever its namespace.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../dashboard/src/i18n/ja.ts";

type Key = keyof typeof ja;

const NAMESPACES =
  /^(app|apps|installStore|run|runError|runGroup|op|new|controlError|error|policy|status\.run|status\.capsule|workloads?|services?|capsules?)\./u;

// 非公開 (private) and 公開リポジトリ (public repository) are ordinary words.
const BANNED_JA = /サービス|ワークロード|デプロイ|(?<!非)公開(?!リポジトリ)|反映|ワークスペース/u;
const BANNED_EN = /\b(?:services?|workloads?|deploy(?:s|ed|ing|ment)?)\b/iu;
// Retired English aliases, case-sensitive like check:generalization-boundaries.
const RETIRED_EN = /\b(?:Installation|Space)\b/u;

const root = resolve(import.meta.dir, "../../../../dashboard/src");
const SURFACE_FILES = [
  ...readdirSync(resolve(root, "views/app"))
    .filter((file) => /\.tsx?$/u.test(file))
    .map((file) => `views/app/${file}`),
  "views/apps/AppListView.tsx",
  ...readdirSync(resolve(root, "views/new"))
    .filter((file) => /\.tsx?$/u.test(file))
    .map((file) => `views/new/${file}`),
  "views/runs/RunView.tsx",
  "views/runs/RunGroupView.tsx",
  "components/run/PlanResourceList.tsx",
  "components/run/CostSummary.tsx",
  "components/run/PolicyReasonList.tsx",
  // Helpers whose sentences these surfaces show.
  "lib/run-errors.ts",
  "lib/labels.ts",
  "lib/error-copy.ts",
  "lib/capsule-uninstall.ts",
  "lib/run-plan-resources.ts",
  "lib/capsules-ui.ts",
  "lib/app-page.ts",
  "lib/policy-reasons.ts",
];
const surfaceSource = SURFACE_FILES.map((file) => readFileSync(resolve(root, file), "utf8")).join("\n");

function offenders(keys: readonly Key[]): readonly { key: Key; ja?: string; en?: string }[] {
  return keys.flatMap((key) => {
    const badJa = BANNED_JA.test(ja[key]);
    const badEn = BANNED_EN.test(en[key]) || RETIRED_EN.test(en[key]);
    return badJa || badEn
      ? [{ key, ...(badJa ? { ja: ja[key] } : {}), ...(badEn ? { en: en[key] } : {}) }]
      : [];
  });
}

const namespaceKeys = (Object.keys(ja) as Key[]).filter(
  (key) => NAMESPACES.test(key),
);
const renderedKeys = (Object.keys(ja) as Key[]).filter(
  (key) => surfaceSource.includes(`"${key}"`),
);

describe("app, install and run vocabulary", () => {
  test("covers the app page, Home, install and run surfaces", () => {
    for (const prefix of ["app.", "apps.", "installStore.", "run.", "runError.", "op."]) {
      expect(namespaceKeys.some((key) => key.startsWith(prefix)), prefix).toBe(true);
    }
    expect(namespaceKeys.length).toBeGreaterThan(450);
    // The scan sees keys reached through helpers, e.g. a failed run's hint.
    expect(renderedKeys).toContain("runError.applyFailed");
    expect(renderedKeys).toContain("op.apply");
    expect(renderedKeys.length).toBeGreaterThan(400);
  });

  test("namespaces these surfaces own use only the app vocabulary", () => {
    expect(offenders(namespaceKeys)).toEqual([]);
  });

  test("every string these surfaces render uses only the app vocabulary", () => {
    expect(offenders(renderedKeys)).toEqual([]);
  });

  test("the apply verbs are explicit and shared by every review", () => {
    expect(ja["installStore.allowInstall"]).toBe("許可してインストール");
    expect(ja["app.review.allowUpdate"]).toBe("許可して更新");
    expect(ja["app.review.allowApply"]).toBe("許可して適用");
    expect(ja["app.settings.review"]).toBe("内容を確認");
    expect(ja["app.version.pinReview"]).toBe("内容を確認");
    expect(ja["app.uninstall.cta"]).toBe("アンインストール");
    expect(ja["app.uninstall.cancel"]).toBe("アンインストールを取り消す");
    // A failed apply's hint is the next step; the card's headline says what failed.
    expect(ja["runError.applyFailed"]).toBe("理由とログを確認してから、もう一度お試しください。");
    expect(en["runError.applyFailed"]).toBe("Check the reason and logs, then try again.");
    expect(en["app.review.allowUpdate"]).toBe("Allow and update");
    expect(en["app.review.allowApply"]).toBe("Allow and apply");
  });
});
