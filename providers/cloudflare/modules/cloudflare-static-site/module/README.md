# cloudflare-static-site (first-party Capsule module)

Creates a Cloudflare Pages project that serves a static site.

- Provider: `cloudflare/cloudflare` (v5). Authentication is via environment
  variables minted by Takosumi at dispatch (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`); this module never embeds secrets.
- Inputs: `projectName` (string, required), `accountId` (string, required),
  `productionBranch` (string, optional, default `main`).
- Outputs: `project_name`, `url`.

This directory is baked into the runner image at
`/app/templates/cloudflare-static-site/module`. Takosumi generates a root module
that wires this module via `source = "./template-module"` with the typed inputs.
