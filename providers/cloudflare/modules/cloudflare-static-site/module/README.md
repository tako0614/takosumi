# cloudflare-static-site (example Capsule module)

Creates a Cloudflare Pages project that serves a static site.

- Provider: `cloudflare/cloudflare` (v5). Authentication is via environment
  variables minted by Takosumi at dispatch (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`); this module never embeds secrets.
- Inputs: `projectName` (string, required), `accountId` (string, required),
  `productionBranch` (string, optional, default `main`).
- Outputs: `project_name`, `url`.

Install it by selecting this repository, a pinned ref/commit, and this module
path. Takosumi snapshots those Git bytes and generates a root module that wires
the selected child through `source = "./module"`. The runner image contains no
copy of this module.
