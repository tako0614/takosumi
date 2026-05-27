# Takosumi

Takosumi is an operator-portable PaaS contract for installing source into a Space and recording each apply as a Deployment. App authors write `.takosumi.yml`; operators decide which official type catalog and implementation bindings materialize each component.

Docs: <https://takosumi.com/docs/>

## Quickstart

Run this from a source root that contains `.takosumi.yml` and the files referenced by its kind-specific `spec`.

```bash
deno install -gA -n takosumi jsr:@takos/takosumi-cli
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788 &
takosumi install dry-run \
  --remote http://127.0.0.1:8788 \
  --space space:personal \
  --source .
```

Managed or remote operators use the operator-issued token and URL:

```bash
export TAKOSUMI_INSTALLER_TOKEN=<operator-issued-installer-token>
export TAKOSUMI_REMOTE_URL=https://kernel.example.com
takosumi install --source git:https://github.com/example/notes#v1.2.3 \
  --space space:personal
```

## Minimal Manifest

This example assumes the operator adopts the Takosumi official aliases `postgres` and `worker`. Another operator can use its own aliases or full kind URIs.

```yaml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Example Notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
```

`web` connects to the `db.connection` output and receives runtime values such as `DB_HOST`, `DB_PORT`, and secretRef-mediated connection strings. Same-manifest component connections use `connect`. Operator platform services use `listen.path`, for example `path: identity.primary.oidc`. Root `publish` records an Installation output service path declaration for a component output.

## Core Concepts

| Concept      | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| manifest     | `.takosumi.yml` in the source root                                             |
| Installation | the Space record for an installed manifest, including the current Deployment   |
| Deployment   | one apply result, including history, audit evidence, and rollback target state |

Takosumi's public lifecycle is centered on these three entities. Ownership, billing, account grants, dashboards, and deploy facades belong to operator distributions such as Takosumi Cloud.

## Kinds

`Component.kind` is an operator-resolved alias or URI. Takosumi core treats it as opaque. The descriptor behind a kind defines the component's `spec` shape, outputs and listen compatibility. JSON-LD is the descriptor format for the official catalog; it is not a runtime plugin system.

Takosumi kind packages are split by repository:

- This repository ships portable kind packages that define author-facing shapes such as `worker`, `web-service`, `postgres`, `sqlite`, `object-store`, `kv-store`, `message-queue`, `vector-store`, and `gateway`.
- The sibling `takosumi-plugins` repository ships native kind packages that bind a concrete backend into the reference kernel, such as `cloudflare-worker`, `aws-s3-object-store`, `docker-compose-web-service`, or `coredns-gateway`.

The reference implementation wires native kind packages through `KernelPlugin` factories passed to `createPaaSApp({ kindAliases, plugins })`. Compatible implementations may bind the same kind URIs with another controller, registry, workflow engine, or SaaS adapter.

See [`docs/reference/kind-packages.md`](./docs/reference/kind-packages.md), [`docs/reference/type-catalog.md`](./docs/reference/type-catalog.md), and [`CONVENTIONS.md`](./CONVENTIONS.md).

## CLI

```bash
takosumi install --space <id> --source <source>
takosumi install dry-run --space <id> --source <source>
takosumi deploy <installation-id> [--source <source>]
takosumi deploy dry-run <installation-id> [--source <source>]
takosumi rollback <installation-id> <deploy-id>
takosumi server [--port 8788]
takosumi version
```

Remote mode:

```bash
takosumi install --source git:https://github.com/example/notes#v1.2.3 \
  --space space:personal \
  --remote https://kernel.example.com \
  --token "$TAKOSUMI_INSTALLER_TOKEN"
```

Configuration precedence is **flag > env > `~/.takosumi/config.yml`**.

## JSR Packages

Core/runtime/tooling packages:

| Package                                                                             | Purpose                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`jsr:@takos/takosumi`](https://jsr.io/@takos/takosumi)                             | umbrella package for core exports and portable kind packages |
| [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract)           | manifest and Installer API wire types                        |
| [`jsr:@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)               | reference kernel and Installer API server                    |
| [`jsr:@takos/takosumi-installer`](https://jsr.io/@takos/takosumi-installer)         | `.takosumi.yml` parser, source fetch, deploy client          |
| [`jsr:@takos/takosumi-cli`](https://jsr.io/@takos/takosumi-cli)                     | `takosumi` command                                           |
| [`jsr:@takos/takosumi-runtime-agent`](https://jsr.io/@takos/takosumi-runtime-agent) | lifecycle execution host for backend adapters                |

Kind packages use the pattern `jsr:@takos/takosumi-kind-<name>`. Portable package source lives here; native package source lives in `takosumi-plugins`. Current package names are listed in [`docs/reference/kind-packages.md`](./docs/reference/kind-packages.md). Operators import only the kind packages they need.

## Workspace Layout

```text
takosumi/
├── packages/
│   ├── contract/                @takos/takosumi-contract
│   ├── kernel/                  @takos/takosumi-kernel
│   ├── installer/               @takos/takosumi-installer
│   ├── cli/                     @takos/takosumi-cli
│   ├── runtime-agent/           @takos/takosumi-runtime-agent
│   ├── kind-*/                  portable @takos/takosumi-kind-*
│   └── all/                     @takos/takosumi
├── docs/                        VitePress docs site
├── website/                     takosumi.com landing + merged publish artifact
├── deploy/, fixtures/, scripts/
└── AGENTS.md, CONVENTIONS.md, CHANGELOG.md
```

Canonical contract source is `packages/contract/`; the public package is [`jsr:@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract).

## Development

```bash
deno task check
deno test --allow-all
deno task fmt:check
deno task lint
deno task lint:json-ld
deno task spec:check-drift
deno task publish:dry-run
```

Per-package examples:

```bash
cd packages/cli && deno task test
cd packages/kernel && deno task db:migrate:dry-run
```

## Release

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks the workspace, runs tests, performs a JSR dry-run, publishes the Takosumi JSR packages with GitHub OIDC, and builds/pushes the `takosumi` OCI image to GHCR. Manual workflow runs stay dry-run unless the explicit `publish` input is set.

## Docs Site

`takosumi/docs/` is the VitePress site (`base: "/docs/"`). `takosumi/website/` is the Solid Start landing. The Pages output merges landing, docs, JSON-LD contexts, and kind descriptors under the same `takosumi.com` project.

```bash
deno task docs:install
deno task docs:dev
deno task docs:build

deno task website:build
deno task website:preview
deno task website:deploy
```

Pushing `master` deploys Cloudflare Pages project `takosumi-website` through `.github/workflows/website-deploy.yml`. See [`DEPLOY.md`](./DEPLOY.md) and [`website/README.md`](./website/README.md).
