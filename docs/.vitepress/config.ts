import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type DefaultTheme, defineConfig } from "vitepress";

// Pages rarely carry a frontmatter description. Fall back to the first prose
// paragraph of the Markdown source so a shared link describes the actual page
// rather than repeating the site blurb.
function firstParagraph(srcDir: string, relativePath: string): string | undefined {
  try {
    const raw = readFileSync(path.join(srcDir, relativePath), "utf8");
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    for (const line of body.split("\n")) {
      const text = line.trim();
      if (
        text === "" ||
        text.startsWith("#") ||
        text.startsWith("<") ||
        text.startsWith("```") ||
        text.startsWith("---") ||
        text.startsWith(":::") ||
        text.startsWith("|")
      )
        continue;
      const plain = text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\{#[^}]+\}/g, "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (plain !== "") return plain.slice(0, 200);
    }
  } catch {
    // Fall back to the site-level description below.
  }
  return undefined;
}

const jaNav: DefaultTheme.NavItem[] = [
  { text: "はじめに", link: "/getting-started/quickstart" },
  { text: "解説", link: "/concepts/" },
  { text: "リファレンス", link: "/reference/api" },
  { text: "Takosumi Hosted", link: "https://app.takosumi.com/docs/" },
];

const enNav: DefaultTheme.NavItem[] = [
  { text: "Software", link: "/en/" },
  { text: "Quickstart", link: "/en/getting-started/quickstart" },
  { text: "Concepts", link: "/en/concepts/" },
  { text: "Reference", link: "/en/reference/api" },
  { text: "Takosumi Hosted", link: "https://app.takosumi.com/docs/en/" },
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
        { text: "Interface", link: "/concepts/interfaces" },
        { text: "利用量と課金", link: "/concepts/usage-and-billing" },
        { text: "自分で動かす", link: "/concepts/self-host" },
        { text: "製品の境界", link: "/concepts/boundaries" },
      ],
    },
    {
      text: "移行・旧 Resource / Form Host",
      items: [
        { text: "Resource の移行メモ", link: "/concepts/resources" },
        {
          text: "Takoform provider integration (migration)",
          link: "/reference/takoform-host",
        },
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
        { text: "Interfaces", link: "/en/concepts/interfaces" },
        { text: "Usage and billing", link: "/en/concepts/usage-and-billing" },
        { text: "Running it yourself", link: "/en/concepts/self-host" },
        { text: "Product boundaries", link: "/en/concepts/boundaries" },
      ],
    },
    {
      text: "Migration and historical notes",
      items: [
        { text: "Resource migration note", link: "/en/concepts/resources" },
        {
          text: "Takoform provider integration (migration)",
          link: "/en/reference/takoform-host",
        },
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
        { text: "Glossary", link: "/en/reference/glossary" },
      ],
    },
  ],
};

const base = process.env.VITEPRESS_BASE ?? "/docs/";

export default defineConfig({
  title: "Takosumi",
  description:
    "Git-based OpenTofu control plane with provider-neutral connections and interfaces",
  lang: "ja",
  base,
  head: [
    [
      "link",
      { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Takosumi" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  transformHead({ pageData, siteConfig, title, description }) {
    const route = pageData.relativePath
      .replace(/(^|\/)index\.md$/u, "$1")
      .replace(/\.md$/u, "");
    const ogDescription = pageData.frontmatter?.description
      ? description
      : (siteConfig?.srcDir
          ? firstParagraph(siteConfig.srcDir, pageData.relativePath)
          : undefined) ?? description;
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
      ["meta", { property: "og:description", content: ogDescription }],
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
      ["meta", { name: "twitter:description", content: ogDescription }],
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
        "Git-based OpenTofu control plane with provider-neutral connections and interfaces",
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
        "Git-based OpenTofu control plane with provider-neutral connections and interfaces",
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
