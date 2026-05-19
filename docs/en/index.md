---
layout: home

hero:
  name: Takosumi
  text: Self-hostable PaaS toolkit
  tagline: A Deno-native PaaS kernel + runtime-agent + CLI that installs AppSpec sources to AWS / GCP / Cloudflare / Azure / Kubernetes / Docker / systemd.
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: Quickstart
      link: /en/getting-started/quickstart
    - theme: alt
      text: Write AppSpec
      link: /reference/app-spec
    - theme: alt
      text: GitHub
      link: https://github.com/tako0614/takosumi

features:
  - title: AppSpec-driven
    details: |
      Declare portable components (`worker` / `postgres` / `object-store` / `custom-domain`) in a root `.takosumi.yml` AppSpec, plus operator-defined kinds via JSON-LD. Install with `takosumi install --source . --space <space-id>`. (Historical note: `oidc` issuance was an earlier 5th curated kind and has since moved to takosumi-cloud as a namespace pub; see the [Kind Catalog](../reference/kind-catalog.md#component-kinds) for the current 4-kind canonical list.)
  - title: Multi-cloud + selfhost
    details: |
      Deploy to AWS / GCP / Cloudflare / Azure / Kubernetes / Deno Deploy / docker-compose / systemd / filesystem from the same AppSpec, backed by bundled provider plugins.
  - title: Self-hostable, JSR-distributed
    details: |
      The kernel and runtime-agent ship via JSR (`@takos/takosumi-kernel`, `@takos/takosumi-runtime-agent`). Run `takosumi server` in a single Deno process to bring up both the control plane and the agent.
  - title: Plugin / agent separation
    details: |
      The kernel never calls cloud SDKs directly. The runtime-agent owns SigV4 / OAuth / kubectl / docker, and credentials live only on the agent side. Control plane and data plane responsibilities stay clearly separated.
  - title: Artifact upload
    details: |
      Beyond OCI image URIs, upload content-addressed `js-bundle` / `lambda-zip` / `static-bundle` / `wasm` artifacts via `takosumi artifact push` and reference them by hash from the manifest.
  - title: Operator-friendly
    details: |
      Save remote / token in `~/.takosumi/config.yml`, generate shell completion via `takosumi completions <shell>`, and emit systemd / docker templates with `takosumi server --detach`.
---

::: info Translation status Reference, operator, and extending docs remain in
Japanese. The Quickstart and this landing page are translated; deeper docs link
back to the JA versions. :::

## Architecture

Takosumi is distributed as **core 6 packages + umbrella + 6 separate cloud
provider packages = 13 JSR packages total** (operators install only the cloud
provider packages they need).

### Core (6 packages + umbrella)

| Package                                                                         | Role                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | Type contracts for AppSpec / installer / provider APIs                       |
| [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | HTTP server + installer API + state DB + worker daemon                       |
| [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | Component kind catalog + materializer host + factories                       |
| [`@takos/takosumi-installer`](https://jsr.io/@takos/takosumi-installer)         | `.takosumi.yml` parser + git fetch + deploy client                           |
| [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | Cloud SDK / OS executor (data plane)                                         |
| [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | CLI for `takosumi install` / `takosumi server` and friends                   |
| [`@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | Umbrella re-publishing the core 6 (cloud providers are installed separately) |

The `@takos/` JSR scope is the **reference distribution** that Takos publishes;
authority lives in the contract (`@takos/takosumi-contract`), not in the
publisher. Contract-compatible alternative publishers (e.g.,
`@example/takosumi-kernel`) are spec-permitted — currently untested, but they
hold no architectural privilege over the reference distribution.

### Cloud provider (6 separate packages)

Operators install only the providers they need.

| Package                                                                                         | Role                                                |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`@takos/takosumi-cloudflare-providers`](https://jsr.io/@takos/takosumi-cloudflare-providers)   | Cloudflare (Workers / R2 / DNS) factories           |
| [`@takos/takosumi-aws-providers`](https://jsr.io/@takos/takosumi-aws-providers)                 | AWS (Fargate / S3 / RDS / Route53) factories        |
| [`@takos/takosumi-gcp-providers`](https://jsr.io/@takos/takosumi-gcp-providers)                 | GCP (Cloud Run / GCS / Cloud SQL) factories         |
| [`@takos/takosumi-kubernetes-providers`](https://jsr.io/@takos/takosumi-kubernetes-providers)   | Kubernetes Deployment + Service factory             |
| [`@takos/takosumi-deno-deploy-providers`](https://jsr.io/@takos/takosumi-deno-deploy-providers) | Deno Deploy factory                                 |
| [`@takos/takosumi-selfhost-providers`](https://jsr.io/@takos/takosumi-selfhost-providers)       | Self-host (docker / systemd / filesystem) factories |

See [Concepts (JA)](/getting-started/concepts) for details.

## Related docs

- [Quickstart](/en/getting-started/quickstart) — from `takosumi server` to a
  cloud deploy in one command
- [Manifest / AppSpec (JA)](/manifest) — `.takosumi.yml` AppSpec and component
  graph
- [Kind Catalog (JA)](../reference/kind-catalog.md#component-kinds) — spec /
  outputs / capabilities for the 4 curated kinds, extensible via
  operator-defined kinds
- [Provider Plugins (JA)](../reference/providers.md) — cloud × kind matrix for
  20 default providers plus 1 opt-in provider
- [CLI Reference (JA)](../reference/cli.md) — every subcommand, flag, and env
- [Operator Bootstrap (JA)](/operator/bootstrap) — wire-in example for
  `createPaaSApp({ plugins })` plain-array attach
