import { type DefaultTheme, defineConfig } from "vitepress";

const sidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "まず読む",
      items: [
        { text: "コンセプト", link: "/getting-started/concepts" },
        { text: "クイックスタート", link: "/getting-started/quickstart" },
        { text: "読む順序", link: "/getting-started/reading-paths" },
      ],
    },
    {
      text: "役割別",
      items: [
        {
          text: "AppSpec を書く",
          link: "/getting-started/reading-paths#appspec-authors",
        },
        {
          text: "Operator として動かす",
          link: "/getting-started/reading-paths#reference-kernel-operators",
        },
        {
          text: "Takosumi を拡張する",
          link: "/getting-started/reading-paths#provider-extension-authors",
        },
        {
          text: "Takosumi Cloud を読む",
          link: "/getting-started/reading-paths#cloud-operators",
        },
        {
          text: "内部設計を追う",
          link: "/getting-started/reading-paths#core-contributors",
        },
      ],
    },
    {
      text: "Core contract",
      items: [
        {
          text: "Specification boundaries",
          link: "/reference/spec-boundaries",
        },
        { text: "Core specification", link: "/reference/core-spec" },
        { text: "AppSpec", link: "/reference/app-spec" },
        { text: "Installer API", link: "/reference/installer-api" },
        { text: "Plan output", link: "/reference/plan-output" },
        {
          text: "External publications",
          link: "/reference/external-publications",
        },
        { text: "HTTP exposure", link: "/reference/http-exposure" },
      ],
    },
    {
      text: "Official catalog",
      items: [
        { text: "Type catalog specification", link: "/reference/type-catalog" },
        { text: "Access modes", link: "/reference/access-modes" },
      ],
    },
    {
      text: "Cloud distribution",
      items: [
        {
          text: "Takosumi Cloud account plane",
          link: "/reference/takosumi-cloud",
        },
      ],
    },
    {
      text: "Build / prepared source",
      collapsed: true,
      items: [
        { text: "Build service handoff", link: "/reference/build-spec" },
        {
          text: "Operator build-service profile",
          link: "/operator/build-service-profile",
        },
        { text: "Digest computation", link: "/reference/digest-computation" },
      ],
    },
    {
      text: "Reference implementation operations",
      collapsed: true,
      items: [
        { text: "運用概要", link: "/operator/" },
        { text: "Bootstrap", link: "/operator/bootstrap" },
        { text: "セルフホスト運用", link: "/operator/self-host" },
        { text: "環境変数", link: "/reference/env-vars" },
        { text: "runtime-agent 分離", link: "/operator/runtime-agent" },
        { text: "バージョン整合", link: "/operator/upgrade" },
        { text: "Migration / Upgrade", link: "/reference/migration-upgrade" },
        { text: "Backup / Restore", link: "/reference/backup-restore" },
        { text: "Observability", link: "/reference/observability-stack" },
        { text: "Readiness probes", link: "/reference/readiness-probes" },
        { text: "Telemetry / Metrics", link: "/reference/telemetry-metrics" },
        { text: "Logging", link: "/reference/logging-conventions" },
      ],
    },
    {
      text: "補助リファレンス",
      items: [
        { text: "リファレンス索引", link: "/reference/" },
        { text: "CLI", link: "/reference/cli" },
        { text: "用語集", link: "/reference/glossary" },
      ],
    },
    {
      text: "拡張",
      items: [
        { text: "Takosumi を拡張する", link: "/extending" },
        { text: "Provider implementations", link: "/reference/providers" },
        { text: "Provider packages", link: "/reference/provider-packages" },
        {
          text: "Reference adapter loading",
          link: "/reference/plugin-loading",
        },
        { text: "Connector guide", link: "/reference/connector-contract" },
        {
          text: "Reference Runtime-Agent Execution Surface",
          link: "/reference/runtime-agent-api",
        },
      ],
    },
    {
      text: "内部設計",
      collapsed: true,
      items: [
        { text: "内部設計の概要", link: "/reference/architecture/" },
        { text: "Kernel", link: "/reference/architecture/kernel" },
        {
          text: "Control plane",
          link: "/reference/architecture/control-plane",
        },
        {
          text: "Deploy system",
          link: "/reference/architecture/deploy-system",
        },
        {
          text: "Runtime routing",
          link: "/reference/architecture/runtime-routing",
        },
        {
          text: "Runtime deployment",
          link: "/reference/architecture/runtime-deployment-model",
        },
        { text: "Space model", link: "/reference/architecture/space-model" },
        { text: "Object model", link: "/reference/architecture/object-model" },
        {
          text: "External publication model",
          link: "/reference/architecture/external-publication-model",
        },
        {
          text: "Link / projection model",
          link: "/reference/architecture/link-projection-model",
        },
        {
          text: "Snapshot model",
          link: "/reference/architecture/snapshot-model",
        },
        {
          text: "Kind resolution model",
          link: "/reference/architecture/kind-resolution-model",
        },
        {
          text: "Policy / risk / approval / error",
          link: "/reference/architecture/policy-risk-approval-error-model",
        },
        {
          text: "Implementation / runtime-agent boundary",
          link: "/reference/architecture/implementation-operation-envelope",
        },
        {
          text: "Execution lifecycle",
          link: "/reference/architecture/execution-lifecycle",
        },
        {
          text: "API surface",
          link: "/reference/architecture/api-surface-architecture",
        },
        {
          text: "CLI surface",
          link: "/reference/architecture/cli-companion-architecture-note",
        },
        {
          text: "Operator boundaries",
          link: "/reference/architecture/operator-boundaries",
        },
        {
          text: "External catalog intake",
          link: "/reference/architecture/external-descriptor-registry-model",
        },
        {
          text: "Workflow placement",
          link: "/reference/architecture/workflow-extension-design",
        },
        {
          text: "Operational hardening",
          link: "/reference/architecture/operational-hardening-checklist",
        },
        {
          text: "Exposure Activation",
          link: "/reference/architecture/exposure-activation-model",
        },
      ],
    },
    {
      text: "Internals / maintenance",
      collapsed: true,
      items: [
        {
          text: "Reference kernel route inventory",
          link: "/reference/kernel-http-api",
        },
        { text: "Lifecycle protocol", link: "/reference/lifecycle" },
        { text: "Lifecycle phases", link: "/reference/lifecycle-phases" },
        { text: "WAL stages", link: "/reference/wal-stages" },
        { text: "GroupHead rollout", link: "/reference/group-head-rollout" },
        { text: "Storage schema", link: "/reference/storage-schema" },
        { text: "Journal compaction", link: "/reference/journal-compaction" },
        { text: "Audit events", link: "/reference/audit-events" },
        {
          text: "Observation retention",
          link: "/reference/observation-retention",
        },
        { text: "Drift detection", link: "/reference/drift-detection" },
        { text: "Enum and value index", link: "/reference/closed-enums" },
        {
          text: "Approval invalidation",
          link: "/reference/approval-invalidation",
        },
        { text: "Risk taxonomy", link: "/reference/risk-taxonomy" },
        { text: "RevokeDebt model", link: "/reference/revoke-debt" },
        { text: "Plan output", link: "/reference/plan-output" },
        { text: "Status output", link: "/reference/status-output" },
        { text: "Resource IDs", link: "/reference/resource-ids" },
        { text: "Time / clock model", link: "/reference/time-clock-model" },
        {
          text: "Spec maintenance map",
          link: "/reference/public-spec-source-map",
        },
        { text: "Digest computation", link: "/reference/digest-computation" },
        {
          text: "Operator DataAsset policy",
          link: "/reference/data-asset-policy",
        },
        { text: "Operator DataAsset GC", link: "/reference/data-asset-gc" },
        { text: "Secret partitions", link: "/reference/secret-partitions" },
        { text: "Cross-process locks", link: "/reference/cross-process-locks" },
        { text: "Bootstrap protocol", link: "/reference/bootstrap-protocol" },
        { text: "Supply chain trust", link: "/reference/supply-chain-trust" },
        { text: "Workers backend", link: "/reference/workers-backend" },
      ],
    },
    {
      text: "RFC / design record",
      collapsed: true,
      items: [
        {
          text: "0001 — Kernel kind-agnostic 化",
          link: "/rfc/0001-kernel-kind-agnostic",
        },
      ],
    },
  ],
};

const nav: DefaultTheme.NavItem[] = [
  { text: "概要", link: "/" },
  { text: "コンセプト", link: "/getting-started/concepts" },
  { text: "クイックスタート", link: "/getting-started/quickstart" },
  { text: "読む順序", link: "/getting-started/reading-paths" },
  { text: "AppSpec", link: "/reference/app-spec" },
  { text: "リファレンス", link: "/reference/" },
  { text: "運用", link: "/operator/" },
];

export default defineConfig({
  title: "Takosumi",
  description: "Self-hostable PaaS toolkit — AppSpec, Installation, Deployment",
  lang: "ja",
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
    nav,
    sidebar,
    outline: { label: "目次" },
    docFooter: { prev: "前へ", next: "次へ" },
    lastUpdatedText: "最終更新",
    darkModeSwitchLabel: "テーマ",
    sidebarMenuLabel: "メニュー",
    returnToTopLabel: "トップへ戻る",
    socialLinks: [
      { icon: "github", link: "https://github.com/tako0614/takosumi" },
    ],
    search: { provider: "local" },
    editLink: {
      pattern: "https://github.com/tako0614/takosumi/edit/main/docs/:path",
      text: "GitHub でこのページを編集",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "© Takos / Takosumi contributors",
    },
  },
});
