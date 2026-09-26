import type { DefaultTheme, UserConfig } from "vitepress";

const jaNav: DefaultTheme.NavItem[] = [
  { text: "Takosumi", link: "/" },
  { text: "Pricing", link: "/pricing" },
  { text: "Resources", link: "/resources" },
  { text: "Endpoints", link: "/endpoints" },
  { text: "Support", link: "/support" },
  { text: "SLA", link: "/sla" },
  { text: "Software docs", link: "https://takosumi.com/docs/" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Takosumi", link: "/en/" },
  { text: "Pricing", link: "/en/pricing" },
  { text: "Resources", link: "/en/resources" },
  { text: "Endpoints", link: "/en/endpoints" },
  { text: "Support", link: "/en/support" },
  { text: "SLA", link: "/en/sla" },
  { text: "Software docs", link: "https://takosumi.com/docs/en/" },
];

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "Takosumi hosted service",
      items: [
        { text: "Overview", link: "/" },
        { text: "Pricing", link: "/pricing" },
        { text: "Resources", link: "/resources" },
        { text: "Endpoints", link: "/endpoints" },
        { text: "Support", link: "/support" },
        { text: "SLA", link: "/sla" },
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Takosumi hosted service",
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

const base = process.env.VITEPRESS_BASE ?? "/docs/";

const config: UserConfig = {
  title: "Takosumi",
  description: "Takosumi hosted service documentation",
  lang: "ja",
  // Local-search indexing mutates MiniSearch as pages finish. A single worker
  // keeps document ids and content-hashed chunks reproducible for release pins.
  buildConcurrency: 1,
  base,
  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Takosumi" }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],
  transformHead({ pageData, title, description }) {
    const route = pageData.relativePath
      .replace(/(^|\/)index\.md$/u, "$1")
      .replace(/\.md$/u, "");
    return [
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      [
        "meta",
        {
          property: "og:url",
          content: new URL(`${base}${route}`, "https://app.takosumi.com/").href,
        },
      ],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
  },
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
      title: "Takosumi",
      description: "Takosumi hosted service documentation",
      themeConfig: {
        nav: jaNav,
        sidebar: jaSidebar,
        outline: { label: "目次" },
        docFooter: { prev: "前へ", next: "次へ" },
        lastUpdatedText: "最終更新",
        darkModeSwitchLabel: "テーマ",
        sidebarMenuLabel: "メニュー",
        returnToTopLabel: "トップへ戻る",
        notFound: {
          title: "ページがありません",
          quote: "URLが正しいか確認するか、検索から探してください。",
          linkText: "トップへ",
        },
        footer: {
          message: "Takosumi hosted service docs",
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
      title: "Takosumi",
      description: "Takosumi hosted service documentation",
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
        outline: { label: "On this page" },
        docFooter: { prev: "Previous", next: "Next" },
        lastUpdatedText: "Last updated",
        darkModeSwitchLabel: "Theme",
        sidebarMenuLabel: "Menu",
        returnToTopLabel: "Return to top",
        notFound: {
          title: "Page not found",
          quote: "Check the URL or use search to find a page.",
          linkText: "Home",
        },
        footer: {
          message: "Takosumi hosted service docs",
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
    // Same mark as app.takosumi.com and the landing (website/public/tako.png).
    logo: "/tako.png",
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
