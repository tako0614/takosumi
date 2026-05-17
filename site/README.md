# takosumi.com landing site

Minimal static landing page deployed to Cloudflare Pages at the apex
`takosumi.com`. The site is intentionally low-tech: a single
`index.html` with system-font CSS and three sections (what it is,
where to go, try it). Reference docs live at `docs.takosumi.com` and
the operator Accounts service at `cloud.takosumi.com`.

## Build

```sh
./build.sh
# or, from the repo root:
deno task site:build
```

This produces `dist/index.html` plus anything under `site/static/`.

## Deploy

Operator one-time setup:

```sh
wrangler pages project create takosumi-site
# Then in the Cloudflare dashboard:
#   - Pages → takosumi-site → Custom domains
#   - Add `takosumi.com`
#   - Add `www.takosumi.com` (optional)
```

Per-deploy:

```sh
deno task site:build
wrangler pages deploy ./dist --project-name=takosumi-site
# or:
deno task site:deploy
```

The default Pages host `takosumi-site.pages.dev` stays available for
preview deploys.

## Iterating

This is a static drop-in. To switch to a real SSG (Astro, 11ty, Next
static, …), keep these contracts:

- `./build.sh` (or `deno task site:build`) populates `./dist/`
- `wrangler.toml` keeps `pages_build_output_dir = "./dist"`

Then the deploy task and Pages project stay unchanged.
