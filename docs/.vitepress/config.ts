import { type DefaultTheme, defineConfig } from "vitepress";

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "はじめに",
      items: [
        { text: "クイックスタート", link: "/getting-started/quickstart" },
        { text: "コンセプト", link: "/getting-started/concepts" },
      ],
    },
    {
      text: "マニフェスト",
      items: [
        { text: "マニフェスト (Shape モデル)", link: "/manifest" },
      ],
    },
    {
      text: "リファレンス / アーキテクチャ",
      items: [
        { text: "概要", link: "/reference/architecture/" },
        { text: "カーネル", link: "/reference/architecture/kernel" },
        {
          text: "コントロールプレーン",
          link: "/reference/architecture/control-plane",
        },
        {
          text: "デプロイシステム",
          link: "/reference/architecture/deploy-system",
        },
        {
          text: "テナントランタイム",
          link: "/reference/architecture/tenant-runtime",
        },
        {
          text: "ランタイムデプロイメント",
          link: "/reference/architecture/runtime-deployment-model",
        },
        {
          text: "スペースモデル",
          link: "/reference/architecture/space-model",
        },
        {
          text: "カタログリリースとディスクリプタモデル",
          link: "/reference/architecture/catalog-release-descriptor-model",
        },
        {
          text: "スナップショットモデル",
          link: "/reference/architecture/snapshot-model",
        },
        {
          text: "オブジェクトモデル",
          link: "/reference/architecture/object-model",
        },
        {
          text: "ネームスペースエクスポートモデル",
          link: "/reference/architecture/namespace-export-model",
        },
        {
          text: "リンクとプロジェクションモデル",
          link: "/reference/architecture/link-projection-model",
        },
        {
          text: "ポリシー / リスク / 承認 / エラーモデル",
          link: "/reference/architecture/policy-risk-approval-error-model",
        },
        {
          text: "ターゲットモデル",
          link: "/reference/architecture/target-model",
        },
        {
          text: "実装とランタイムエージェント境界",
          link: "/reference/architecture/implementation-operation-envelope",
        },
        {
          text: "実行ライフサイクル",
          link: "/reference/architecture/execution-lifecycle",
        },
        {
          text: "API サーフェス",
          link: "/reference/architecture/api-surface-architecture",
        },
        {
          text: "CLI サーフェスアーキテクチャ",
          link: "/reference/architecture/cli-companion-architecture-note",
        },
        {
          text: "オペレーター境界",
          link: "/reference/architecture/operator-boundaries",
        },
        {
          text: "プロバイダーアーキテクチャ",
          link: "/reference/architecture/paas-provider-architecture",
        },
        {
          text: "アイデンティティとアクセスのアーキテクチャ",
          link: "/reference/architecture/identity-and-access-architecture",
        },
        {
          text: "テナントライフサイクルアーキテクチャ",
          link: "/reference/architecture/tenant-lifecycle-architecture",
        },
        {
          text: "PaaS 運用アーキテクチャ",
          link: "/reference/architecture/paas-operations-architecture",
        },
        {
          text: "ワークフロー拡張設計",
          link: "/reference/architecture/workflow-extension-design",
        },
        {
          text: "運用ハードニング",
          link: "/reference/architecture/operational-hardening-checklist",
        },
      ],
    },
    {
      text: "リファレンス",
      items: [
        { text: "インデックス", link: "/reference/" },
      ],
    },
    {
      text: "リファレンス / API サーフェス",
      items: [
        { text: "Kernel HTTP API", link: "/reference/kernel-http-api" },
        { text: "Runtime-Agent API", link: "/reference/runtime-agent-api" },
        { text: "CLI", link: "/reference/cli" },
        { text: "ライフサイクルプロトコル", link: "/reference/lifecycle" },
        {
          text: "公開仕様ソースマップ",
          link: "/reference/public-spec-source-map",
        },
      ],
    },
    {
      text: "リファレンス / マニフェストとワイヤーフォーマット",
      items: [
        { text: "マニフェスト", link: "/reference/manifest" },
        { text: "Plan 出力スキーマ", link: "/reference/plan-output" },
        { text: "Status 出力スキーマ", link: "/reference/status-output" },
        { text: "リソース ID", link: "/reference/resource-ids" },
        { text: "ダイジェスト計算", link: "/reference/digest-computation" },
        { text: "時刻とクロックモデル", link: "/reference/time-clock-model" },
      ],
    },
    {
      text: "リファレンス / ライフサイクルと実行",
      items: [
        { text: "ライフサイクルフェーズ", link: "/reference/lifecycle-phases" },
        { text: "WAL ステージ", link: "/reference/wal-stages" },
        {
          text: "GroupHead とロールアウト",
          link: "/reference/group-head-rollout",
        },
        { text: "レディネスプローブ", link: "/reference/readiness-probes" },
      ],
    },
    {
      text: "リファレンス / ポリシー / リスク / 承認",
      items: [
        { text: "クローズド enum", link: "/reference/closed-enums" },
        { text: "アクセスモード", link: "/reference/access-modes" },
        {
          text: "承認無効化",
          link: "/reference/approval-invalidation",
        },
        { text: "リスク分類", link: "/reference/risk-taxonomy" },
        { text: "RevokeDebt モデル", link: "/reference/revoke-debt" },
      ],
    },
    {
      text: "リファレンス / ストレージと可観測性",
      items: [
        { text: "ストレージスキーマ", link: "/reference/storage-schema" },
        { text: "ジャーナル圧縮", link: "/reference/journal-compaction" },
        { text: "監査イベント", link: "/reference/audit-events" },
        {
          text: "観測値の保持期間",
          link: "/reference/observation-retention",
        },
        { text: "ドリフト検出", link: "/reference/drift-detection" },
      ],
    },
    {
      text: "リファレンス / アイデンティティとアクセス",
      items: [
        { text: "RBAC ポリシー", link: "/reference/rbac-policy" },
        { text: "API キー管理", link: "/reference/api-key-management" },
        { text: "認証プロバイダー", link: "/reference/auth-providers" },
      ],
    },
    {
      text: "リファレンス / セキュリティとトラスト",
      items: [
        {
          text: "シークレットパーティション",
          link: "/reference/secret-partitions",
        },
        {
          text: "クロスプロセスロック",
          link: "/reference/cross-process-locks",
        },
        {
          text: "カタログリリーストラスト",
          link: "/reference/catalog-release-trust",
        },
        {
          text: "サプライチェーントラスト",
          link: "/reference/supply-chain-trust",
        },
      ],
    },
    {
      text: "リファレンス / クロスプロダクトコントラクト",
      items: [
        {
          text: "ネームスペースエクスポート",
          link: "/reference/namespace-exports",
        },
      ],
    },
    {
      text: "リファレンス / テナントライフサイクル",
      items: [
        {
          text: "テナントプロビジョニング",
          link: "/reference/tenant-provisioning",
        },
        { text: "トライアルスペース", link: "/reference/trial-spaces" },
        {
          text: "テナントエクスポートと削除",
          link: "/reference/tenant-export-deletion",
        },
      ],
    },
    {
      text: "リファレンス / 運用",
      items: [
        {
          text: "ブートストラッププロトコル",
          link: "/reference/bootstrap-protocol",
        },
        {
          text: "マイグレーション / アップグレード",
          link: "/reference/migration-upgrade",
        },
        { text: "バックアップとリストア", link: "/reference/backup-restore" },
        { text: "クォータ / レート制限", link: "/reference/quota-rate-limit" },
        {
          text: "コンプライアンス保持",
          link: "/reference/compliance-retention",
        },
        {
          text: "テレメトリとメトリクス",
          link: "/reference/telemetry-metrics",
        },
        { text: "ロギング規約", link: "/reference/logging-conventions" },
      ],
    },
    {
      text: "リファレンス / PaaS 運用",
      items: [
        { text: "クォータティア", link: "/reference/quota-tiers" },
        { text: "コスト按分", link: "/reference/cost-attribution" },
        {
          text: "SLA 違反検出",
          link: "/reference/sla-breach-detection",
        },
        { text: "ゾーン選択", link: "/reference/zone-selection" },
        { text: "インシデントモデル", link: "/reference/incident-model" },
        {
          text: "サポートインパーソネーション",
          link: "/reference/support-impersonation",
        },
        {
          text: "通知発行",
          link: "/reference/notification-emission",
        },
      ],
    },
    {
      text: "リファレンス / カタログと拡張",
      items: [
        { text: "Kind カタログ", link: "/reference/kind-catalog" },
        { text: "プロバイダープラグイン", link: "/reference/providers" },
        { text: "コネクタコントラクト", link: "/reference/connector-contract" },
        { text: "DataAsset ポリシー", link: "/reference/data-asset-policy" },
        { text: "アーティファクト GC", link: "/reference/artifact-gc" },
      ],
    },
    {
      text: "リファレンス / 設定",
      items: [
        { text: "環境変数", link: "/reference/env-vars" },
      ],
    },
    {
      text: "リファレンス / バックエンドリファレンス",
      items: [
        { text: "Workers バックエンド", link: "/reference/workers-backend" },
      ],
    },
    {
      text: "オペレーター",
      items: [
        { text: "ブートストラップ", link: "/operator/bootstrap" },
        { text: "セルフホストノート", link: "/operator/self-host" },
        { text: "アップグレード", link: "/operator/upgrade" },
      ],
    },
    {
      text: "拡張",
      items: [
        { text: "Takosumi を拡張する", link: "/extending" },
      ],
    },
    {
      text: "RFC",
      items: [
        {
          text: "0001 — Kernel kind-agnostic 化 (planned)",
          link: "/rfc/0001-kernel-kind-agnostic",
        },
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Getting Started",
      items: [
        { text: "Quickstart", link: "/en/getting-started/quickstart" },
      ],
    },
    {
      text: "Reference (JA fallback)",
      items: [
        { text: "AppSpec (.takosumi.yml)", link: "/reference/app-spec" },
        { text: "Manifest (Shape Model)", link: "/manifest" },
        { text: "Installer API", link: "/reference/installer-api" },
        { text: "Kind Catalog", link: "/reference/kind-catalog" },
        { text: "Provider Plugins", link: "/reference/providers" },
        { text: "Runtime-Agent API", link: "/reference/runtime-agent-api" },
        { text: "CLI", link: "/reference/cli" },
        {
          text: "Architecture: Kernel",
          link: "/reference/architecture/kernel",
        },
      ],
    },
    {
      text: "Operator (JA fallback)",
      items: [
        { text: "Bootstrap", link: "/operator/bootstrap" },
        { text: "Self-host Notes", link: "/operator/self-host" },
        { text: "Version Alignment", link: "/operator/upgrade" },
      ],
    },
    {
      text: "Extending (JA fallback)",
      items: [
        { text: "Extending Takosumi", link: "/extending" },
      ],
    },
    {
      text: "RFC (JA fallback)",
      items: [
        {
          text: "0001 — Kernel kind-agnostic (planned)",
          link: "/rfc/0001-kernel-kind-agnostic",
        },
      ],
    },
  ],
};

const jaNav: DefaultTheme.NavItem[] = [
  { text: "Quickstart", link: "/getting-started/quickstart" },
  { text: "Manifest", link: "/manifest" },
  { text: "Architecture", link: "/reference/architecture/" },
  { text: "Reference", link: "/reference/kind-catalog" },
  { text: "Operator", link: "/operator/bootstrap" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Quickstart", link: "/en/getting-started/quickstart" },
  { text: "Reference (JA)", link: "/reference/kind-catalog" },
];

export default defineConfig({
  title: "Takosumi",
  description:
    "Self-hostable PaaS toolkit — manifest-driven multi-cloud deploys",
  // Served under /docs/ on takosumi.com (and takosumi.test mirror); the
  // root path serves a separate marketing landing page. Override via
  // VITEPRESS_BASE if a deploy needs the docs at "/".
  base: process.env.VITEPRESS_BASE ?? "/docs/",
  cleanUrls: true,
  lastUpdated: true,
  vite: {
    server: {
      // Wave M LAN dev: dev hostname (= `*.takosumi.test` / `*.takos.test` /
      // `yurucommu.test`) を Caddy reverse_proxy 経由で踏むため Host header
      // 検証を緩める。 production build には影響しない (= dev server only)。
      allowedHosts: [
        ".takosumi.test",
        ".takos.test",
        ".yurucommu.test",
        "yurucommu.test",
      ],
    },
  },
  sitemap: {
    hostname: "https://takosumi.com/docs/",
  },
  themeConfig: {
    socialLinks: [
      { icon: "github", link: "https://github.com/tako0614/takosumi" },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/tako0614/takosumi/edit/master/docs/:path",
      text: "GitHub でこのページを編集",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "© Takos / Takosumi contributors",
    },
  },
  locales: {
    root: {
      label: "日本語",
      lang: "ja",
      themeConfig: {
        nav: jaNav,
        sidebar: jaSidebar,
        outline: { label: "目次" },
        docFooter: { prev: "前へ", next: "次へ" },
        lastUpdatedText: "最終更新",
        darkModeSwitchLabel: "テーマ",
        sidebarMenuLabel: "メニュー",
        returnToTopLabel: "トップへ戻る",
      },
    },
    en: {
      label: "English",
      lang: "en",
      link: "/en/",
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
      },
    },
  },
});
