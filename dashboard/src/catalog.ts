/**
 * Curated install catalog for `/new` — entries are addressed exactly like any
 * other Git-URL capsule (url / ref / path). This is intentionally a static,
 * easily-edited list: the platform's install model is "any Git URL", so the
 * catalog is just curated starting points, not a registry with special powers.
 *
 * Inclusion rule — an entry must be a REAL standalone capsule: installing it
 * from Takosumi alone (no separate product-specific installer)
 * must provision something via `tofu plan/apply`. Audited 2026-06 and trimmed
 * accordingly:
 *   - product-distribution repos that only publish application metadata rather
 *     than infrastructure are excluded because installing them here would plan
 *     zero resources.
 *   - product distributions such as Takos are linked from their own website via
 *     `/install?git=...`; they are not generic Takosumi starter cards.
 *   - providers/cloudflare/modules/* : first-party deployment TEMPLATES whose
 *     module/ expects a runner-built artifact and pipeline-supplied inputs
 *     (`localModulePath`, build commands) — not standalone Git capsules.
 * The catalog grows when purpose-built starter capsule repos exist.
 */
import type { Locale } from "./i18n/index.ts";

export interface CatalogEntry {
  readonly id: string;
  readonly git: string;
  readonly ref: string;
  readonly path: string;
  readonly installConfigId: string;
  readonly kind: "worker" | "storage" | "site";
  readonly provider: "cloudflare" | "aws";
  /** Suggested Installation name (pre-fills the name field). */
  readonly suggestedName: string;
  readonly badge: Record<Locale, string>;
  readonly name: Record<Locale, string>;
  readonly description: Record<Locale, string>;
  readonly inputs: readonly CatalogInputField[];
}

export interface CatalogInputField {
  readonly name: string;
  readonly required?: boolean;
  readonly defaultValue?:
    | "service-name"
    | "service-name-with-space"
    | "main"
    | "us-east-1";
  readonly label: Record<Locale, string>;
  readonly helper?: Record<Locale, string>;
  readonly placeholder?: string;
}

const TAKOSUMI_CATALOG_REF = "fcc47907b0154d8bf53872a3336e5653fc88792e";

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "cloudflare-hello-worker",
    git: "https://github.com/tako0614/takosumi.git",
    ref: TAKOSUMI_CATALOG_REF,
    path: "providers/cloudflare/modules/cloudflare-hello-worker/module",
    installConfigId: "cfg-official-cloudflare-hello-worker",
    kind: "worker",
    provider: "cloudflare",
    suggestedName: "hello",
    badge: { ja: "Worker", en: "Worker" },
    name: { ja: "Hello Worker", en: "Hello Worker" },
    description: {
      ja: "ビルドなしで小さな Cloudflare Worker を作ります。最初の接続テストに向いています。",
      en: "Creates a tiny no-build Cloudflare Worker. Good for the first connection test.",
    },
    inputs: [
      {
        name: "appName",
        required: true,
        defaultValue: "service-name-with-space",
        label: { ja: "Worker 名", en: "Worker name" },
        helper: {
          ja: "Cloudflare 上に作成される script 名です。",
          en: "The script name created in Cloudflare.",
        },
        placeholder: "hello-worker",
      },
      {
        name: "accountId",
        required: true,
        label: { ja: "Cloudflare アカウント ID", en: "Cloudflare account ID" },
        helper: {
          ja: "Cloudflare ダッシュボードのアカウント情報から確認できます。",
          en: "Find this in your Cloudflare dashboard account details.",
        },
        placeholder: "0123abcd...",
      },
    ],
  },
  {
    id: "cloudflare-r2-storage",
    git: "https://github.com/tako0614/takosumi.git",
    ref: TAKOSUMI_CATALOG_REF,
    path: "providers/cloudflare/modules/cloudflare-r2-storage/module",
    installConfigId: "cfg-official-cloudflare-r2-storage",
    kind: "storage",
    provider: "cloudflare",
    suggestedName: "r2-storage",
    badge: { ja: "ストレージ", en: "Storage" },
    name: { ja: "Cloudflare R2 バケット", en: "Cloudflare R2 bucket" },
    description: {
      ja: "ファイルやバックアップ用の保存場所を作ります。",
      en: "Creates storage for files or backups.",
    },
    inputs: [
      {
        name: "bucketName",
        required: true,
        defaultValue: "service-name-with-space",
        label: { ja: "バケット名", en: "Bucket name" },
        helper: {
          ja: "同じ Cloudflare アカウント内で一意にしてください。",
          en: "Must be unique in the Cloudflare account.",
        },
        placeholder: "my-files",
      },
      {
        name: "accountId",
        required: true,
        label: { ja: "Cloudflare アカウント ID", en: "Cloudflare account ID" },
        placeholder: "0123abcd...",
      },
      {
        name: "location",
        label: { ja: "保存場所（任意）", en: "Location hint (optional)" },
        helper: {
          ja: "指定しない場合は Cloudflare の標準設定を使います。",
          en: "Leave empty to use Cloudflare's default placement.",
        },
        placeholder: "apac",
      },
    ],
  },
  {
    id: "cloudflare-static-site",
    git: "https://github.com/tako0614/takosumi.git",
    ref: TAKOSUMI_CATALOG_REF,
    path: "providers/cloudflare/modules/cloudflare-static-site/module",
    installConfigId: "cfg-official-cloudflare-static-site",
    kind: "site",
    provider: "cloudflare",
    suggestedName: "static-site",
    badge: { ja: "Web", en: "Web" },
    name: { ja: "Cloudflare Pages サイト", en: "Cloudflare Pages site" },
    description: {
      ja: "静的サイトを置く場所を用意します。",
      en: "Creates a home for a static website.",
    },
    inputs: [
      {
        name: "projectName",
        required: true,
        defaultValue: "service-name-with-space",
        label: { ja: "プロジェクト名", en: "Project name" },
        helper: {
          ja: "*.pages.dev の名前にも使われます。",
          en: "Also used for the *.pages.dev subdomain label.",
        },
        placeholder: "my-site",
      },
      {
        name: "accountId",
        required: true,
        label: { ja: "Cloudflare アカウント ID", en: "Cloudflare account ID" },
        placeholder: "0123abcd...",
      },
      {
        name: "productionBranch",
        defaultValue: "main",
        label: { ja: "本番ブランチ", en: "Production branch" },
        placeholder: "main",
      },
    ],
  },
  {
    id: "aws-s3-storage",
    git: "https://github.com/tako0614/takosumi.git",
    ref: TAKOSUMI_CATALOG_REF,
    path: "providers/aws/modules/aws-s3-storage/module",
    installConfigId: "cfg-official-aws-s3-storage",
    kind: "storage",
    provider: "aws",
    suggestedName: "s3-storage",
    badge: { ja: "ストレージ", en: "Storage" },
    name: { ja: "AWS S3 バケット", en: "AWS S3 bucket" },
    description: {
      ja: "AWS にファイル置き場を作ります。アプリの保存先やバックアップにも使えます。",
      en: "Creates AWS storage for files, app data, or backups.",
    },
    inputs: [
      {
        name: "bucketName",
        required: true,
        defaultValue: "service-name-with-space",
        label: { ja: "バケット名", en: "Bucket name" },
        helper: {
          ja: "S3 bucket 名はグローバルに一意である必要があります。",
          en: "S3 bucket names must be globally unique.",
        },
        placeholder: "my-files",
      },
      {
        name: "region",
        defaultValue: "us-east-1",
        label: { ja: "リージョン", en: "Region" },
        placeholder: "us-east-1",
      },
    ],
  },
];
