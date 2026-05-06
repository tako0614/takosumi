---
layout: home

hero:
  name: Takosumi
  text: Self-hostable PaaS toolkit
  tagline: A Deno-native PaaS kernel + runtime-agent + CLI that deploys to AWS / GCP / Cloudflare / Azure / Kubernetes / Docker / systemd from a single manifest.
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: Quickstart
      link: /en/getting-started/quickstart
    - theme: alt
      text: Write a manifest
      link: /manifest
    - theme: alt
      text: GitHub
      link: https://github.com/tako0614/takosumi

features:
  - title: Manifest-driven
    details: |
      Declare portable shapes (`web-service@v1` / `database-postgres@v1` / `object-store@v1` / `custom-domain@v1` / `worker@v1`) in YAML / JSON-LD-compatible manifests. Apply with `takosumi deploy ./manifest.yml`. The project-layout convention (`.takosumi/`) lives in the `takosumi-git` sibling product, not in this kernel CLI.
  - title: Multi-cloud + selfhost
    details: |
      Deploy to AWS / GCP / Cloudflare / Azure / Kubernetes / Deno Deploy / docker-compose / systemd / filesystem from the same manifest spec, backed by 21 bundled provider plugins.
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

Takosumi is distributed as **6 JSR packages**:

| Package                                                                         | Role                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | Type contracts for Shape / Provider / Template            |
| [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | HTTP server + apply pipeline + state DB + worker daemon   |
| [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins)             | Shape catalog + provider plugins + templates + factories  |
| [`@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | Cloud SDK / OS executor (data plane)                      |
| [`@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | CLI for `takosumi deploy` / `takosumi server` and friends |
| [`@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | Umbrella that re-publishes the five packages above        |

See [Concepts (JA)](/getting-started/concepts) for details.

## Related docs

- [Quickstart](/en/getting-started/quickstart) — from `takosumi server` to a
  cloud deploy in one command
- [Manifest (Shape Model) (JA)](/manifest) — `resources[]` / `template:` /
  `${ref:...}` / `${secret-ref:...}` syntax
- [Shape Catalog (JA)](/reference/shapes) — spec / outputs / capabilities for
  all 5 shapes
- [Provider Plugins (JA)](/reference/providers) — cloud × shape matrix for 20
  default providers plus 1 opt-in provider
- [CLI Reference (JA)](/reference/cli) — every subcommand, flag, and env
- [Operator Bootstrap (JA)](/operator/bootstrap) — wire-in example for
  `createTakosumiProductionProviders`
