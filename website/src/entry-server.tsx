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
    "OpenTofu-native deploy control plane: plain OpenTofu module repos become Capsules, and every plan / apply / destroy is recorded as Run / StateVersion / Output with policy decisions and an audit trail.",
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
          <title>Takosumi — OpenTofu-native deploy control plane</title>
          <meta
            name="description"
            content="Takosumi turns plain OpenTofu module repositories into Capsules and records every plan, apply, destroy, StateVersion, Output, policy decision, and audit trail."
          />
          <link rel="canonical" href="https://takosumi.com/" />
          <meta property="og:site_name" content="Takosumi" />
          <meta
            property="og:title"
            content="Takosumi — OpenTofu-native deploy control plane"
          />
          <meta
            property="og:description"
            content="Plain OpenTofu modules become Capsules. ProviderConnection and policy decide the execution boundary while Takosumi records Runs, StateVersions, Outputs, and audit evidence."
          />
          <meta property="og:url" content="https://takosumi.com/" />
          <meta property="og:type" content="website" />
          <meta
            property="og:image"
            content="https://takosumi.com/brand/og-cover.svg"
          />
          <meta name="twitter:card" content="summary_large_image" />
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
