import { type DefaultTheme, defineConfig } from "vitepress";

const jaNav: DefaultTheme.NavItem[] = [
  { text: "概要", link: "/" },
  { text: "Quickstart", link: "/getting-started/quickstart" },
  { text: "Model", link: "/reference/model" },
  { text: "API", link: "/reference/deploy-control-api" },
  { text: "Operator", link: "/reference/operator" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Overview", link: "/en/" },
  { text: "Quickstart", link: "/en/getting-started/quickstart" },
  { text: "Model", link: "/en/reference/model" },
  { text: "API", link: "/en/reference/deploy-control-api" },
  { text: "Operator", link: "/en/reference/operator" },
];

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "Start",
      items: [
        { text: "概要", link: "/" },
        { text: "Quickstart", link: "/getting-started/quickstart" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Model", link: "/reference/model" },
        { text: "Deploy Control API", link: "/reference/deploy-control-api" },
        { text: "Runner profiles", link: "/reference/runner-profiles" },
        { text: "Operator", link: "/reference/operator" },
        { text: "CLI", link: "/reference/cli" },
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Start",
      items: [
        { text: "Overview", link: "/en/" },
        { text: "Quickstart", link: "/en/getting-started/quickstart" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Model", link: "/en/reference/model" },
        {
          text: "Deploy Control API",
          link: "/en/reference/deploy-control-api",
        },
        { text: "Runner profiles", link: "/en/reference/runner-profiles" },
        { text: "Operator", link: "/en/reference/operator" },
        { text: "CLI", link: "/en/reference/cli" },
      ],
    },
  ],
};

export default defineConfig({
  title: "Takosumi",
  description:
    "OpenTofu-native deploy control plane, UI, and audit ledger",
  lang: "ja",
  base: process.env.VITEPRESS_BASE ?? "/docs/",
  cleanUrls: true,
  lastUpdated: true,
  vite: {
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
        "OpenTofu-native deploy control plane, UI, and audit ledger",
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
        "OpenTofu-native deploy control plane, UI, and audit ledger",
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
