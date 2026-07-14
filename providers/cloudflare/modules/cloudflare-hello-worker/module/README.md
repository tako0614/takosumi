# cloudflare-hello-worker (example Capsule module)

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

Unlike the static-site example (which needs a Pages deployment), this module
has no build or deploy prerequisite. It is a standalone Git Capsule, not a
built-in Takosumi template.

Install it by selecting this repository, a pinned ref/commit, and this module
path. Takosumi snapshots those Git bytes and generates a root module that wires
the selected child through `source = "./module"`. The runner image contains no
copy of this module.
