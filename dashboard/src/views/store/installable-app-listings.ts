import type { TcsListing } from "../../lib/tcs-client.ts";

const now = "2026-07-01T00:00:00.000Z";

const text = (ja: string, en: string) => ({ ja, en });

// Dashboard-local installable app links into Git-hosted OpenTofu Capsules. These are not
// Takosumi-owned platform services or privileged platform surfaces.
export const installableAppStoreListings: readonly TcsListing[] = [
  {
    id: "yurucommu",
    installConfigId: "cfg-catalog-yurucommu",
    source: {
      git: "https://github.com/tako0614/yurucommu.git",
      ref: "main",
      path: ".",
      resolvedCommit: "de0c72f3741c3f2bed633c7dd995fa412d5074c2",
    },
    kind: "app",
    surface: "service",
    provider: "cloudflare",
    category: "social",
    suggestedName: "yurucommu",
    name: text("yurucommu", "yurucommu"),
    description: text(
      "自分用のコミュニティ / ActivityPub アプリをホストします。",
      "Host a personal community / ActivityPub app.",
    ),
    badge: text("追加候補", "Installable"),
    iconUrl:
      "https://raw.githubusercontent.com/tako0614/yurucommu/de0c72f3741c3f2bed633c7dd995fa412d5074c2/public/icons/yurucommu.svg",
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text("サービス名", "Service name"),
      },
      {
        name: "worker_name",
        type: "string",
        label: text("公開サブドメイン", "Public subdomain"),
        helper: text(
          "空欄ならサービス名から自動で決めます。入力すると <subdomain>.app.takos.jp として使われます。",
          "Leave empty to derive it from the service name. When set, it is used as <subdomain>.app.takos.jp.",
        ),
        placeholder: "my-community",
      },
      {
        name: "app_url",
        type: "string",
        advanced: true,
        label: text("独自URL", "Custom URL"),
        helper: text(
          "独自ドメインを使う場合だけ https:// から入力します。空欄なら公開サブドメインから app.takos.jp のURLを使います。",
          "Enter an https:// URL only for a custom domain. Leave empty to use the app.takos.jp URL from the public subdomain.",
        ),
        placeholder: "https://my-app.app.takos.jp",
      },
      {
        name: "auth_password_hash",
        type: "string",
        advanced: true,
        secret: true,
        label: text("初期パスワード", "Initial password"),
        helper: text(
          "通常はTakosumi Accountsで自動ログインします。OIDCを使わない時だけ、一時パスワード/tokenまたはPBKDF2 hashを入力します。",
          "Takosumi Accounts signs in automatically by default. Enter a temporary password/token or PBKDF2 hash only when you do not use OIDC.",
        ),
        placeholder: "optional",
      },
      {
        name: "enable_cloudflare_resources",
        type: "boolean",
        defaultValue: "true",
        label: text("Cloudflare リソースを作成", "Create Cloudflare resources"),
      },
      {
        name: "enable_cloudflare_worker_script",
        type: "boolean",
        defaultValue: "true",
        label: text("Worker を公開", "Publish Worker"),
      },
      {
        name: "worker_bundle_url",
        type: "string",
        defaultValue:
          "https://github.com/tako0614/yurucommu/releases/download/v2.0.1/takos-worker.js",
        label: text("Worker artifact URL", "Worker artifact URL"),
      },
      {
        name: "worker_bundle_sha256",
        type: "string",
        defaultValue:
          "866184ea1861b848770cbe64bed4e22d73778365c33ef693d81040e3baf04d50",
        label: text("Worker artifact SHA-256", "Worker artifact SHA-256"),
      },
    ],
    outputAllowlist: [
      { key: "url", from: "url", type: "url", required: false },
      {
        key: "app_deployment",
        from: "app_deployment",
        type: "json",
        required: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "takos",
    installConfigId: "cfg-catalog-takos",
    source: {
      git: "https://github.com/tako0614/takos.git",
      ref: "main",
      path: "deploy/opentofu",
      resolvedCommit: "805d006154e7ee7eb0b3952e8f28ab83e9760b78",
    },
    kind: "app",
    surface: "service",
    provider: "cloudflare",
    category: "workspace",
    suggestedName: "takos",
    name: text("Takos", "Takos"),
    description: text(
      "AI ワークスペースを自分の環境にホストします。",
      "Host the Takos AI workspace in your own environment.",
    ),
    badge: text("追加候補", "Installable"),
    iconUrl:
      "https://raw.githubusercontent.com/tako0614/takos/805d006154e7ee7eb0b3952e8f28ab83e9760b78/web/public/logo.png",
    inputs: [
      {
        name: "project_name",
        type: "string",
        defaultValue: "service-name-with-space",
        label: text(
          "サービス名 / 公開サブドメイン",
          "Service name / public subdomain",
        ),
        helper: text(
          "Takosではこの値がリソース名と app.takos.jp のサブドメインに使われます。",
          "For Takos, this value is used for resource names and the app.takos.jp subdomain.",
        ),
      },
      {
        name: "app_url",
        type: "string",
        advanced: true,
        label: text("独自URL", "Custom URL"),
        helper: text(
          "独自ドメインを使う場合だけ https:// から入力します。空欄ならサービス名から app.takos.jp のURLを使います。",
          "Enter an https:// URL only for a custom domain. Leave empty to use an app.takos.jp URL from the service name.",
        ),
        placeholder: "https://my-workspace.app.takos.jp",
      },
      {
        name: "release_container_images",
        type: "json",
        defaultValue:
          '{"runtime":"registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-worker-runtime:0.10.0-3cfcc10f7ad1","executor":"registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-agent-executor:0.10.0-3cfcc10f7ad1"}',
        label: text("Release container images", "Release container images"),
      },
    ],
    outputAllowlist: [
      { key: "url", from: "url", type: "url", required: false },
      {
        key: "app_deployment",
        from: "app_deployment",
        type: "json",
        required: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
  },
];
