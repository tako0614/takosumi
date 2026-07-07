# cloudflare-hello-worker (first-party sample Capsule module)

A runnable Cloudflare Worker with **no build step** — the Worker source is
baked inline, so `tofu apply` creates a real Worker script without a separate
build. This sample also enables the script's workers.dev subdomain, so a fresh
install produces a browser-openable URL.

- Provider: `cloudflare/cloudflare` (v5). Authentication is via environment
  variables minted by Takosumi at dispatch (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`); this module never embeds secrets.
- Inputs: `accountId` (string, required), `workersSubdomain` (string,
  required, the account's workers.dev subdomain without `.workers.dev`),
  `appName` (string, optional, default `takosumi-hello`),
  `compatibilityDate` (string, optional).
- Outputs: `worker_name`, `url`.

Unlike `cloudflare-worker-service` (which uploads a built artifact) and
`cloudflare-static-site` (which needs a Pages deployment), this module has no
build or deploy prerequisite — it is a genuine standalone Git capsule.

This directory is baked into the runner image at
`/app/templates/cloudflare-hello-worker/module`. Takosumi generates a root
module that wires it via `source = "./template-module"` with the typed inputs.
