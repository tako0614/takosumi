# Takosumi website design

The public page follows the Takosumi dashboard, not the sibling Takos site. The
dark neutral surfaces, one red action colour, Bricolage Grotesque, JetBrains Mono,
fine rules, and modest radii come from dashboard/src/styles/tokens.css.
website/src/styles/tokens.css holds the website's subset of those tokens.

The homepage begins with the actual dashboard launcher. Each featured app then
shows its own demo screen beside what it does, what it needs, its add link and
its pinned source, in normal flow; nothing real is hidden behind a disclosure.
The add page's review and a workload's 「更新」 tab follow. Section headings are
plain phrases well below the product name's size, and captions use the body
face. The product captures and their provenance live in
website/src/content/captures.ts and website/scripts/capture-product-ui-provenance.md.

Navigation and app-source links work without JavaScript, and the route does not
simulate an install. The fixed install URLs remain in website/src/content/apps.ts
and must not be replaced with a generic catalogue claim.

The share card (og-cover.png, 1200 × 630, also copied to docs/public) and the
404 page carry the same identity, hero line and palette as the homepage.
website/scripts/render-share-card.mjs renders the card from the real mark, the
hero line and the dashboard Home capture; rerun it when either changes.
favicon.ico is the real mark at 48, 32 and 16px.
