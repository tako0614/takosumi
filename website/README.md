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

The site is deployed by this repository's entrypoint, under the shared rules
in the sibling `takos-control` checkout (`engineering.policy.json` → `deploy`):

```bash
bun run deploy
```

If the surface or fixed adapter is unavailable, publication fails closed. Do
not fall back to a product-local or raw Pages command.

## One-time provisioning

An authorized operator separately creates the Pages project and attaches
`takosumi.com` and optionally `www.takosumi.com` in Cloudflare Pages custom
domains. Pages/DNS provisioning is operator-owned setup, not a release. Its
credentials and realized target configuration stay outside this repository.
The default Pages host remains available for previews.

## Local mirror

The local substrate can serve the generated artifact at `https://takosumi.test/` and the docs at `https://takosumi.test/docs/`.
