import type { DefaultTheme, UserConfig } from "vitepress";

const jaNav: DefaultTheme.NavItem[] = [
  { text: "アーカイブ", link: "/" },
  { text: "旧料金", link: "/pricing" },
  { text: "旧リソース", link: "/resources" },
  { text: "旧エンドポイント", link: "/endpoints" },
  { text: "旧サポート", link: "/support" },
  { text: "旧SLA", link: "/sla" },
  { text: "OSS 文書", link: "https://takosumi.com/docs/" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Archive", link: "/en/" },
  { text: "Archived pricing", link: "/en/pricing" },
  { text: "Archived resources", link: "/en/resources" },
  { text: "Archived endpoints", link: "/en/endpoints" },
  { text: "Archived support", link: "/en/support" },
  { text: "Archived SLA", link: "/en/sla" },
  { text: "Software docs", link: "https://takosumi.com/docs/en/" },
];

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "Takosumi Cloud 文書アーカイブ",
      items: [
        { text: "概要", link: "/" },
        { text: "旧料金", link: "/pricing" },
        { text: "旧リソース", link: "/resources" },
        { text: "旧エンドポイント", link: "/endpoints" },
        { text: "旧サポート", link: "/support" },
        { text: "旧SLA", link: "/sla" },
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Takosumi Cloud documentation archive",
      items: [
        { text: "Overview", link: "/en/" },
        { text: "Pricing", link: "/en/pricing" },
        { text: "Resources", link: "/en/resources" },
        { text: "Endpoints", link: "/en/endpoints" },
        { text: "Support", link: "/en/support" },
        { text: "SLA", link: "/en/sla" },
      ],
    },
  ],
};

const config: UserConfig = {
  title: "Takosumi Cloud documentation archive",
  description:
    "Historical Takosumi Cloud documentation; not current service authority",
  lang: "ja",
  // Local-search indexing mutates MiniSearch as pages finish. A single worker
  // keeps document ids and content-hashed chunks reproducible for release pins.
  buildConcurrency: 1,
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
      title: "Takosumi Cloud 文書アーカイブ",
      description:
        "退役した Takosumi Cloud の歴史資料。現在のサービス仕様ではありません。",
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
          message:
            "歴史資料: 現在の availability、料金、SLA、support の正本ではありません",
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
      title: "Takosumi Cloud documentation archive",
      description:
        "Historical Takosumi Cloud documentation; not current service authority",
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
          message:
            "Historical archive: not current authority for availability, pricing, SLA, or support",
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
