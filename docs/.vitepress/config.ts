import { type DefaultTheme, defineConfig } from "vitepress";

const sidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "Guide",
      items: [
        { text: "Overview", link: "/" },
        { text: "クイックスタート", link: "/getting-started/quickstart" },
        { text: "コンセプト", link: "/getting-started/concepts" },
        { text: "AppSpec (.takosumi.yml)", link: "/reference/app-spec" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Reference Index", link: "/reference/" },
        { text: "AppSpec", link: "/reference/app-spec" },
        { text: "Installer API", link: "/reference/installer-api" },
        { text: "Kernel HTTP API", link: "/reference/kernel-http-api" },
        { text: "Runtime-Agent API", link: "/reference/runtime-agent-api" },
        { text: "CLI", link: "/reference/cli" },
        { text: "Provider Plugins", link: "/reference/providers" },
        { text: "Kind Catalog", link: "/reference/kind-catalog" },
        { text: "Environment Variables", link: "/reference/env-vars" },
        { text: "Glossary", link: "/reference/glossary" },
      ],
    },
    {
      text: "Operator",
      items: [
        { text: "Overview", link: "/operator/" },
        { text: "Bootstrap", link: "/operator/bootstrap" },
        { text: "Self-host Notes", link: "/operator/self-host" },
        { text: "Version Alignment", link: "/operator/upgrade" },
        { text: "Migration / Upgrade", link: "/reference/migration-upgrade" },
        { text: "Backup / Restore", link: "/reference/backup-restore" },
        { text: "Observability Stack", link: "/reference/observability-stack" },
        { text: "Telemetry / Metrics", link: "/reference/telemetry-metrics" },
        { text: "Logging", link: "/reference/logging-conventions" },
      ],
    },
    {
      text: "Internals",
      collapsed: true,
      items: [
        { text: "Architecture Overview", link: "/reference/architecture/" },
        { text: "Kernel", link: "/reference/architecture/kernel" },
        { text: "Control Plane", link: "/reference/architecture/control-plane" },
        { text: "Deploy System", link: "/reference/architecture/deploy-system" },
        { text: "Tenant Runtime", link: "/reference/architecture/tenant-runtime" },
        {
          text: "Runtime Deployment",
          link: "/reference/architecture/runtime-deployment-model",
        },
        { text: "Space Model", link: "/reference/architecture/space-model" },
        { text: "Object Model", link: "/reference/architecture/object-model" },
        {
          text: "Namespace Export Model",
          link: "/reference/architecture/namespace-export-model",
        },
        {
          text: "Link / Projection Model",
          link: "/reference/architecture/link-projection-model",
        },
        { text: "Snapshot Model", link: "/reference/architecture/snapshot-model" },
        { text: "Target Model", link: "/reference/architecture/target-model" },
        {
          text: "Policy / Risk / Approval / Error",
          link: "/reference/architecture/policy-risk-approval-error-model",
        },
        {
          text: "Implementation / Runtime-Agent Boundary",
          link: "/reference/architecture/implementation-operation-envelope",
        },
        {
          text: "Execution Lifecycle",
          link: "/reference/architecture/execution-lifecycle",
        },
        { text: "API Surface", link: "/reference/architecture/api-surface-architecture" },
        {
          text: "CLI Surface",
          link: "/reference/architecture/cli-companion-architecture-note",
        },
        {
          text: "Operator Boundaries",
          link: "/reference/architecture/operator-boundaries",
        },
        {
          text: "Catalog Release Descriptor",
          link: "/reference/architecture/catalog-release-descriptor-model",
        },
        {
          text: "Workflow Placement",
          link: "/reference/architecture/workflow-extension-design",
        },
        {
          text: "Operational Hardening",
          link: "/reference/architecture/operational-hardening-checklist",
        },
      ],
    },
    {
      text: "Advanced Reference",
      collapsed: true,
      items: [
        { text: "Lifecycle Protocol", link: "/reference/lifecycle" },
        { text: "Lifecycle Phases", link: "/reference/lifecycle-phases" },
        { text: "WAL Stages", link: "/reference/wal-stages" },
        { text: "GroupHead Rollout", link: "/reference/group-head-rollout" },
        { text: "Readiness Probes", link: "/reference/readiness-probes" },
        { text: "Storage Schema", link: "/reference/storage-schema" },
        { text: "Journal Compaction", link: "/reference/journal-compaction" },
        { text: "Audit Events", link: "/reference/audit-events" },
        { text: "Observation Retention", link: "/reference/observation-retention" },
        { text: "Drift Detection", link: "/reference/drift-detection" },
        { text: "Closed Enums", link: "/reference/closed-enums" },
        { text: "Access Modes", link: "/reference/access-modes" },
        {
          text: "Approval Invalidation",
          link: "/reference/approval-invalidation",
        },
        { text: "Risk Taxonomy", link: "/reference/risk-taxonomy" },
        { text: "RevokeDebt Model", link: "/reference/revoke-debt" },
        { text: "Plan Output", link: "/reference/plan-output" },
        { text: "Status Output", link: "/reference/status-output" },
        { text: "Resource IDs", link: "/reference/resource-ids" },
        { text: "Digest Computation", link: "/reference/digest-computation" },
        { text: "Time / Clock Model", link: "/reference/time-clock-model" },
        { text: "Public Spec Source Map", link: "/reference/public-spec-source-map" },
        { text: "Namespace Exports", link: "/reference/namespace-exports" },
        { text: "Connector Contract", link: "/reference/connector-contract" },
        { text: "DataAsset Policy", link: "/reference/data-asset-policy" },
        { text: "Artifact GC", link: "/reference/artifact-gc" },
        { text: "Secret Partitions", link: "/reference/secret-partitions" },
        { text: "Cross-Process Locks", link: "/reference/cross-process-locks" },
        { text: "Catalog Release Trust", link: "/reference/catalog-release-trust" },
        { text: "Supply Chain Trust", link: "/reference/supply-chain-trust" },
        { text: "Workers Backend", link: "/reference/workers-backend" },
      ],
    },
    {
      text: "Extending",
      items: [
        { text: "Takosumi を拡張する", link: "/extending" },
      ],
    },
    {
      text: "RFC",
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
  { text: "Overview", link: "/" },
  { text: "Quickstart", link: "/getting-started/quickstart" },
  { text: "Concepts", link: "/getting-started/concepts" },
  { text: "AppSpec", link: "/reference/app-spec" },
  { text: "Reference", link: "/reference/" },
  { text: "Operator", link: "/operator/" },
];

export default defineConfig({
  title: "Takosumi",
  description:
    "Self-hostable PaaS toolkit — AppSpec-driven multi-cloud deploys",
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
      pattern: "https://github.com/tako0614/takosumi/edit/master/docs/:path",
      text: "GitHub でこのページを編集",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "© Takos / Takosumi contributors",
    },
  },
});
