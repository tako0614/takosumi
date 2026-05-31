# Takosumi

Takosumi is an operator-portable PaaS contract for installing source into a Space and recording each apply as a Deployment. App authors write `.takosumi.yml`; operators decide which official catalog and implementation bindings materialize each component.

Docs: <https://takosumi.com/docs/>

## Quickstart

Run this from a source root that contains `.takosumi.yml` and the files referenced by its kind-specific `spec`.

```bash
npm install -g @takosjp/takosumi
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

See [`docs/reference/kind-packages.md`](./docs/reference/kind-packages.md), [`docs/reference/catalog.md`](./docs/reference/catalog.md), and [`CONVENTIONS.md`](./CONVENTIONS.md).

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

## npm Package

Everything in this repository ships as one npm package, [`@takosjp/takosumi`](https://www.npmjs.com/package/@takosjp/takosumi), reached through subpath exports:

| Subpath                           | Purpose                                       |
| --------------------------------- | --------------------------------------------- |
| `@takosjp/takosumi`               | umbrella entry for core exports               |
| `@takosjp/takosumi/contract`      | manifest and Installer API wire types         |
| `@takosjp/takosumi/kernel`        | reference kernel and Installer API server     |
| `@takosjp/takosumi/installer`     | `.takosumi.yml` parser, source fetch, client  |
| `@takosjp/takosumi/cli`           | `takosumi` command                            |
| `@takosjp/takosumi/runtime-agent` | lifecycle execution host for backend adapters |
| `@takosjp/takosumi/server`        | Installer API server entry                    |

Official kind descriptors are published spec, not package exports. Their source is `docs/kinds/v1/*.jsonld`, and the public URIs are `https://takosumi.com/kinds/v1/<name>`. Native kind implementations and runtime-agent connectors ship as subpaths of the sibling [`@takosjp/takosumi-plugins`](https://www.npmjs.com/package/@takosjp/takosumi-plugins) package (`/kind/<backend-name>`, `/connectors`), which depends on `@takosjp/takosumi` as a peer. Current implementation subpaths are listed in [`docs/reference/kind-packages.md`](./docs/reference/kind-packages.md).

## Workspace Layout

```text
takosumi/
├── package.json                 @takosjp/takosumi exports
├── src/
│   ├── contract/                @takosjp/takosumi/contract
│   ├── kernel/                  @takosjp/takosumi/kernel
│   ├── installer/               @takosjp/takosumi/installer
│   ├── cli/                     @takosjp/takosumi/cli
│   ├── runtime-agent/           @takosjp/takosumi/runtime-agent
│   └── all/                     @takosjp/takosumi umbrella wrappers
├── docs/kinds/v1/*.jsonld       official kind catalog descriptors
├── docs/                        VitePress docs site
├── website/                     takosumi.com landing + merged publish artifact
├── deploy/, fixtures/, scripts/
└── AGENTS.md, CONVENTIONS.md, CHANGELOG.md
```

Canonical contract source is `src/contract/`; the public export is [`@takosjp/takosumi/contract`](https://www.npmjs.com/package/@takosjp/takosumi).

## Development

```bash
bun install --frozen-lockfile
bun run check
bun test ./src/
bun run test:scripts
bun run lint:json-ld
bun run build:npm
```

Per-package examples:

```bash
bun test ./src/cli/tests
bun --preload ./shims/deno-compat.ts src/kernel/scripts/db-migrate.ts --dry-run --env=local
```

## Release

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks the workspace with Bun, builds the npm package through `bun run build:npm`, publishes `@takosjp/takosumi` to npm, and builds/pushes the `takosumi` OCI image to GHCR. Manual workflow runs stay dry-run unless the explicit `publish` input is set. `@takosjp/takosumi` carries its own single version stream; the sibling `@takosjp/takosumi-plugins` is released from its own repository with its own version stream, so there is no ecosystem-wide lockstep GA.

The npm build produces output under `npm/`, and release publishing runs
`npm publish` from that output. dnt itself still runs on Deno under the
`build:npm` wrapper because dnt is distributed through JSR, but the package
source, checks, tests, and release entry points are Bun/npm-owned.

## Docs Site

`takosumi/docs/` is the VitePress site (`base: "/docs/"`). `takosumi/website/` is the Solid Start landing. The Pages output merges landing, docs, JSON-LD contexts, and kind descriptors under the same `takosumi.com` project.

```bash
npm --prefix docs install
npm --prefix docs run dev
npm --prefix docs run build

npm --prefix website install
bash website/build.sh
npm --prefix website run preview
wrangler pages deploy website/.output/public --project-name=takosumi-website
```

Pushing `master` deploys Cloudflare Pages project `takosumi-website` through `.github/workflows/website-deploy.yml`. See [`DEPLOY.md`](./DEPLOY.md) and [`website/README.md`](./website/README.md).
