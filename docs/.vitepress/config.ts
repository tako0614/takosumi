import { type DefaultTheme, defineConfig } from "vitepress";

const jaSidebar: DefaultTheme.SidebarMulti = {
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
      text: "案内",
      items: [
        {
          text: "Manifest を書く",
          link: "/getting-started/reading-paths#appspec-authors",
        },
        {
          text: "Operator として動かす",
          link: "/getting-started/reading-paths#operators",
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
          text: "仕様に関わる",
          link: "/getting-started/reading-paths#core-contributors",
        },
      ],
    },
    {
      text: "本体仕様",
      items: [
        {
          text: "仕様境界",
          link: "/reference/spec-boundaries",
        },
        { text: "本体仕様", link: "/reference/core-spec" },
        { text: "Manifest", link: "/reference/manifest" },
        { text: "Installer API", link: "/reference/installer-api" },
        {
          text: "プラットフォームサービス",
          link: "/reference/platform-services",
        },
        { text: "HTTP 公開", link: "/reference/http-exposure" },
      ],
    },
    {
      text: "公式カタログ",
      items: [
        { text: "公式カタログ仕様", link: "/reference/catalog" },
        { text: "Kind Packages", link: "/reference/kind-packages" },
        { text: "Kind Binding 実装", link: "/reference/kind-bindings" },
        {
          text: "Reference Adapter Loading",
          link: "/reference/plugin-loading",
        },
        { text: "アクセスモード", link: "/reference/access-modes" },
      ],
    },
    {
      text: "Takosumi Cloud",
      items: [
        {
          text: "Takosumi Cloud 入口",
          link: "/reference/takosumi-cloud",
        },
      ],
    },
    {
      text: "ビルド連携",
      collapsed: true,
      items: [
        { text: "ビルドサービス境界", link: "/reference/build-spec" },
        {
          text: "ビルドサービス例",
          link: "/operator/build-service-profile",
        },
        { text: "ダイジェスト計算", link: "/reference/digest-computation" },
      ],
    },
    {
      text: "運用",
      collapsed: true,
      items: [
        { text: "運用概要", link: "/operator/" },
        { text: "CLI", link: "/reference/cli" },
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
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Start Here",
      items: [
        { text: "Concepts", link: "/en/getting-started/concepts" },
        { text: "Quickstart", link: "/en/getting-started/quickstart" },
        { text: "Reading Paths", link: "/en/getting-started/reading-paths" },
      ],
    },
    {
      text: "Guide",
      items: [
        {
          text: "Writing Manifests",
          link: "/en/getting-started/reading-paths#appspec-authors",
        },
        {
          text: "Operating Takosumi",
          link: "/en/getting-started/reading-paths#operators",
        },
        {
          text: "Reading Takosumi Cloud",
          link: "/en/getting-started/reading-paths#cloud-operators",
        },
        {
          text: "Extending Takosumi",
          link: "/en/getting-started/reading-paths#provider-extension-authors",
        },
        {
          text: "Working on the Spec",
          link: "/en/getting-started/reading-paths#core-contributors",
        },
      ],
    },
    {
      text: "Core Specification",
      items: [
        {
          text: "Specification Boundaries",
          link: "/en/reference/spec-boundaries",
        },
        { text: "Core Specification", link: "/en/reference/core-spec" },
        { text: "Manifest", link: "/en/reference/manifest" },
        { text: "Installer API", link: "/en/reference/installer-api" },
        {
          text: "Platform Services",
          link: "/en/reference/platform-services",
        },
        { text: "HTTP Exposure", link: "/en/reference/http-exposure" },
      ],
    },
    {
      text: "Official Catalog",
      items: [
        { text: "Official Catalog", link: "/en/reference/catalog" },
        { text: "Kind Packages", link: "/en/reference/kind-packages" },
        {
          text: "Kind Binding Implementations",
          link: "/en/reference/kind-bindings",
        },
        {
          text: "Reference Adapter Loading",
          link: "/en/reference/plugin-loading",
        },
        { text: "Access Modes", link: "/en/reference/access-modes" },
      ],
    },
    {
      text: "Takosumi Cloud",
      items: [
        { text: "Takosumi Cloud Entry", link: "/en/reference/takosumi-cloud" },
      ],
    },
    {
      text: "Build Boundary",
      collapsed: true,
      items: [
        { text: "Build Service Boundary", link: "/en/reference/build-spec" },
        {
          text: "Build Service Example",
          link: "/en/operator/build-service-profile",
        },
        {
          text: "Digest Computation",
          link: "/en/reference/digest-computation",
        },
      ],
    },
    {
      text: "Operations",
      collapsed: true,
      items: [
        { text: "Operator Overview", link: "/en/operator/" },
        { text: "CLI", link: "/en/reference/cli" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Reference Index", link: "/en/reference/" },
        { text: "CLI", link: "/en/reference/cli" },
        { text: "Glossary", link: "/en/reference/glossary" },
      ],
    },
    {
      text: "Extensions",
      items: [
        { text: "Extending Takosumi", link: "/en/extending" },
      ],
    },
  ],
};

const jaNav: DefaultTheme.NavItem[] = [
  { text: "概要", link: "/" },
  { text: "コンセプト", link: "/getting-started/concepts" },
  { text: "クイックスタート", link: "/getting-started/quickstart" },
  { text: "読む順序", link: "/getting-started/reading-paths" },
  { text: "Manifest", link: "/reference/manifest" },
  { text: "リファレンス", link: "/reference/" },
  { text: "運用", link: "/operator/" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Overview", link: "/en/" },
  { text: "Concepts", link: "/en/getting-started/concepts" },
  { text: "Quickstart", link: "/en/getting-started/quickstart" },
  { text: "Reading Paths", link: "/en/getting-started/reading-paths" },
  { text: "Manifest", link: "/en/reference/manifest" },
  { text: "Reference", link: "/en/reference/" },
  { text: "Operations", link: "/en/operator/" },
];

export default defineConfig({
  title: "Takosumi",
  description: "Manifest, Installation, Deployment を中心にした PaaS toolkit",
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
  srcExclude: [
    "operator/{bootstrap,runtime-agent,operator-managed,upgrade}.md",
    "reference/architecture/**",
    "reference/{approval-invalidation,audit-events,backup-restore,bootstrap-protocol,closed-enums,connector-contract,cross-process-locks,data-asset-gc,data-asset-policy,drift-detection,env-vars,group-head-rollout,journal-compaction,kernel-http-api,kind-registry,lifecycle,lifecycle-phases,logging-conventions,migration-upgrade,observability-stack,observation-retention,plan-output,public-spec-source-map,readiness-probes,resource-ids,revoke-debt,risk-taxonomy,runtime-agent-api,secret-partitions,status-output,storage-schema,supply-chain-trust,telemetry-metrics,time-clock-model,wal-stages,workers-backend}.md",
    "rfc/**",
  ],
  locales: {
    root: {
      label: "日本語",
      lang: "ja",
      title: "Takosumi",
      description:
        "Manifest, Installation, Deployment を中心にした PaaS toolkit",
      themeConfig: {
        nav: jaNav,
        sidebar: jaSidebar,
        outline: { label: "目次" },
        docFooter: { prev: "前へ", next: "次へ" },
        lastUpdatedText: "最終更新",
        darkModeSwitchLabel: "テーマ",
        sidebarMenuLabel: "メニュー",
        returnToTopLabel: "トップへ戻る",
        footer: {
          message: "MIT License で公開されています。",
          copyright: "© Takos / Takosumi contributors",
        },
        editLink: {
          pattern: "https://github.com/tako0614/takosumi/edit/main/docs/:path",
          text: "GitHub でこのページを編集",
        },
      },
    },
    en: {
      label: "English",
      link: "/en/",
      lang: "en-US",
      title: "Takosumi",
      description:
        "A PaaS toolkit centered on Manifest, Installation, and Deployment",
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
        outline: { label: "On this page" },
        docFooter: { prev: "Previous", next: "Next" },
        lastUpdatedText: "Last updated",
        darkModeSwitchLabel: "Theme",
        sidebarMenuLabel: "Menu",
        returnToTopLabel: "Return to top",
        footer: {
          message: "Released under the MIT License.",
          copyright: "© Takos / Takosumi contributors",
        },
        editLink: {
          pattern: "https://github.com/tako0614/takosumi/edit/main/docs/:path",
          text: "Edit this page on GitHub",
        },
      },
    },
  },
  themeConfig: {
    socialLinks: [
      { icon: "github", link: "https://github.com/tako0614/takosumi" },
    ],
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: {
                buttonText: "検索",
                buttonAriaLabel: "検索",
              },
              modal: {
                noResultsText: "結果がありません",
                resetButtonTitle: "検索をリセット",
                footer: {
                  selectText: "選択",
                  navigateText: "移動",
                  closeText: "閉じる",
                },
              },
            },
          },
          en: {
            translations: {
              button: {
                buttonText: "Search",
                buttonAriaLabel: "Search",
              },
              modal: {
                noResultsText: "No results",
                resetButtonTitle: "Reset search",
                footer: {
                  selectText: "select",
                  navigateText: "navigate",
                  closeText: "close",
                },
              },
            },
          },
        },
      },
    },
  },
});
