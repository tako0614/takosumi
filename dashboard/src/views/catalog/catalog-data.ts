/**
 * Capsule Store — a browseable, distributed list of installable Capsules.
 *
 * This is a STORE, not an "official catalog with a privileged tier". Anyone can
 * publish an OpenTofu Capsule at any Git URL and anyone can install it; this
 * client-side list is just a convenient front shelf of starting points. It has
 * NO "official" rank: Takosumi's own modules (r2 / s3 / static-site / worker)
 * sit on the shelf as ordinary entries, exactly like a third-party Capsule
 * would. We may SAY a module is made by Takosumi in its description, but that
 * never buys it a privileged install path — the install gate is the same for
 * everyone. The real entry point is "install any Capsule from any Git URL"
 * (`/install`); this shelf only saves a beginner from typing a URL by hand.
 *
 * The dashboard's only first input used to be a raw Git URL, which is a hard
 * wall for non-engineers, so each `installable` entry deep-links into the
 * existing `/install` flow with `git` / `ref` / `path` pre-filled (the
 * InstallFromGitView `readPrefill()` reader picks them up).
 *
 * HONESTY CONTRACT (load-bearing — each installable claim was VERIFIED by
 * running the real compatibility analyzer
 * `src/service/domains/sources/capsule_compatibility.ts` against the exact git
 * path with the EXACT INSTANCE-WIDE DEFAULT policy that flows at install time,
 * NOT by assumption, and NOT through any curated/privileged per-entry config):
 *   - `installable: true` is set ONLY when the analyzer returns a level other
 *     than `unsupported` (ready / auto_capsulized / needs_patch) under the plain
 *     default policy, so `/install`'s `canContinue()` actually enables and the
 *     button is live, not dead. Today that is FOUR entries, ALL passing under the
 *     default policy with NO per-entry installConfig override:
 *       · cloudflare-r2-storage     -> `ready`            (cloudflare_r2_bucket)
 *       · aws-s3-storage            -> `auto_capsulized`  (aws_s3_bucket)
 *       · cloudflare-static-site    -> `ready`            (cloudflare_pages_project)
 *       · cloudflare-worker-service -> `needs_patch`      (cloudflare_workers_script
 *         + cloudflare_workers_script_subdomain); the only finding is a `file()`
 *         build-artifact warning, NOT an error, so `canContinue()` enables.
 *     The default resource-type allowlist now covers the standard Cloudflare
 *     building blocks (an operator-level decision to make CF actually deployable),
 *     so the Store needs NO bounded per-entry InstallConfig and grants NO entry
 *     a special policy. Abuse is held back NOT by a privileged catalog but by the
 *     same boundaries every Capsule hits: the Capsule Gate (provisioners banned,
 *     dangerous resource types excluded), the managed-default provider allowlist
 *     (Cloudflare only), and billing / credit / quota.
 *   - `installable: false` entries render as "準備中" (coming-soon) cards with NO
 *     install button. Two honest reasons:
 *       (a) The Capsule is real and PASSES the default-policy gate, but a single
 *           Takosumi apply does not yield a working install. Verified case:
 *             · takos — its resource types (cloudflare_d1_database / _queue /
 *               _workers_kv_namespace / _r2_bucket) ARE in the default allowlist
 *               now, so the analyzer returns `needs_patch` (not `unsupported`),
 *               but `tofu apply` only provisions the durable infra: the worker
 *               artifact needs a SEPARATE wrangler step afterward. A one-click
 *               install would "succeed" yet leave a non-working takos, so it
 *               stays coming-soon. Self-host via `tofu apply` + one wrangler step
 *               is the supported path for takos today.
 *       (b) It is NOT yet an OpenTofu Capsule at all — the bundled Takos apps
 *           (yurucommu / road-to-me / takos-docs / -slide / -excel / -computer)
 *           are real Git repos but have not been turned into OpenTofu modules
 *           yet (no `terraform {}` / `provider {}` / `resource {}` blocks), so
 *           `/install` would provision nothing. They are first-party to the Takos
 *           PRODUCT, but to Takosumi they are just ordinary Git-URL Capsules with
 *           no special standing — they flip to installable the moment someone
 *           writes their OpenTofu module, not because of who made them.
 *
 * Git URLs are taken verbatim from the ecosystem `.gitmodules` remotes (never
 * fabricated):
 *   - takos      -> https://github.com/tako0614/takos.git
 *   - takosumi   -> https://github.com/tako0614/takosumi.git
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
   * True ONLY when this resolves to a genuine, Gate-passing OpenTofu Capsule
   * under the plain instance-wide DEFAULT policy (no privileged per-entry
   * config). False renders a coming-soon card with no install button.
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
 * The Store shelf. Order is "most useful first": Takos itself, then the storage
 * / compute building blocks, then the not-yet-Capsule apps. There is NO
 * "official" tier — Takosumi-made modules and any third-party Capsule are equal
 * Store entries. `installable` is set per the VERIFIED honesty contract above:
 * every live button passes the plain instance-wide DEFAULT policy gate (no
 * privileged per-entry config), and the rest stay coming-soon.
 */
export const CATALOG: readonly CatalogEntry[] = [
  // ---- Takos (one Capsule on the shelf, no special standing) --------------
  // HONESTY: verified with the real default-policy compatibility analyzer
  // (capsule_compatibility.ts) under the plain instance-wide default policy —
  // the takos Capsule's resource types (cloudflare_d1_database / _queue /
  // _workers_kv_namespace / _r2_bucket) ARE in the default allowlist now, so the
  // analyzer returns `needs_patch`, NOT `unsupported`. The gate is not why this
  // stays coming-soon: takos is NOT one-touch installable because a successful
  // `tofu apply` only provisions the durable infra — the worker artifact still
  // needs a SEPARATE wrangler step afterward, so a single Takosumi apply does
  // not yield a running takos. Showing an install button here would be a button
  // that "succeeds" but leaves a non-working install, so it stays coming-soon
  // (self-host via `tofu apply` + one wrangler step is the supported path).
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
      "Takos 本体は、導入（apply）でインフラを作ったあとにもう 1 つ別の手順（wrangler でアプリ本体を上げる）が必要なため、ここからのワンクリック導入は準備中です（現在は自分のインフラへの導入で動かせます）。",
  },

  // ---- Building blocks (Takosumi-made OpenTofu modules, no special tier) ---
  {
    id: "cloudflare-r2-storage",
    title: "ファイル置き場（Cloudflare R2）",
    summary:
      "Cloudflare R2 にファイル保存用のバケットを 1 つ作るシンプルな部品です（Takosumi 製）。",
    category: "storage",
    icon: "r2",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/cloudflare-r2-storage/module",
    installable: true,
    note: "適用には Cloudflare の接続が必要です。",
    requiresConnection: { provider: "cloudflare", label: "Cloudflare" },
  },
  // HONESTY: this module's only resource is `cloudflare_pages_project`, a
  // standard Cloudflare building block now covered by the instance-wide DEFAULT
  // allowlist. VERIFIED by running the real analyzer under the plain default
  // policy (no per-entry config) -> `ready` (no errors), so `canContinue()`
  // enables. No privileged Store config involved.
  {
    id: "cloudflare-static-site",
    title: "静的サイト公開（Cloudflare Pages）",
    summary:
      "Cloudflare Pages の公開プロジェクトを作り、静的サイトを置けるようにします（Takosumi 製）。",
    category: "compute",
    icon: "site",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/cloudflare-static-site/module",
    installable: true,
    note: "適用には Cloudflare の接続が必要です。",
    requiresConnection: { provider: "cloudflare", label: "Cloudflare" },
  },
  // HONESTY: this module uses `cloudflare_workers_script` and
  // `cloudflare_workers_script_subdomain`, both standard Cloudflare building
  // blocks now covered by the instance-wide DEFAULT allowlist. VERIFIED by
  // running the real analyzer under the plain default policy (no per-entry
  // config) -> `needs_patch` (only a `file()` build-artifact warning, NOT
  // `unsupported`), so `canContinue()` enables. No privileged Store config.
  {
    id: "cloudflare-worker-service",
    title: "小さなサーバー（Cloudflare Worker）",
    summary:
      "Cloudflare 上に Worker（小さなサーバー）を 1 つ立てるための部品です（Takosumi 製）。",
    category: "compute",
    icon: "worker",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/cloudflare-worker-service/module",
    installable: true,
    note: "適用には Cloudflare の接続が必要です。",
    requiresConnection: { provider: "cloudflare", label: "Cloudflare" },
  },
  {
    id: "aws-s3-storage",
    title: "ファイル置き場（AWS S3）",
    summary: "AWS S3 にファイル保存用のバケットを 1 つ作るシンプルな部品です（Takosumi 製）。",
    category: "storage",
    icon: "s3",
    gitUrl: TAKOSUMI_GIT,
    ref: "main",
    path: "opentofu-modules/aws-s3-storage/module",
    installable: true,
    note: "適用には AWS の接続が必要です。",
    requiresConnection: { provider: "aws", label: "AWS" },
  },

  // ---- Git-URL Capsules that are not yet OpenTofu modules ------------------
  // HONESTY: these are real Git repos, but they do not yet contain an OpenTofu
  // module (no terraform/provider/resource blocks), so `/install` would
  // provision nothing. They flip to installable when someone writes the module,
  // not because of who made them — to Takosumi they are ordinary Git-URL
  // Capsules with no special standing.
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
      "このリポジトリはまだ OpenTofu module 化されていないため、Git URL からそのまま入れられません（module ができ次第、入れられるようになります）。",
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
      "このリポジトリはまだ OpenTofu module 化されていないため、Git URL からそのまま入れられません（module ができ次第、入れられるようになります）。",
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
      "このリポジトリはまだ OpenTofu module 化されていないため、Git URL からそのまま入れられません（module ができ次第、入れられるようになります）。",
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
      "このリポジトリはまだ OpenTofu module 化されていないため、Git URL からそのまま入れられません（module ができ次第、入れられるようになります）。",
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
      "このリポジトリはまだ OpenTofu module 化されていないため、Git URL からそのまま入れられません（module ができ次第、入れられるようになります）。",
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
      "このリポジトリはまだ OpenTofu module 化されていないため、Git URL からそのまま入れられません（module ができ次第、入れられるようになります）。",
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
  // Every Store entry installs through the SAME plain `/install` flow under the
  // instance-wide default policy — no per-entry privileged config is pinned, so
  // the deep link carries only the Git address (git / ref / path).
  return `/install?${params.toString()}`;
}
