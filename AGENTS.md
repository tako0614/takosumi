# AGENTS.md — Takosumi

This repository is **Takosumi**, an operator-portable PaaS contract and reference kernel. It reads `.takosumi.yml` from source, creates an Installation in a Space, and records each apply as a Deployment. It contains the contract, reference kernel, installer, CLI, generic runtime-agent host, portable official catalog descriptors, and the server entry, all shipped as one npm package (`@takosjp/takosumi`) via subpath exports. Backend-specific native kind plugin packages and concrete runtime-agent connectors ship as the sibling `@takosjp/takosumi-plugins` npm package, sourced from the `takosumi-plugins` repository.

Canonical contract: [`@takosjp/takosumi/contract`](https://www.npmjs.com/package/@takosjp/takosumi) (`packages/contract/`).

## Spec Status

Takosumi AppSpec is kind-agnostic and intentionally small:

- AppSpec root: `apiVersion: "v1"`, `metadata.id`, `metadata.name`,
  `components`, and optional root `publish`
- Component: `{ kind, spec, connect, listen }`
- Root `publish` records Installation output publications.
- `apiVersion` is bare `"v1"`.
- Root `kind: App`, component `build`, `use:` edges, placeholder interpolation, `routes`, `interfaces`, and `permissions` are not part of the contract.

`Component.kind` is an opaque alias or URI. Its meaning comes from operator-injected `kindAliases`, descriptor metadata, Space policy, and the operator's implementation binding. The Installer API carries source and apply requests; it does not define kind semantics.

Official descriptors are package-owned under `packages/kind-*/spec/kind.jsonld` and are published as `https://takosumi.com/kinds/v1/<name>`. Operators may adopt those descriptors or use their own catalog.

## Workspace

```text
takosumi/
├── deno.json
├── packages/
│   ├── contract/                @takosjp/takosumi/contract
│   ├── kernel/                  @takosjp/takosumi/kernel
│   ├── installer/               @takosjp/takosumi/installer
│   ├── cli/                     @takosjp/takosumi/cli
│   ├── runtime-agent/           @takosjp/takosumi/runtime-agent
│   ├── kind-*/                  portable kind descriptors → @takosjp/takosumi/kind/*
│   └── all/                     @takosjp/takosumi (umbrella + subpath exports)
├── docs/, website/, deploy/, fixtures/, scripts/
└── README.md, CONVENTIONS.md, CHANGELOG.md
```

Kind sources are split by ownership; both ship as subpaths of the two published npm packages:

- Portable kinds define author-facing shapes and are exported as `@takosjp/takosumi/kind/<name>` subpaths: `worker`, `web-service`, `postgres`, `sqlite`, `object-store`, `kv-store`, `message-queue`, `vector-store`, `gateway`.
- Native kind plugins and concrete runtime-agent connectors bind concrete backends into the reference kernel, source-located in `../takosumi-plugins`, and exported as `@takosjp/takosumi-plugins/kind/<backend-name>` (plus `@takosjp/takosumi-plugins/connectors`): Cloudflare Workers/R2/DNS, Deno Deploy, AWS Fargate/RDS/S3/Route53, GCP Cloud Run/Cloud SQL/GCS/Cloud DNS, Kubernetes, Docker Compose, systemd, MinIO, filesystem, Docker Postgres, CoreDNS, Cloudflare Containers, and Azure Container Apps.

## Public Concepts

| Concept      | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| AppSpec      | `.takosumi.yml` in a source root                                               |
| Installation | Space-scoped AppSpec record, including the current Deployment pointer/status   |
| Deployment   | one apply result, including history, audit evidence, and rollback target state |

Specification language should stay centered on these concepts. Ownership, billing, permissions, account dashboards, and deploy facades belong to operator distributions such as Takosumi Cloud.

## Connect / Listen / Publish

Component connections use `connect` for deterministic same-AppSpec wiring and
`listen` for Space-visible publications.

- `connect: { <binding>: { output, inject, prefix?, mount? } }` consumes a
  same-AppSpec component output such as `db.connection`.
- `listen: { <binding>: { path?, kind?, labels?, many?, inject, prefix?, mount?, required? } }`
  consumes an exact platform service path such as `identity.primary.oidc` or
  discovers visible publications by material `kind` and labels. `many: true`
  binds every match as one collection material.
- root `publish: { <name>: { output, kind?, path?, labels? } }` records an
  Installation output publication for a materialized component output. `path`
  is optional and only participates in conflict rules when present.

OIDC is platform service output from an operator account plane, for example a
distribution-defined path such as `identity.primary.oidc`. MCP servers and
similar discoverable capabilities are ordinary material kinds, for example the
official `mcp-server@v1` kind. Neither is a special Takosumi core component
kind. Takosumi Cloud defines its concrete paths and publication inventory in
the Cloud docs.

## Source And Build

Takosumi installs source. Build/prepare is owned by CI, workflow automation, or an operator build service. Prepared output is passed to the Installer API as `source.kind: "prepared"`. File paths that matter to runtime belong in the kind's `spec`, such as `worker.spec.entrypoint`.

Do not reintroduce `component.build`, `jobs:`, `steps:`, `matrix:`, `triggers:`, or a pipeline DSL into AppSpec.

## Reference Kernel Binding

The reference implementation uses `KernelPlugin` factories, passed as a plain array:

```ts
createPaaSApp({
  kindAliases,
  plugins: [
    cloudflareWorkerPlugin({ lifecycle: cloudflareWorkerLifecycle }),
    cloudflareR2ObjectStorePlugin({ lifecycle: cloudflareR2Lifecycle }),
  ],
});
```

This is the official reference implementation strategy, similar in shape to Vite plugins. It is not a requirement for compatible implementations. A compatible implementation may bind the same kind URI through a native controller, static registry, workflow engine, or SaaS adapter.

Kernel core must remain cloud-provider neutral. Cloud SDKs, host commands, and backend credentials stay in kind packages, runtime-agent connectors, or operator distribution code.

## Runtime Neutrality

Kernel runtime primitives go through `packages/kernel/src/shared/runtime/`. Do not add direct `Deno.*`, `process.*`, or `node:*` calls in kernel core paths unless they are inside the runtime adapter boundary.

## Installer API

The public Installer API surface is five endpoints:

- `POST /v1/installations/dry-run`
- `POST /v1/installations`
- `POST /v1/installations/{id}/deployments/dry-run`
- `POST /v1/installations/{id}/deployments`
- `POST /v1/installations/{id}/rollback`

Use `409 failed_precondition` for lifecycle guard failures such as source pin mismatch, prepared digest mismatch, expected guard mismatch, missing required platform service, or non-portable local source omission. Use `413 resource_exhausted` for request, manifest, or source size limits. The v1 surface does not use a caller-supplied Idempotency-Key header.

## npm Publish Layout

This repository publishes exactly one npm package, `@takosjp/takosumi`, with its
own single version stream. The sibling `takosumi-plugins` repository publishes the
only other ecosystem package, `@takosjp/takosumi-plugins`, with its own single
version stream. There is no ecosystem-wide lockstep GA version; the ecosystem has
two published packages instead of one stream each.

Core/runtime/tooling are reached as subpath exports of `@takosjp/takosumi`:

- `@takosjp/takosumi/contract`
- `@takosjp/takosumi/kernel`
- `@takosjp/takosumi/installer`
- `@takosjp/takosumi/cli`
- `@takosjp/takosumi/runtime-agent`
- `@takosjp/takosumi/server`
- `@takosjp/takosumi/kinds`
- `@takosjp/takosumi` (umbrella entry)

Portable kinds in this repository are subpath exports of the same package:

- `@takosjp/takosumi/kind/worker`
- `@takosjp/takosumi/kind/web-service`
- `@takosjp/takosumi/kind/postgres`
- `@takosjp/takosumi/kind/sqlite`
- `@takosjp/takosumi/kind/object-store`
- `@takosjp/takosumi/kind/kv-store`
- `@takosjp/takosumi/kind/message-queue`
- `@takosjp/takosumi/kind/vector-store`
- `@takosjp/takosumi/kind/gateway`

Native kinds and connectors in `../takosumi-plugins` are subpath exports of
`@takosjp/takosumi-plugins` (`/kind/<backend-name>` and `/connectors`). That
package depends on `@takosjp/takosumi` as a peer and is published from its own
repository, not from this one.

## Build And Publish Toolchain

Source is Deno-first and published to npm via dnt (Deno→Node Transform). The
build entry in this repository is `scripts/build-npm.ts`; the plugins package
builds via `takosumi-plugins/scripts/dnt-build.ts`. A few Deno subprocess and
`serve` modules are dnt-mapped to Node implementations in the npm output, so
runtime behavior on Deno is unchanged while the published npm package runs on
Node.

## Commands

```bash
deno task check
deno test --allow-all
deno task fmt:check
deno task lint
deno task lint:json-ld
deno task spec:check-drift
deno run -A scripts/build-npm.ts
```

Per-package work should run from the package or product root:

```bash
cd packages/cli && deno task test
cd packages/kernel && deno task db:migrate:dry-run
```

## Work Rules

- Keep public contract changes in `packages/contract/` and update docs/tests in the same change.
- Keep kernel-specific changes in `packages/kernel/`.
- Add or change portable descriptor behavior in the owning `packages/kind-*` package.
- Add or change backend-specific native kind behavior in `../takosumi-plugins/packages/kind-*`.
- Add or change concrete runtime-agent connectors in `../takosumi-plugins/packages/runtime-agent-connectors/`.
- Add new official portable catalog descriptors as package-owned JSON-LD under `packages/kind-*/spec/kind.jsonld`.
- Keep Takos product IDs and Takos-specific services out of Takosumi kernel core.
- Keep account-plane features in operator distribution docs/code, not in Takosumi core.
- Follow [`CONVENTIONS.md`](./CONVENTIONS.md), [`docs/reference/kind-packages.md`](./docs/reference/kind-packages.md), and [`docs/reference/public-spec-source-map.md`](./docs/reference/public-spec-source-map.md) when changing kind packages or public descriptors.
