# Takosumi website design

The public page follows the Takosumi dashboard, not the sibling Takos site. The
dark neutral surfaces, one red action colour, Bricolage Grotesque, JetBrains Mono,
fine rules, and modest radii come from dashboard/src/styles/tokens.css.
website/src/styles/tokens.css holds the website's subset of those tokens.

The homepage begins with the actual dashboard launcher, then shows published
Git/OpenTofu app sources, the Takosumi source-selection UI, and the later
review/management story. These are distinct stages: the Store capture shows
source selection; it does not show connections or a completed installation.
Requirements vary by app. The product captures and their provenance live in
website/src/content/captures.ts and website/scripts/capture-product-ui-provenance.md.

Navigation and app-source links work without JavaScript. Native details reveals
source and app-preview information; the route does not simulate an install.
The fixed install URLs remain in website/src/content/apps.ts and must not be
replaced with a generic catalogue claim.

The OG image and 404 page use the same dark palette. og-cover.svg is the editable
source for og-cover.png (1200 x 630).
