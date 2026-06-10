# takosumi/website

Source for the `takosumi.com` Cloudflare Pages property.

The build is a single Pages artifact:

1. Solid Start landing from `website/`.
2. VitePress docs from `docs/`, served under `/docs/`.

## Build

```bash
bash website/build.sh
```

## Deploy

```bash
bun run website:deploy
```

Attach `takosumi.com` and optionally `www.takosumi.com` in Cloudflare Pages custom domains. The default Pages host remains available for previews.

## Local mirror

The local substrate can serve the generated artifact at `https://takosumi.test/` and the docs at `https://takosumi.test/docs/`.
