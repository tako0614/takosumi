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
          text: "Manifest Model (Design)",
          link: "/design/manifest-model",
        },
      ],
    },
    {
      text: "Design",
      items: [
        { text: "Overview", link: "/design/" },
        { text: "Manifest Model", link: "/design/manifest-model" },
        {
          text: "Core Deployment Model",
          link: "/design/core-deployment-model",
        },
        {
          text: "Execution Lifecycle",
          link: "/design/execution-lifecycle",
        },
        {
          text: "Routing Model",
          link: "/design/routing-model",
        },
        {
          text: "Artifacts and Supply Chain",
          link: "/design/artifacts-and-supply-chain",
        },
        {
          text: "Operator Boundaries",
          link: "/design/operator-boundaries",
        },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Shape Catalog", link: "/reference/shapes" },
        { text: "Provider Plugins", link: "/reference/providers" },
        { text: "Templates", link: "/reference/templates" },
        { text: "CLI", link: "/reference/cli" },
        { text: "Kernel HTTP API", link: "/reference/kernel-http-api" },
        { text: "Runtime-Agent API", link: "/reference/runtime-agent-api" },
        { text: "Environment Variables", link: "/reference/env-vars" },
        { text: "Artifact Kinds", link: "/reference/artifact-kinds" },
        { text: "Lifecycle Protocol", link: "/reference/lifecycle" },
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
  { text: "Design", link: "/design/" },
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
  ignoreDeadLinks: false,
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
