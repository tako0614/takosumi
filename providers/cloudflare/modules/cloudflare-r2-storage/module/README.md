# cloudflare-r2-storage (first-party Capsule module)

Creates a single Cloudflare R2 bucket from `bucketName` + `accountId`.

- Provider: `cloudflare/cloudflare` (v5). Authentication is via environment
  variables minted by Takosumi at dispatch (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`); this module never embeds secrets.
- Inputs: `bucketName` (string, required), `accountId` (string, required),
  `location` (string, optional jurisdiction/region hint).
- Outputs: `bucket_name`, `location`.
- No build phase — the OpenTofu surface is the module alone.

This directory is baked into the runner image at
`/app/templates/cloudflare-r2-storage/module`. Takosumi generates a root module
that wires this module via `source = "./template-module"` with the typed inputs.
