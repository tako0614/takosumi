import { type DefaultTheme, defineConfig } from "vitepress";

const jaNav: DefaultTheme.NavItem[] = [
  { text: "はじめに", link: "/getting-started/quickstart" },
  { text: "解説", link: "/concepts/" },
  { text: "リファレンス", link: "/reference/api" },
  { text: "Takosumi Cloud", link: "https://app.takosumi.com/docs/" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Software", link: "/en/" },
  { text: "Quickstart", link: "/en/getting-started/quickstart" },
  { text: "Concepts", link: "/en/concepts/" },
  { text: "Reference", link: "/en/reference/api" },
  { text: "Hosted Cloud", link: "https://app.takosumi.com/docs/en/" },
];

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "はじめに",
      items: [
        { text: "Takosumi とは", link: "/" },
        { text: "クイックスタート", link: "/getting-started/quickstart" },
      ],
    },
    {
      text: "解説",
      items: [
        { text: "全体像", link: "/concepts/" },
        { text: "Source と Capsule", link: "/concepts/sources" },
        { text: "実行モデル", link: "/concepts/run-model" },
        { text: "状態と出力", link: "/concepts/state-and-outputs" },
        { text: "認証情報", link: "/concepts/credentials" },
        { text: "Resource", link: "/concepts/resources" },
        { text: "Interface", link: "/concepts/interfaces" },
        { text: "利用量と課金", link: "/concepts/usage-and-billing" },
        { text: "自分で動かす", link: "/concepts/self-host" },
        { text: "製品の境界", link: "/concepts/boundaries" },
      ],
    },
    {
      text: "リファレンス",
      items: [
        { text: "API", link: "/reference/api" },
        { text: "CLI", link: "/reference/cli" },
        { text: "Service Form host API", link: "/reference/takoform-host" },
        { text: "設定", link: "/reference/configuration" },
        {
          text: "Capsule source options",
          link: "/reference/capsule-source-options",
        },
        {
          text: "Operator control MCP",
          link: "/reference/operator-control-mcp",
        },
        { text: "App Handoff", link: "/reference/app-handoff" },
        { text: "用語集", link: "/reference/glossary" },
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Software",
      items: [
        { text: "Takosumi software", link: "/en/" },
        {
          text: "Quickstart",
          link: "/en/getting-started/quickstart",
        },
      ],
    },
    {
      text: "Concepts",
      items: [
        { text: "Overview", link: "/en/concepts/" },
        { text: "Sources and Capsules", link: "/en/concepts/sources" },
        { text: "Run model", link: "/en/concepts/run-model" },
        { text: "State and outputs", link: "/en/concepts/state-and-outputs" },
        { text: "Credentials", link: "/en/concepts/credentials" },
        { text: "Resources", link: "/en/concepts/resources" },
        { text: "Interfaces", link: "/en/concepts/interfaces" },
        { text: "Usage and billing", link: "/en/concepts/usage-and-billing" },
        { text: "Running it yourself", link: "/en/concepts/self-host" },
        { text: "Product boundaries", link: "/en/concepts/boundaries" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "API", link: "/en/reference/api" },
        { text: "CLI", link: "/en/reference/cli" },
        {
          text: "Capsule source options",
          link: "/en/reference/capsule-source-options",
        },
        {
          text: "Operator control MCP",
          link: "/en/reference/operator-control-mcp",
        },
        { text: "App Handoff", link: "/en/reference/app-handoff" },
        { text: "Glossary", link: "/en/reference/glossary" },
      ],
    },
  ],
};

export default defineConfig({
  title: "Takosumi",
  description:
    "Git-based OpenTofu control plane, Resource Shape API, and adapter framework",
  lang: "ja",
  base: process.env.VITEPRESS_BASE ?? "/docs/",
  // Public docs must not publish product-local design notes or operator runbooks.
  srcExclude: ["internal/**/*.md", "operations/**/*.md"],
  cleanUrls: true,
  lastUpdated: true,
  vite: {
    build: {
      target: "esnext",
      chunkSizeWarningLimit: 700,
    },
    server: {
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
  locales: {
    root: {
      label: "日本語",
      lang: "ja",
      title: "Takosumi",
      description:
        "Git-based OpenTofu control plane, Resource Shape API, and adapter framework",
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
          message: "AGPL-3.0-only",
          copyright: "© Takosumi contributors",
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
        "Git-based OpenTofu control plane, Resource Shape API, and adapter framework",
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
          message: "AGPL-3.0-only",
          copyright: "© Takosumi contributors",
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
