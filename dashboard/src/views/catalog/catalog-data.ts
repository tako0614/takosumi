/**
 * Curated install catalog ("アプリを選んで入れる" front door).
 *
 * The dashboard's only first input used to be a raw Git URL, which is a hard
 * wall for non-engineers. This module is the curated, client-side list of
 * entries a visitor can browse and install with one click. Each `installable`
 * entry deep-links into the existing `/install` flow with `git` / `ref` / `path`
 * pre-filled (the InstallFromGitView `readPrefill()` reader picks them up), so a
 * user never types a Git URL by hand.
 *
 * HONESTY CONTRACT (load-bearing — each installable claim was VERIFIED by
 * running the real default-policy compatibility analyzer
 * `src/service/domains/sources/capsule_compatibility.ts` against the exact git
 * path, NOT by assumption):
 *   - `installable: true` is set ONLY when that analyzer returns a level other
 *     than `unsupported` (ready / auto_capsulized / needs_patch), so `/install`'s
 *     `canContinue()` actually enables. Today that is exactly TWO entries:
 *       · cloudflare-r2-storage -> `ready`            (cloudflare_r2_bucket)
 *       · aws-s3-storage        -> `auto_capsulized`  (aws_s3_bucket)
 *     Both use only providers/resources in the default allowlist and plan
 *     credential-free, so the install button is live, not dead.
 *   - `installable: false` entries render as "準備中" (coming-soon) cards with NO
 *     install button. Two honest reasons:
 *       (a) The Capsule is real but the DEFAULT install policy returns
 *           `unsupported` for it (would be a dead button). Verified cases:
 *             · takos                     (cloudflare_d1_database/_queue/_workers_kv_namespace)
 *             · cloudflare-static-site    (cloudflare_pages_project)
 *             · cloudflare-worker-service (cloudflare_workers_script_subdomain)
 *           Self-host via `tofu apply` is the supported path for takos today.
 *       (b) It is NOT yet a standalone Takosumi Capsule at all — the bundled
 *           Takos apps (yurucommu / road-to-me / takos-docs / -slide / -excel /
 *           -computer) ship only a `takos_app_manifest` `outputs.tf` with no
 *           `terraform {}` / `provider {}` / `resource {}` blocks. They are
 *           Takos *product* apps consumed by the Takos in-product installer, not
 *           Takosumi Git-URL Capsules, so `/install` would provision nothing.
 *
 * Git URLs are taken verbatim from the ecosystem `.gitmodules` remotes (never
 * fabricated):
 *   - takos      -> https://github.com/tako0614/takos.git
 *   - takosumi   -> https://github.com/tako0614/takosumi.git   (first-party modules)
 *   - yurucommu  -> https://github.com/tako0614/yurucommu.git
 *   - road-to-me -> https://github.com/tako0614/road-to-me.git
 *   - takos-docs / -slide / -excel / -computer -> .../<name>.git
 */

/**
 * NOTE: this module is deliberately icon-free (no `lucide-solid` import). The
 * lucide-solid package evaluates a client-only SolidJS API at module load, which
 * throws under a non-DOM `bun test` runner. Keeping the catalog DATA importable
 * without pulling in icons lets `catalog-data_test.ts` run as a pure-logic test.
 * Icons are resolved by `iconKey` in `CatalogView.tsx` (the client-only view).
 */

/** Broad grouping shown as a section + filter chip in the catalog view. */
export type CatalogCategory = "takos" | "storage" | "compute" | "app";

/** Icon keys resolved to lucide-solid components in the view (client-only). */
export type CatalogIconKey =
  // entry icons
  | "chat"
  | "r2"
  | "site"
  | "worker"
  | "s3"
  | "users"
  | "rocket"
  | "docs"
  | "slide"
  | "excel"
  | "computer"
  // category icons
  | "sparkles"
  | "database"
  | "server"
  | "boxes";

export interface CatalogEntry {
  /** Stable id (also used as a test/QA anchor). */
  readonly id: string;
  /** Plain-Japanese display name for non-engineers. */
  readonly title: string;
  /** One-line plain-Japanese description. No internal jargon up front. */
  readonly summary: string;
  readonly category: CatalogCategory;
  /** Icon key resolved to a lucide-solid component in the view. */
  readonly icon: CatalogIconKey;
  /** Git remote (verbatim from .gitmodules). */
  readonly gitUrl: string;
  /** Default branch ref to install from. */
  readonly ref: string;
  /** Module path inside the repo (the OpenTofu Capsule root). */
  readonly path: string;
  /**
   * True ONLY when this resolves to a genuine, Gate-passing OpenTofu Capsule.
   * False renders a coming-soon card with no install button.
   */
  readonly installable: boolean;
  /**
   * Shown on coming-soon cards to explain (plainly) why it is not yet
   * one-click installable. Omitted for installable entries.
   */
  readonly comingSoonReason?: string;
  /**
   * Optional plain-Japanese note about what the user still needs (e.g. a cloud
   * connection) AFTER picking install. Shown as a small hint, never blocks the
   * button. Kept honest so the user is not surprised at the credential step.
   */
  readonly note?: string;
}

const TAKOS_GIT = "https://github.com/tako0614/takos.git";
const TAKOSUMI_GIT = "https://github.com/tako0614/takosumi.git";
const YURUCOMMU_GIT = "https://github.com/tako0614/yurucommu.git";
const ROAD_TO_ME_GIT = "https://github.com/tako0614/road-to-me.git";
const TAKOS_DOCS_GIT = "https://github.com/tako0614/takos-docs.git";
const TAKOS_SLIDE_GIT = "https://github.com/tako0614/takos-slide.git";
const TAKOS_EXCEL_GIT = "https://github.com/tako0614/takos-excel.git";
const TAKOS_COMPUTER_GIT = "https://github.com/tako0614/takos-computer.git";

/**
 * The curated catalog. Order is "most useful first": Takos itself, then the
 * first-party storage/compute building blocks, then the coming-soon apps.
 * `installable` is set per the VERIFIED honesty contract above (only the two
 * default-policy-passing storage modules are live install buttons today).
 */
export const CATALOG: readonly CatalogEntry[] = [
  // ---- Takos (the flagship self-host Capsule) -----------------------------
  // HONESTY: verified with the real default-policy compatibility analyzer
  // (capsule_compatibility.ts) — the takos Capsule uses cloudflare_d1_database
  // / cloudflare_queue / cloudflare_workers_kv_namespace, which are NOT in the
  // default allowedResourceTypes, so the Git-URL compatibility check returns
  // `unsupported`. Showing an install button here would be a DEAD button. Until
  // the default install policy allows those resource types, this stays
  // coming-soon (self-host via `tofu apply` is the supported path today).
  {
    id: "takos",
    title: "Takos 本体",
    summary:
      "チャットと AI エージェントを備えた Takos 本体。今は自分のインフラへの導入（tofu apply）で動かせます。",
    category: "takos",
    icon: "chat",
    gitUrl: TAKOS_GIT,
    ref: "main",
    path: "deploy/opentofu",
    installable: false,
    comingSoonReason:
      "Takos 本体は D1 / Queue / KV など多くの部品を使うため、ワンクリック導入の対応は準備中です（現在は自分のインフラへの導入で動かせます）。",
  },

  // ---- First-party building blocks (genuine OpenTofu modules) -------------
  {
    id: "cloudflare-r2-storage",
    title: "ファイル置き場（Cloudflare R2）",
    summary:
      "Cloudflare R2 にファイル保存用のバケットを 1 つ作るシンプルな部品です。",
    category: "storage",
    icon: "r2",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/cloudflare-r2-storage/module",
    installable: true,
    note: "適用には Cloudflare の接続が必要です。",
  },
  // HONESTY: verified `unsupported` under the default policy — the Pages module
  // uses `cloudflare_pages_project`, not in the default allowedResourceTypes.
  // Coming-soon (no install button) until the default policy allows it.
  {
    id: "cloudflare-static-site",
    title: "静的サイト公開（Cloudflare Pages）",
    summary:
      "Cloudflare Pages の公開プロジェクトを作り、静的サイトを置けるようにします。",
    category: "compute",
    icon: "site",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/cloudflare-static-site/module",
    installable: false,
    comingSoonReason:
      "Cloudflare Pages の部品は、ワンクリック導入の対応が準備中です。",
  },
  // HONESTY: verified `unsupported` under the default policy — uses
  // `cloudflare_workers_script_subdomain`, not in the default allowlist.
  {
    id: "cloudflare-worker-service",
    title: "小さなサーバー（Cloudflare Worker）",
    summary:
      "Cloudflare 上に Worker（小さなサーバー）を 1 つ立てるための部品です。",
    category: "compute",
    icon: "worker",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/cloudflare-worker-service/module",
    installable: false,
    comingSoonReason:
      "Cloudflare Worker の部品は、ワンクリック導入の対応が準備中です。",
  },
  {
    id: "aws-s3-storage",
    title: "ファイル置き場（AWS S3）",
    summary: "AWS S3 にファイル保存用のバケットを 1 つ作るシンプルな部品です。",
    category: "storage",
    icon: "s3",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/aws-s3-storage/module",
    installable: true,
    note: "適用には AWS の接続が必要です。",
  },

  // ---- Coming-soon apps (Takos product apps, not yet standalone Capsules) --
  {
    id: "yurucommu",
    title: "ゆるコミュ",
    summary: "ゆるくつながるコミュニティ向けの SNS アプリ。",
    category: "app",
    icon: "users",
    gitUrl: YURUCOMMU_GIT,
    ref: "master",
    path: ".",
    installable: false,
    comingSoonReason:
      "現在は Takos 本体に同梱されるアプリです。Takosumi 単体で入れられる Capsule は準備中です。",
  },
  {
    id: "road-to-me",
    title: "Road to Me",
    summary: "目標づくりと振り返りを助ける独立アプリ。",
    category: "app",
    icon: "rocket",
    gitUrl: ROAD_TO_ME_GIT,
    ref: "master",
    path: ".",
    installable: false,
    comingSoonReason:
      "Takosumi 単体で入れられる Capsule は準備中です。今は紹介のみ表示しています。",
  },
  {
    id: "takos-docs",
    title: "Takos ドキュメント",
    summary: "ドキュメントを書いて共有するためのアプリ。",
    category: "app",
    icon: "docs",
    gitUrl: TAKOS_DOCS_GIT,
    ref: "master",
    path: ".",
    installable: false,
    comingSoonReason:
      "現在は Takos 本体に同梱されるアプリです。Takosumi 単体 Capsule は準備中です。",
  },
  {
    id: "takos-slide",
    title: "Takos スライド",
    summary: "プレゼン用のスライドを作るアプリ。",
    category: "app",
    icon: "slide",
    gitUrl: TAKOS_SLIDE_GIT,
    ref: "master",
    path: ".",
    installable: false,
    comingSoonReason:
      "現在は Takos 本体に同梱されるアプリです。Takosumi 単体 Capsule は準備中です。",
  },
  {
    id: "takos-excel",
    title: "Takos 表計算",
    summary: "表計算（スプレッドシート）のアプリ。",
    category: "app",
    icon: "excel",
    gitUrl: TAKOS_EXCEL_GIT,
    ref: "master",
    path: ".",
    installable: false,
    comingSoonReason:
      "現在は Takos 本体に同梱されるアプリです。Takosumi 単体 Capsule は準備中です。",
  },
  {
    id: "takos-computer",
    title: "Takos コンピュータ",
    summary: "サンドボックスで安全にコードを動かせるアプリ。",
    category: "app",
    icon: "computer",
    gitUrl: TAKOS_COMPUTER_GIT,
    ref: "master",
    path: ".",
    installable: false,
    comingSoonReason:
      "現在は Takos 本体に同梱されるアプリです。Takosumi 単体 Capsule は準備中です。",
  },
];

/** Plain-Japanese label for each category (section heading + filter chip). */
export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  takos: "Takos 本体",
  storage: "ファイル置き場",
  compute: "サーバー・サイト",
  app: "アプリ（準備中）",
};

/** Display order for category sections. */
export const CATEGORY_ORDER: readonly CatalogCategory[] = [
  "takos",
  "storage",
  "compute",
  "app",
];

/** Category icon keys, resolved to components in the view (client-only). */
export const CATEGORY_ICON_KEY: Record<CatalogCategory, CatalogIconKey> = {
  takos: "sparkles",
  storage: "database",
  compute: "server",
  app: "boxes",
};

/**
 * Build the `/install` deep link for an installable entry. The path-route
 * `readPrefill()` in InstallFromGitView reads `git` / `ref` / `path` from
 * `location.search`, so this is the exact pre-fill contract.
 *
 * Exported (and pure) so the catalog unit test can assert the link shape
 * without a DOM.
 */
export function installHref(entry: CatalogEntry): string {
  const params = new URLSearchParams();
  params.set("git", entry.gitUrl);
  params.set("ref", entry.ref);
  params.set("path", entry.path);
  return `/install?${params.toString()}`;
}
