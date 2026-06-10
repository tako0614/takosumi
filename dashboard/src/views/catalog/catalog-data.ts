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
 * running the real compatibility analyzer
 * `src/service/domains/sources/capsule_compatibility.ts` against the exact git
 * path with the exact policy that flows at install time, NOT by assumption):
 *   - `installable: true` is set ONLY when the analyzer returns a level other
 *     than `unsupported` (ready / auto_capsulized / needs_patch), so `/install`'s
 *     `canContinue()` actually enables. Today that is FOUR entries:
 *       · cloudflare-r2-storage     -> `ready`            (cloudflare_r2_bucket)
 *       · aws-s3-storage            -> `auto_capsulized`  (aws_s3_bucket)
 *         Both pass under the instance-wide DEFAULT policy (no installConfigId).
 *       · cloudflare-static-site    -> `ready`       under the curated, BOUNDED
 *         InstallConfig `cfg-official-cloudflare-static-site`
 *         (allowedResourceTypes: ["cloudflare_pages_project"]).
 *       · cloudflare-worker-service -> `needs_patch` under the curated, BOUNDED
 *         InstallConfig `cfg-official-talk`
 *         (allowedResourceTypes: ["cloudflare_workers_script",
 *         "cloudflare_workers_script_subdomain"]); the only finding is a `file()`
 *         build-artifact warning, NOT an error, so `canContinue()` enables.
 *     The last two need a resource type that is NOT in the instance-wide DEFAULT
 *     allowlist, so they carry an `installConfigId` and the deep link pins it.
 *     CRITICAL: the global default allowlist (DEFAULT_ALLOWED_RESOURCE_TYPES) is
 *     NEVER widened — each curated config's bounded `allowedResourceTypes` is
 *     UNIONed with the default only while THAT config is in effect, scoped to
 *     exactly that vetted first-party module, and is re-enforced at plan/apply.
 *   - `installable: false` entries render as "準備中" (coming-soon) cards with NO
 *     install button. Two honest reasons:
 *       (a) The Capsule is real but no SAFE bounded curated InstallConfig exists
 *           that makes it one-click installable. Verified case:
 *             · takos  (cloudflare_d1_database/_queue/_workers_kv_namespace, plus
 *               it needs a separate wrangler step after `tofu apply`, so a single
 *               Takosumi apply is not enough). Self-host via `tofu apply` + one
 *               wrangler step is the supported path for takos today.
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
   * Curated, service-side InstallConfig id this entry installs through. Present
   * ONLY for installable entries whose module needs a resource type outside the
   * instance-wide DEFAULT allowlist but is a vetted first-party Capsule: the
   * compatibility check (and later plan/apply) is gated against this config's
   * BOUNDED `allowedResourceTypes`, scoped to exactly this module. The default
   * allowlist is never widened — see the honesty/security contract above. When
   * absent (e.g. r2/s3, which already pass under the default policy) the install
   * flow just uses the Space's first available InstallConfig profile.
   *
   * These ids are seeded by `officialInstallConfigs()` (official_seed.ts):
   *   · cfg-official-cloudflare-static-site -> allowedResourceTypes
   *       ["cloudflare_pages_project"]
   *   · cfg-official-talk (the worker-service template alias) -> allowedResourceTypes
   *       ["cloudflare_workers_script", "cloudflare_workers_script_subdomain"]
   */
  readonly installConfigId?: string;
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
  /**
   * Set when applying this entry requires a cloud-provider connection the user
   * may not have yet. The view turns this into an actionable `<A href="/connections">`
   * link ("先に <label> に接続する") so a non-engineer is not left wondering WHERE
   * to connect. `provider` is the {@link Connection} `provider` key used to
   * detect whether such a connection already exists; `label` is the plain
   * display name shown in the link text.
   */
  readonly requiresConnection?: { readonly provider: string; readonly label: string };
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
    requiresConnection: { provider: "cloudflare", label: "Cloudflare" },
  },
  // HONESTY: this module uses `cloudflare_pages_project`, which is NOT in the
  // instance-wide DEFAULT allowlist (so the default-policy check returns
  // `unsupported`). It IS a vetted first-party Capsule, so it installs through
  // the curated, BOUNDED InstallConfig `cfg-official-cloudflare-static-site`
  // (allowedResourceTypes: ["cloudflare_pages_project"]). VERIFIED by running
  // the real analyzer with that bounded policy -> `ready` (no errors). The
  // global default allowlist is unchanged; the allowance is scoped to this one
  // config and re-enforced at plan/apply.
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
    installable: true,
    installConfigId: "cfg-official-cloudflare-static-site",
    note: "適用には Cloudflare の接続が必要です。",
    requiresConnection: { provider: "cloudflare", label: "Cloudflare" },
  },
  // HONESTY: this module uses `cloudflare_workers_script` (in the default
  // allowlist) AND `cloudflare_workers_script_subdomain` (NOT in the default
  // allowlist), so the default-policy check returns `unsupported`. It IS a
  // vetted first-party Capsule, so it installs through the curated, BOUNDED
  // InstallConfig `cfg-official-talk` (the worker-service template alias;
  // allowedResourceTypes: ["cloudflare_workers_script",
  // "cloudflare_workers_script_subdomain"]). VERIFIED by running the real
  // analyzer with that bounded policy -> `needs_patch` (only a `file()` build-
  // artifact warning, NOT `unsupported`), so `canContinue()` enables. The
  // global default allowlist is unchanged.
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
    installable: true,
    installConfigId: "cfg-official-talk",
    note: "適用には Cloudflare の接続が必要です。",
    requiresConnection: { provider: "cloudflare", label: "Cloudflare" },
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
    requiresConnection: { provider: "aws", label: "AWS" },
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
  // Curated entries pin their bounded InstallConfig so the compatibility check
  // (and plan/apply) is gated against that module's minimal allowlist instead of
  // only the instance-wide default. Omitted when the module already passes under
  // the default policy (r2/s3).
  if (entry.installConfigId) {
    params.set("installConfig", entry.installConfigId);
  }
  return `/install?${params.toString()}`;
}
