import type { DefaultTheme, UserConfig } from "vitepress";

const jaNav: DefaultTheme.NavItem[] = [
  { text: "Cloud", link: "/" },
  { text: "Pricing", link: "/pricing" },
  { text: "Resources", link: "/resources" },
  { text: "Endpoints", link: "/endpoints" },
  { text: "Software docs", link: "https://takosumi.com/docs/" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Cloud", link: "/en/" },
  { text: "Pricing", link: "/en/pricing" },
  { text: "Resources", link: "/en/resources" },
  { text: "Endpoints", link: "/en/endpoints" },
  { text: "Software docs", link: "https://takosumi.com/docs/en/" },
];

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "Takosumi Cloud",
      items: [
        { text: "Overview", link: "/" },
        { text: "Pricing", link: "/pricing" },
        { text: "Resources", link: "/resources" },
        { text: "Endpoints", link: "/endpoints" },
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Takosumi Cloud",
      items: [
        { text: "Overview", link: "/en/" },
        { text: "Pricing", link: "/en/pricing" },
        { text: "Resources", link: "/en/resources" },
        { text: "Endpoints", link: "/en/endpoints" },
      ],
    },
  ],
};

const config: UserConfig = {
  title: "Takosumi Cloud",
  description: "Hosted Takosumi Cloud service documentation",
  lang: "ja",
  base: process.env.VITEPRESS_BASE ?? "/docs/",
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
    hostname: "https://app.takosumi.com/docs/",
  },
  locales: {
    root: {
      label: "日本語",
      lang: "ja",
      title: "Takosumi Cloud",
      description: "Hosted Takosumi Cloud service documentation",
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
          message: "Takosumi Cloud hosted service docs",
          copyright: "© Takosumi contributors",
        },
        editLink: {
          pattern:
            "https://github.com/tako0614/takosumi/edit/main/app-docs/:path",
          text: "GitHub でこのページを編集",
        },
      },
    },
    en: {
      label: "English",
      link: "/en/",
      lang: "en-US",
      title: "Takosumi Cloud",
      description: "Hosted Takosumi Cloud service documentation",
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
          message: "Takosumi Cloud hosted service docs",
          copyright: "© Takosumi contributors",
        },
        editLink: {
          pattern:
            "https://github.com/tako0614/takosumi/edit/main/app-docs/:path",
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
};

export default config;
