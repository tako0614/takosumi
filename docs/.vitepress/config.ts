import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type DefaultTheme, defineConfig } from "vitepress";
import { scrollableTables } from "./scrollable-tables";
import { slugify } from "./slugify";
import { stackedTables } from "./stacked-tables";
import { firstParagraphText, wrappedLines } from "./wrapped-lines";

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
  { text: "はじめに", link: "/getting-started/quickstart", activeMatch: "^/(getting-started/(quickstart|after-adding)|concepts/boundaries)" },
  { text: "解説", link: "/concepts/", activeMatch: "^/concepts/(?!self-host|boundaries)" },
  { text: "自分で運用", link: "/concepts/self-host", activeMatch: "^/(concepts/self-host|self-host/)" },
  { text: "リファレンス", link: "/reference/api" },
  { text: "公式ホスティング", link: "https://app.takosumi.com/docs/" },
];

// The site title already links to /en/, as the Japanese title does to /.
const enNav: DefaultTheme.NavItem[] = [
  { text: "Getting started", link: "/en/getting-started/quickstart", activeMatch: "^/en/(getting-started/(quickstart|after-adding)|concepts/boundaries)" },
  { text: "Concepts", link: "/en/concepts/", activeMatch: "^/en/concepts/(?!self-host|boundaries)" },
  { text: "Self-host", link: "/en/concepts/self-host", activeMatch: "^/en/(concepts/self-host|self-host/)" },
  { text: "Reference", link: "/en/reference/api" },
  { text: "Hosted service", link: "https://app.takosumi.com/docs/en/" },
];

const jaSidebar: DefaultTheme.SidebarMulti = {
  "/": [
    {
      text: "はじめに",
      items: [
        { text: "Takosumi とは", link: "/" },
        { text: "クイックスタート", link: "/getting-started/quickstart" },
        { text: "更新・戻す・削除", link: "/getting-started/after-adding" },
        { text: "製品の境界", link: "/concepts/boundaries" },
      ],
    },
    {
      text: "作る",
      items: [
        { text: "リポジトリを用意する", link: "/getting-started/prepare-repository" },
        { text: "API だけ動かす", link: "/getting-started/api-only" },
      ],
    },
    {
      text: "解説",
      items: [
        { text: "全体像", link: "/concepts/" },
        { text: "Source と Capsule", link: "/concepts/sources" },
        { text: "実行モデル", link: "/concepts/run-model" },
        { text: "状態と出力", link: "/concepts/state-and-outputs" },
        { text: "削除の予約", link: "/concepts/scheduled-uninstall" },
        { text: "認証情報", link: "/concepts/credentials" },
        { text: "Interface", link: "/concepts/interfaces" },
        { text: "利用量と課金", link: "/concepts/usage-and-billing" },
      ],
    },
    {
      text: "自分で運用",
      items: [
        { text: "自分で動かす", link: "/concepts/self-host" },
        { text: "運用ガイド", link: "/self-host/" },
        { text: "Takosumi 本体を更新する", link: "/self-host/upgrade" },
        { text: "バックアップと復旧", link: "/self-host/backup-restore" },
        { text: "トラブルシューティング", link: "/self-host/troubleshooting" },
      ],
    },
    {
      text: "リファレンス",
      items: [
        { text: "API", link: "/reference/api" },
        { text: "CLI", link: "/reference/cli" },
        { text: "設定", link: "/reference/configuration" },
        {
          text: "Repository manifest",
          link: "/reference/repository-manifest",
        },
        { text: "Store API", link: "/reference/store-api" },
        {
          text: "Operator control MCP",
          link: "/reference/operator-control-mcp",
        },
        { text: "App Handoff", link: "/reference/app-handoff" },
        { text: "共通アカウント", link: "/reference/shared-account" },
        { text: "用語集", link: "/reference/glossary" },
      ],
    },
    // Notes for migrating old data; not part of the current product path.
    {
      text: "移行メモ",
      collapsed: true,
      items: [
        { text: "Resource の移行メモ", link: "/concepts/resources" },
        { text: "Takoform provider との境界", link: "/reference/takoform-host" },
      ],
    },
  ],
};

const enSidebar: DefaultTheme.SidebarMulti = {
  "/en/": [
    {
      text: "Getting started",
      items: [
        { text: "Takosumi software", link: "/en/" },
        {
          text: "Quickstart",
          link: "/en/getting-started/quickstart",
        },
        { text: "Update, restore, delete", link: "/en/getting-started/after-adding" },
        { text: "Product boundaries", link: "/en/concepts/boundaries" },
      ],
    },
    {
      text: "Build",
      items: [
        { text: "Prepare a repository", link: "/en/getting-started/prepare-repository" },
        { text: "Run only the API", link: "/en/getting-started/api-only" },
      ],
    },
    {
      text: "Concepts",
      items: [
        { text: "Overview", link: "/en/concepts/" },
        { text: "Sources and Capsules", link: "/en/concepts/sources" },
        { text: "Run model", link: "/en/concepts/run-model" },
        { text: "State and outputs", link: "/en/concepts/state-and-outputs" },
        { text: "Scheduled deletion", link: "/en/concepts/scheduled-uninstall" },
        { text: "Credentials", link: "/en/concepts/credentials" },
        { text: "Interfaces", link: "/en/concepts/interfaces" },
        { text: "Usage and billing", link: "/en/concepts/usage-and-billing" },
      ],
    },
    {
      text: "Self-host",
      items: [
        { text: "Running it yourself", link: "/en/concepts/self-host" },
        { text: "Operations guide", link: "/en/self-host/" },
        { text: "Updating Takosumi itself", link: "/en/self-host/upgrade" },
        { text: "Backup and recovery", link: "/en/self-host/backup-restore" },
        { text: "Troubleshooting", link: "/en/self-host/troubleshooting" },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "API", link: "/en/reference/api" },
        { text: "CLI", link: "/en/reference/cli" },
        { text: "Configuration", link: "/en/reference/configuration" },
        {
          text: "Repository manifest",
          link: "/en/reference/repository-manifest",
        },
        { text: "Store API", link: "/en/reference/store-api" },
        {
          text: "Operator control MCP",
          link: "/en/reference/operator-control-mcp",
        },
        { text: "App Handoff", link: "/en/reference/app-handoff" },
        { text: "Shared account", link: "/en/reference/shared-account" },
        { text: "Glossary", link: "/en/reference/glossary" },
      ],
    },
    // Notes for migrating old data; not part of the current product path.
    {
      text: "Migration notes",
      collapsed: true,
      items: [
        { text: "Resource migration note", link: "/en/concepts/resources" },
        {
          text: "Takoform provider boundary",
          link: "/en/reference/takoform-host",
        },
      ],
    },
  ],
};

const base = process.env.VITEPRESS_BASE ?? "/docs/";

export default defineConfig({
  title: "Takosumi",
  description:
    "Git に置いた OpenTofu / Terraform のソフトウェアを、接続したクラウドへ追加して使うための管理サーバー",
  lang: "ja",
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
    const pageUrl = new URL(`${base}${route}`, "https://takosumi.com/").href;
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
    const jaUrl = new URL(`${base}${jaRoute}`, "https://takosumi.com/").href;
    const enUrl = new URL(`${base}en/${jaRoute}`, "https://takosumi.com/").href;
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
          content: new URL(`${base}og-cover.png`, "https://takosumi.com/").href,
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
          content: new URL(`${base}og-cover.png`, "https://takosumi.com/").href,
        },
      ],
    ];
  },
  // Public docs must not publish product-local design notes or operator runbooks.
  srcExclude: ["internal/**/*.md", "operations/**/*.md"],
  markdown: {
    // The default github-light tokens (red keywords, green headers, orange
    // values) and github-dark comments fall below 4.5:1 on the code block
    // background; these keep every token above it.
    theme: { light: "github-light-high-contrast", dark: "github-dark-default" },
    // Screenshots sit far down long pages; load them as the reader arrives.
    image: { lazyLoading: true },
    // Heading ids keep voiced kana composed so in-page links reach them.
    anchor: { slugify },
    config(md) {
      wrappedLines(md);
      scrollableTables(md);
      stackedTables(md);
    },
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
    hostname: "https://takosumi.com/docs/",
  },
  locales: {
    root: {
      label: "日本語",
      lang: "ja",
      title: "Takosumi",
      description:
        "Git に置いた OpenTofu / Terraform のソフトウェアを、接続したクラウドへ追加して使うための管理サーバー",
      themeConfig: {
        nav: jaNav,
        sidebar: jaSidebar,
        outline: { label: "目次" },
        docFooter: { prev: "前へ", next: "次へ" },
        lastUpdatedText: "最終更新",
        darkModeSwitchLabel: "テーマ",
        lightModeSwitchTitle: "ライトテーマに切り替える",
        darkModeSwitchTitle: "ダークテーマに切り替える",
        sidebarMenuLabel: "メニュー",
        returnToTopLabel: "トップへ戻る",
        skipToContentLabel: "本文へ移動",
        langMenuLabel: "言語を切り替える",
        notFound: {
          title: "ページがありません",
          quote: "URLが正しいか確認するか、検索から探してください。",
          linkText: "トップへ",
        },
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
        "A server that adds Git-hosted OpenTofu and Terraform software to the clouds you connect",
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
});
