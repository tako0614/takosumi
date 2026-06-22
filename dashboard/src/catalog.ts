/**
 * Curated install catalog for `/new`.
 *
 * Each entry still resolves to normal Git URL / ref / path coordinates and a
 * seeded InstallConfig. The catalog has no special deployment authority; it is
 * just the friendly app-store layer over runnable first-party OpenTofu starter
 * modules.
 *
 * Inclusion rule: a card must create real infrastructure with `tofu
 * plan/apply`. Product distributions that only publish application metadata
 * stay out of this generic starter catalog.
 */
import type { Locale } from "./i18n/index.ts";

export interface CatalogEntry {
  readonly id: string;
  readonly git: string;
  readonly ref: string;
  readonly path: string;
  readonly installConfigId: string;
  readonly surface: "service" | "building_block";
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
    surface: "service",
    kind: "worker",
    provider: "cloudflare",
    suggestedName: "web-app",
    badge: { ja: "Webアプリ", en: "Web app" },
    name: { ja: "小さなWebアプリを公開", en: "Deploy a tiny web app" },
    description: {
      ja: "すぐ開ける小さなWebアプリと公開URLを作ります。",
      en: "Creates a tiny browser-openable web app with a public URL.",
    },
    inputs: [
      {
        name: "appName",
        required: true,
        defaultValue: "service-name-with-space",
        label: { ja: "公開名", en: "Public name" },
        helper: {
          ja: "公開URLにも使われる名前です。",
          en: "Also used in the public URL.",
        },
        placeholder: "hello-worker",
      },
      {
        name: "accountId",
        required: true,
        label: { ja: "Cloudflare アカウント", en: "Cloudflare account" },
        helper: {
          ja: "接続済みアカウントから分かる場合は自動入力されます。手入力する場合は Cloudflare のアカウント ID を使います。",
          en: "Filled automatically when a connected account provides it. If entering it manually, use the Cloudflare account ID.",
        },
        placeholder: "0123abcd...",
      },
      {
        name: "workersSubdomain",
        required: true,
        label: {
          ja: "公開サブドメイン",
          en: "Public subdomain",
        },
        helper: {
          ja: "公開URLの先頭部分です。例: my-team",
          en: "The first part of the public URL, for example: my-team.",
        },
        placeholder: "my-team",
      },
    ],
  },
  {
    id: "cloudflare-r2-storage",
    git: "https://github.com/tako0614/takosumi.git",
    ref: TAKOSUMI_CATALOG_REF,
    path: "providers/cloudflare/modules/cloudflare-r2-storage/module",
    installConfigId: "cfg-official-cloudflare-r2-storage",
    surface: "building_block",
    kind: "storage",
    provider: "cloudflare",
    suggestedName: "files",
    badge: { ja: "ファイル保存", en: "File storage" },
    name: { ja: "ファイル保存場所を作成", en: "Create file storage" },
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
        label: { ja: "Cloudflare アカウント", en: "Cloudflare account" },
        helper: {
          ja: "接続済みアカウントから分かる場合は自動入力されます。手入力する場合は Cloudflare のアカウント ID を使います。",
          en: "Filled automatically when a connected account provides it. If entering it manually, use the Cloudflare account ID.",
        },
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
    surface: "service",
    kind: "site",
    provider: "cloudflare",
    suggestedName: "website",
    badge: { ja: "Webサイト", en: "Website" },
    name: { ja: "Webサイトを公開", en: "Publish a website" },
    description: {
      ja: "HTMLや画像を置いて公開できるWebサイトを用意します。",
      en: "Creates a website for publishing HTML and assets.",
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
        label: { ja: "Cloudflare アカウント", en: "Cloudflare account" },
        helper: {
          ja: "接続済みアカウントから分かる場合は自動入力されます。手入力する場合は Cloudflare のアカウント ID を使います。",
          en: "Filled automatically when a connected account provides it. If entering it manually, use the Cloudflare account ID.",
        },
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
    surface: "building_block",
    kind: "storage",
    provider: "aws",
    suggestedName: "files-aws",
    badge: { ja: "ファイル保存", en: "File storage" },
    name: { ja: "ファイル保存場所を作成", en: "Create file storage" },
    description: {
      ja: "アプリの保存先やバックアップに使えるファイル置き場を作ります。",
      en: "Creates storage for files, app data, or backups.",
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
