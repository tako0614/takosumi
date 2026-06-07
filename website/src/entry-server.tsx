// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

// schema.org identity for the landing. Takosumi is the OpenTofu-native deploy
// control plane / substrate — NOT the chat/docs product (that is Takos).
const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Takosumi",
  url: "https://takosumi.com/",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Cross-platform",
  description:
    "OpenTofu-native deploy control plane: plain OpenTofu module repos become Capsule Installations, and every plan / apply / destroy is recorded as Run / Deployment / OutputSnapshot with policy decisions and an audit trail.",
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
          <link rel="canonical" href="https://takosumi.com/" />
          <meta name="theme-color" content="#0a0a0a" />
          <link rel="icon" href="/brand/favicon.svg" />
          <link rel="apple-touch-icon" href="/brand/favicon.svg" />
          <noscript>
            <style>{`.showcase-body[hidden]{display:grid !important}`}</style>
          </noscript>
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
