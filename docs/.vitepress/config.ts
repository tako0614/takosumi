import { type DefaultTheme, defineConfig } from "vitepress";

const jaNav: DefaultTheme.NavItem[] = [
  { text: "Software", link: "/" },
  { text: "Quickstart", link: "/getting-started/quickstart" },
  { text: "Reference", link: "/reference/model" },
  { text: "Hosted Cloud", link: "https://app.takosumi.com/docs/" },
  { text: "Legal", link: "/legal/terms-of-service" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Software", link: "/en/" },
  { text: "Quickstart", link: "/en/getting-started/quickstart" },
  { text: "Reference", link: "/en/reference/model" },
  { text: "Hosted Cloud", link: "https://app.takosumi.com/docs/en/" },
  // Legal pages are English templates shared with the JA tree (no separate /en/legal).
  { text: "Legal", link: "/legal/terms-of-service" },
];

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "Software",
      items: [
        { text: "Takosumi software", link: "/" },
        {
          text: "Quickstart",
          link: "/getting-started/quickstart",
        },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Model", link: "/reference/model" },
        { text: "API", link: "/reference/api" },
        { text: "Deploy Control API", link: "/reference/deploy-control-api" },
        {
          text: "Execution boundaries",
          link: "/reference/operator-execution-boundaries",
        },
        { text: "Operator", link: "/reference/operator" },
        { text: "CLI", link: "/reference/cli" },
        { text: "App Handoff", link: "/reference/app-handoff" },
        { text: "Docs contract", link: "/reference/docs-contract" },
        { text: "用語集", link: "/reference/glossary" },
      ],
    },
    {
      text: "Legal",
      items: [
        { text: "Terms", link: "/legal/terms-of-service" },
        { text: "Privacy", link: "/legal/privacy-policy" },
        { text: "DPA", link: "/legal/data-processing-agreement" },
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
      text: "Reference",
      items: [
        { text: "Model", link: "/en/reference/model" },
        { text: "API", link: "/en/reference/api" },
        {
          text: "Deploy Control API",
          link: "/en/reference/deploy-control-api",
        },
        {
          text: "Execution boundaries",
          link: "/en/reference/operator-execution-boundaries",
        },
        { text: "Operator", link: "/en/reference/operator" },
        { text: "CLI", link: "/en/reference/cli" },
        { text: "App Handoff", link: "/en/reference/app-handoff" },
        { text: "Docs contract", link: "/en/reference/docs-contract" },
        { text: "Glossary", link: "/en/reference/glossary" },
      ],
    },
    {
      text: "Legal",
      items: [
        { text: "Terms", link: "/legal/terms-of-service" },
        { text: "Privacy", link: "/legal/privacy-policy" },
        { text: "DPA", link: "/legal/data-processing-agreement" },
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
