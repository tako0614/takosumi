import { type DefaultTheme, defineConfig } from "vitepress";

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "はじめに",
      items: [
        { text: "Quickstart", link: "/getting-started/quickstart" },
        { text: "Concepts", link: "/getting-started/concepts" },
      ],
    },
    {
      text: "Manifest",
      items: [
        { text: "Manifest (Shape Model)", link: "/manifest" },
        {
          text: "Manifest Architecture",
          link: "/reference/architecture/manifest-model",
        },
      ],
    },
    {
      text: "Reference / Architecture",
      items: [
        { text: "Overview", link: "/reference/architecture/" },
        {
          text: "API Surface",
          link: "/reference/architecture/api-surface-architecture",
        },
        {
          text: "Manifest Model",
          link: "/reference/architecture/manifest-model",
        },
        {
          text: "Execution Lifecycle",
          link: "/reference/architecture/execution-lifecycle",
        },
        {
          text: "OperationPlan / WAL",
          link:
            "/reference/architecture/operation-plan-write-ahead-journal-model",
        },
        {
          text: "Operator Boundaries",
          link: "/reference/architecture/operator-boundaries",
        },
        {
          text: "Provider Architecture",
          link: "/reference/architecture/paas-provider-architecture",
        },
        {
          text: "Operational Hardening",
          link: "/reference/architecture/operational-hardening-checklist",
        },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Index", link: "/reference/" },
      ],
    },
    {
      text: "Reference / API Surfaces",
      items: [
        { text: "Kernel HTTP API", link: "/reference/kernel-http-api" },
        { text: "Runtime-Agent API", link: "/reference/runtime-agent-api" },
        { text: "CLI", link: "/reference/cli" },
        { text: "Lifecycle Protocol", link: "/reference/lifecycle" },
        {
          text: "Provider / Implementation Contract",
          link: "/reference/provider-implementation-contract",
        },
      ],
    },
    {
      text: "Reference / Manifest & Wire Formats",
      items: [
        { text: "Manifest Validation", link: "/reference/manifest-validation" },
        {
          text: "Manifest Expand Semantics",
          link: "/reference/manifest-expand-semantics",
        },
        { text: "Plan Output Schema", link: "/reference/plan-output" },
        { text: "Status Output Schema", link: "/reference/status-output" },
        { text: "Resource IDs", link: "/reference/resource-ids" },
        { text: "Digest Computation", link: "/reference/digest-computation" },
        { text: "Time and Clock Model", link: "/reference/time-clock-model" },
      ],
    },
    {
      text: "Reference / Lifecycle & Execution",
      items: [
        { text: "Lifecycle Phases", link: "/reference/lifecycle-phases" },
        { text: "WAL Stages", link: "/reference/wal-stages" },
        {
          text: "GroupHead and Rollout",
          link: "/reference/group-head-rollout",
        },
        { text: "Readiness Probes", link: "/reference/readiness-probes" },
      ],
    },
    {
      text: "Reference / Policy / Risk / Approval",
      items: [
        { text: "Closed Enums", link: "/reference/closed-enums" },
        { text: "Access Modes", link: "/reference/access-modes" },
        {
          text: "Approval Invalidation",
          link: "/reference/approval-invalidation",
        },
        { text: "Risk Taxonomy", link: "/reference/risk-taxonomy" },
        { text: "RevokeDebt Model", link: "/reference/revoke-debt" },
      ],
    },
    {
      text: "Reference / Storage & Observability",
      items: [
        { text: "Storage Schema", link: "/reference/storage-schema" },
        { text: "Journal Compaction", link: "/reference/journal-compaction" },
        { text: "Audit Events", link: "/reference/audit-events" },
        {
          text: "Observation Retention",
          link: "/reference/observation-retention",
        },
        { text: "Drift Detection", link: "/reference/drift-detection" },
      ],
    },
    {
      text: "Reference / Identity & Access",
      items: [
        {
          text: "Actor / Organization Model",
          link: "/reference/actor-organization-model",
        },
        { text: "RBAC Policy", link: "/reference/rbac-policy" },
        { text: "API Key Management", link: "/reference/api-key-management" },
        { text: "Auth Providers", link: "/reference/auth-providers" },
      ],
    },
    {
      text: "Reference / Security & Trust",
      items: [
        { text: "Secret Partitions", link: "/reference/secret-partitions" },
        { text: "Cross-Process Locks", link: "/reference/cross-process-locks" },
        {
          text: "Catalog Release Trust",
          link: "/reference/catalog-release-trust",
        },
        {
          text: "External Participants",
          link: "/reference/external-participants",
        },
      ],
    },
    {
      text: "Reference / Tenant Lifecycle",
      items: [
        { text: "Tenant Provisioning", link: "/reference/tenant-provisioning" },
        { text: "Trial Spaces", link: "/reference/trial-spaces" },
        {
          text: "Tenant Export and Deletion",
          link: "/reference/tenant-export-deletion",
        },
      ],
    },
    {
      text: "Reference / Operations",
      items: [
        { text: "Bootstrap Protocol", link: "/reference/bootstrap-protocol" },
        { text: "Migration / Upgrade", link: "/reference/migration-upgrade" },
        { text: "Backup and Restore", link: "/reference/backup-restore" },
        { text: "Quota / Rate Limit", link: "/reference/quota-rate-limit" },
        {
          text: "Compliance Retention",
          link: "/reference/compliance-retention",
        },
        { text: "Telemetry and Metrics", link: "/reference/telemetry-metrics" },
        { text: "Logging Conventions", link: "/reference/logging-conventions" },
      ],
    },
    {
      text: "Reference / PaaS Operations",
      items: [
        { text: "Quota Tiers", link: "/reference/quota-tiers" },
        { text: "Cost Attribution", link: "/reference/cost-attribution" },
        {
          text: "SLA Breach Detection",
          link: "/reference/sla-breach-detection",
        },
        { text: "Zone Selection", link: "/reference/zone-selection" },
        { text: "Incident Model", link: "/reference/incident-model" },
        {
          text: "Support Impersonation",
          link: "/reference/support-impersonation",
        },
        {
          text: "Notification Emission",
          link: "/reference/notification-emission",
        },
      ],
    },
    {
      text: "Reference / Catalog & Extension",
      items: [
        { text: "Shape Catalog", link: "/reference/shapes" },
        { text: "Provider Plugins", link: "/reference/providers" },
        { text: "Plugin Marketplace", link: "/reference/plugin-marketplace" },
        { text: "Templates", link: "/reference/templates" },
        { text: "Artifact Kinds", link: "/reference/artifact-kinds" },
        { text: "Connector Contract", link: "/reference/connector-contract" },
        { text: "DataAsset Policy", link: "/reference/data-asset-policy" },
        { text: "Artifact GC", link: "/reference/artifact-gc" },
        { text: "Space Export Share", link: "/reference/space-export-share" },
      ],
    },
    {
      text: "Reference / Configuration",
      items: [
        { text: "Environment Variables", link: "/reference/env-vars" },
      ],
    },
    {
      text: "Operator",
      items: [
        { text: "Bootstrap", link: "/operator/bootstrap" },
        { text: "Self-host Notes", link: "/operator/self-host" },
        { text: "Upgrade", link: "/operator/upgrade" },
      ],
    },
    {
      text: "Extending",
      items: [
        { text: "Extending Takosumi", link: "/extending" },
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
        { text: "Shape Catalog", link: "/reference/shapes" },
        { text: "Provider Plugins", link: "/reference/providers" },
        { text: "CLI", link: "/reference/cli" },
      ],
    },
  ],
};

const jaNav: DefaultTheme.NavItem[] = [
  { text: "Quickstart", link: "/getting-started/quickstart" },
  { text: "Manifest", link: "/manifest" },
  { text: "Architecture", link: "/reference/architecture/" },
  { text: "Reference", link: "/reference/shapes" },
  { text: "Operator", link: "/operator/bootstrap" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Quickstart", link: "/en/getting-started/quickstart" },
  { text: "Reference (JA)", link: "/reference/shapes" },
];

export default defineConfig({
  title: "Takosumi",
  description:
    "Self-hostable PaaS toolkit — manifest-driven multi-cloud deploys",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: "https://docs.takosumi.com/",
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
