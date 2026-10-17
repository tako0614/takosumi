import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DefaultTheme, UserConfig } from "vitepress";
// app-docs has no node_modules of its own; these helpers import nothing at
// runtime and are shared with the software docs. The self-host image's app-docs
// stage copies them (deploy/node-postgres/Dockerfile).
import { scrollableTables } from "../../docs/.vitepress/scrollable-tables";
import { firstParagraphText, wrappedLines } from "../../docs/.vitepress/wrapped-lines";

// Pages rarely carry a frontmatter description. Fall back to the first prose
// paragraph of the Markdown source so a search result or a shared link
// describes the actual page rather than repeating the site blurb.
function firstParagraph(srcDir: string, relativePath: string): string | undefined {
  try {
    return firstParagraphText(readFileSync(path.join(srcDir, relativePath), "utf8"));
  } catch {
    // Fall back to the site-level description below.
  }
  return undefined;
}

const jaNav: DefaultTheme.NavItem[] = [
  { text: "概要", link: "/" },
  { text: "料金", link: "/pricing" },
  { text: "リソース", link: "/resources" },
  { text: "エンドポイント", link: "/endpoints" },
  { text: "サポート", link: "/support" },
  { text: "SLA", link: "/sla" },
  { text: "ソフトウェアのドキュメント", link: "https://takosumi.com/docs/" },
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
        { text: "概要", link: "/" },
        { text: "料金", link: "/pricing" },
        { text: "リソース", link: "/resources" },
        { text: "エンドポイント", link: "/endpoints" },
        { text: "サポート", link: "/support" },
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
      { rel: "icon", type: "image/png", href: `${base}tako.png` },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Takosumi" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  transformPageData(pageData, { siteConfig }) {
    // A frontmatter or head: description is already set; keep it.
    if (pageData.description) return;
    const description = firstParagraph(siteConfig.srcDir, pageData.relativePath);
    // VitePress writes <meta name="description"> without escaping, so a
    // straight double quote from the prose would end the attribute.
    if (description) return { description: description.replace(/"/gu, "”") };
  },
  // `description` is the page's own, from transformPageData, when it has one.
  transformHead({ pageData, siteConfig, title, description }) {
    const route = pageData.relativePath
      .replace(/(^|\/)index\.md$/u, "$1")
      .replace(/\.md$/u, "");
    const pageUrl = new URL(`${base}${route}`, "https://app.takosumi.com/").href;
    // hreflang targets the same page in the other locale when that source file
    // exists; x-default points at the root (Japanese) locale.
    const jaPath = pageData.relativePath.startsWith("en/")
      ? pageData.relativePath.slice(3)
      : pageData.relativePath;
    const jaRoute = jaPath
      .replace(/(^|\/)index\.md$/u, "$1")
      .replace(/\.md$/u, "");
    const hasJa =
      siteConfig?.srcDir !== undefined &&
      existsSync(path.join(siteConfig.srcDir, jaPath));
    const hasEn =
      siteConfig?.srcDir !== undefined &&
      existsSync(path.join(siteConfig.srcDir, `en/${jaPath}`));
    const jaUrl = new URL(`${base}${jaRoute}`, "https://app.takosumi.com/").href;
    const enUrl = new URL(`${base}en/${jaRoute}`, "https://app.takosumi.com/").href;
    const alternates: [string, Record<string, string>][] = [];
    if (hasJa) {
      alternates.push(["link", { rel: "alternate", hreflang: "ja", href: jaUrl }]);
    }
    if (hasEn) {
      alternates.push(["link", { rel: "alternate", hreflang: "en", href: enUrl }]);
    }
    if (hasJa && hasEn) {
      alternates.push([
        "link",
        { rel: "alternate", hreflang: "x-default", href: jaUrl },
      ]);
    }
    return [
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      [
        "meta",
        { property: "og:locale", content: route.startsWith("en/") ? "en_US" : "ja_JP" },
      ],
      [
        "meta",
        {
          property: "og:url",
          content: pageUrl,
        },
      ],
      ["link", { rel: "canonical", href: pageUrl }],
      [
        "meta",
        {
          property: "og:image",
          content: new URL(`${base}og-cover.png`, "https://app.takosumi.com/").href,
        },
      ],
      ["meta", { property: "og:image:type", content: "image/png" }],
      ["meta", { property: "og:image:width", content: "1200" }],
      ["meta", { property: "og:image:height", content: "630" }],
      ...alternates,
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
      [
        "meta",
        {
          name: "twitter:image",
          content: new URL(`${base}og-cover.png`, "https://app.takosumi.com/").href,
        },
      ],
    ];
  },
  markdown: {
    // The default github-light tokens and github-dark comments fall below 4.5:1
    // on the code block background; these keep every token above it.
    theme: { light: "github-light-high-contrast", dark: "github-dark-default" },
    config(md) {
      wrappedLines(md);
      scrollableTables(md);
    },
  },
  cleanUrls: true,
  // Published hosted docs depend on pinned source bytes, not available Git history.
  lastUpdated: false,
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
      description: "Takosumi hosted service のドキュメント",
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
          message: "Takosumi hosted service のドキュメント",
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
