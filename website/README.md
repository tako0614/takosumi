# takosumi/website

Source for the `takosumi.com` Cloudflare Pages property. Solid Start landing (static prerender), overlaid with the VitePress reference docs (under `/docs/`) and the JSON-LD context catalog (under `/contexts/`). Single Pages project serves the apex `takosumi.com` and both sub-paths.

Wave M-G (= 2026-05-20) consolidated the previous 2-project layout into this single `takosumi.com/` plus `/docs/*` plus `/contexts/*` build. The legacy `takosumi-site` Pages project (= minimal HTML landing under `takosumi/site/`) and the legacy `takosumi-docs` Pages project (= VitePress under the `docs.takosumi.com` subdomain) are both superseded by this single `takosumi-website` deploy. See [`takosumi/DEPLOY.md`](../DEPLOY.md) for the operator-side dashboard cleanup steps.

## Build

```sh
bash takosumi/website/build.sh
# or, from the repo root:
deno task website:build
```

`build.sh` runs three steps in order:

1. `vinxi build` → `website/.output/public/` (= landing).
2. `vitepress build` → `docs/.vitepress/dist/` → overlaid onto `website/.output/public/docs/` (= reference docs).
3. `spec/contexts/` → overlaid onto `website/.output/public/contexts/` (= JSON-LD context).
4. `packages/plugins/spec/kinds/v1/` → overlaid onto `website/.output/public/kinds/v1/` (= official type catalog descriptors, with extensionless and `.jsonld` variants).

The merged `.output/public/` is the `pages_build_output_dir` declared in `wrangler.toml`.

## Deploy

Operator one-time setup:

```sh
wrangler pages project create takosumi-website
# Then in the Cloudflare dashboard:
#   Workers & Pages → takosumi-website → Custom domains
#   Add `takosumi.com`
#   Add `www.takosumi.com` (optional)
```

Per-deploy:

```sh
deno task website:build
wrangler pages deploy website/.output/public --project-name=takosumi-website
# or:
deno task website:deploy
```

The default Pages host `takosumi-website.pages.dev` stays available for preview deploys. See [`DEPLOY.md`](../DEPLOY.md) for full prerequisites and smoke checks.

## Local mirror

In the local-substrate (`takosumi/deploy/local-substrate/`), Caddy serves the website artifact at `https://takosumi.test/` and the same docs at `https://takosumi.test/docs/`. See [`takosumi/deploy/local-substrate/docs/production-deploy-cloudflare.md`](../deploy/local-substrate/docs/production-deploy-cloudflare.md).
