// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

// schema.org identity for the landing. Takosumi is the OpenTofu-native deploy
// control plane / substrate — NOT the chat/docs product (that is Takos).
const SITE_TITLE = "Takosumi — your service, your server.";
const SITE_DESC =
  "Git のインフラコードを好きなクラウドに deploy。鍵も状態も履歴も、あなたの手元で管理する、オープンソースの deploy 基盤。";

const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Takosumi",
  url: "https://takosumi.com/",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Cross-platform",
  description: SITE_DESC,
  license: "https://www.gnu.org/licenses/agpl-3.0.html",
  sameAs: ["https://github.com/tako0614/takosumi"],
});

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="ja">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{SITE_TITLE}</title>
          <meta name="description" content={SITE_DESC} />
          <link rel="canonical" href="https://takosumi.com/" />
          <meta property="og:site_name" content="Takosumi" />
          <meta property="og:locale" content="ja_JP" />
          <meta property="og:title" content={SITE_TITLE} />
          <meta property="og:description" content={SITE_DESC} />
          <meta property="og:url" content="https://takosumi.com/" />
          <meta property="og:type" content="website" />
          <meta
            property="og:image"
            content="https://takosumi.com/brand/og-cover.svg"
          />
          <meta property="og:image:type" content="image/svg+xml" />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content={SITE_TITLE} />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content={SITE_TITLE} />
          <meta name="twitter:description" content={SITE_DESC} />
          <meta
            name="twitter:image"
            content="https://takosumi.com/brand/og-cover.svg"
          />
          <meta name="theme-color" content="#0a0a0a" />
          <link rel="icon" href="/brand/favicon.svg" />
          <link rel="apple-touch-icon" href="/brand/favicon.svg" />
          <script type="application/ld+json" innerHTML={JSON_LD} />
          {assets}
        </head>
        <body>
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));
