# AGENTS.md — Takosumi

This repository is **Takosumi**, an operator-portable PaaS contract and reference kernel published as a **framework library you import** (`@takosjp/takosumi`). It provides (a) a programmatic **operate-the-kernel API** (install / deploy / rollback / status) and (b) an **embeddable, extendable Hono `app`** that already mounts the 5 installer endpoints and the kernel API. It reads `.takosumi.yml` from source, creates an Installation in a Space, and records each apply as a Deployment. The framework **never self-serves**: `createPaaSApp` returns the `app` and an operate facade, and the implementation owns production serving, route extension, and runtime capability injection. It contains the contract, reference kernel, installer, CLI, generic runtime-agent host, portable official catalog descriptors, and an optional dev-runner server entry, all shipped as one npm package (`@takosjp/takosumi`) via subpath exports. Backend-specific native kind plugin packages and concrete runtime-agent connectors ship as the sibling `@takosjp/takosumi-plugins` npm package, sourced from the `takosumi-plugins` repository. The reference **composer** that embeds this app, extends it (dashboard / billing / install routes), and serves the one composed app from a single cloud URL is `takosumi-cloud`.

Canonical contract: [`@takosjp/takosumi/contract`](https://www.npmjs.com/package/@takosjp/takosumi) (`src/contract/`).

## Spec Status

Takosumi AppSpec is kind-agnostic and intentionally small:

- AppSpec root: `apiVersion: "v1"`, `metadata.id`, `metadata.name`,
  `components`, and optional root `publish`
- Component: `{ kind, spec, connect, listen }`
- Root `publish` records Installation output publications.
- `apiVersion` is bare `"v1"`.
- Root `kind: App`, component `build`, `use:` edges, placeholder interpolation, `routes`, `interfaces`, and `permissions` are not part of the contract.

`Component.kind` is an opaque alias or URI. Its meaning comes from operator-injected `kindAliases`, descriptor metadata, Space policy, and the operator's implementation binding. The Installer API carries source and apply requests; it does not define kind semantics.

Official kind descriptors are **published spec, not framework source**, and form one catalog with no "native" vs "portable" category split: every descriptor — base kinds and the descriptors that extend them via `portableBase` — is flat JSON-LD under `docs/kinds/v1/<name>.jsonld`, published as `https://takosumi.com/kinds/v1/<name>`. The framework imports none of them, and `takosumi-plugins` holds only implementations that follow them. Operators may adopt those descriptors or use their own catalog.

## Workspace

This repository is one npm package, `@takosjp/takosumi`, sourced from a single `src/` tree (no `packages/` workspace) and built to npm with Bun.

```text
takosumi/
├── package.json                 one package manifest (exports + scripts)
├── src/
│   ├── contract/                @takosjp/takosumi/contract
│   ├── installer/               @takosjp/takosumi/installer
│   ├── kernel/                  reference kernel implementation
│   ├── runtime-agent/           @takosjp/takosumi/runtime-agent
│   ├── cli/                     CLI implementation
│   └── entrypoints/             npm root + server/cli/kernel export wrappers
├── docs/kinds/v1/*.jsonld       official portable kind catalog (published spec)
├── docs/, website/, spec/, deploy/, fixtures/, scripts/
└── README.md, CONVENTIONS.md, CHANGELOG.md
```

Kind surfaces are split by role between the two published packages — but neither is a framework code dependency:

- Portable kind **descriptors** are author-facing JSON-LD shapes, hosted as published spec under `docs/kinds/v1/<name>.jsonld` (`worker`, `web-service`, `postgres`, `sqlite`, `object-store`, `kv-store`, `message-queue`, `vector-store`, `gateway`). They are not a package export.
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

Plugins extend **kinds + materialization + lifecycle** only: `provides[]` kind URIs, `apply` / `destroy` / `status` / `materializeOutput` / `applyBinding`, and install/deploy lifecycle hooks. Plugins do **not** add HTTP routes or middleware and do not transform the AppSpec — the 5-endpoint Installer API stays a closed contract. **Route extension is the implementation's job via the returned Hono `app`** (the composer does `app.route('/dashboard', …)`), not a plugin hook. This keeps the contract fixed while allowing unlimited composition around it.

Kernel core must remain cloud-provider neutral. Cloud SDKs, host commands, and backend credentials stay in Takosumi plugins, runtime-agent connectors, or operator distribution code. Runtime capabilities the library needs (git / tar subprocess, temp-dir FS, HTTP serve) are **injected by the implementation** through the runtime adapter, never called directly on the imported library surface.

## Runtime Neutrality

Kernel runtime primitives go through `src/kernel/shared/runtime/`. Do not add direct `Bun.*`, `process.*`, or `node:*` calls in kernel core paths unless they are inside the runtime adapter boundary.

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
- `@takosjp/takosumi` (umbrella entry)

This package ships **no kind code**. The official portable kind catalog is
published spec, not a package export: each descriptor is flat JSON-LD under
`docs/kinds/v1/<name>.jsonld`, served at `https://takosumi.com/kinds/v1/<name>`
(`worker`, `web-service`, `postgres`, `sqlite`, `object-store`, `kv-store`,
`message-queue`, `vector-store`, `gateway`). The framework imports none of them.

Native kinds and connectors in `../takosumi-plugins` are subpath exports of
`@takosjp/takosumi-plugins` (`/kind/<backend-name>` and `/connectors`). That
package depends on `@takosjp/takosumi` as a peer and is published from its own
repository, not from this one.

## Build And Publish Toolchain

Source is Bun-native TypeScript and published to npm. The build entry in this
repository is `scripts/build-npm.ts`; the plugins package builds via
`takosumi-plugins/scripts/build-npm.ts`. Because the framework surface never calls
`Bun.serve` / host subprocess primitives directly — serving and git / tar / temp-dir
capabilities are injected by the implementation through the runtime adapter — the
published `@takosjp/takosumi` graph builds with no subprocess module mappings, and
Node / Bun behavior comes from the runtime adapter at runtime.

## Commands

```bash
bun run check
bun test
bun run test:scripts
bun run lint:json-ld
```

Focused work should run from the repository root:

```bash
bunx tsc --noEmit src/cli/main.ts
```

## Work Rules

- Keep public contract changes in `src/contract/` and update docs/tests in the same change.
- Keep kernel-specific changes in `src/kernel/`.
- Add or change a portable kind descriptor by editing its published JSON-LD at `docs/kinds/v1/<name>.jsonld` (it is spec, not framework code — the kernel imports none of them).
- Add or change backend-specific native kind behavior in `../takosumi-plugins/src/plugins/*`.
- Add or change concrete runtime-agent connectors in `../takosumi-plugins/src/connectors/`.
- Add new official portable catalog descriptors as published JSON-LD under `docs/kinds/v1/<name>.jsonld`.
- Keep Takos product IDs and Takos-specific services out of Takosumi kernel core.
- Keep account-plane features in operator distribution docs/code, not in Takosumi core.
- Follow [`CONVENTIONS.md`](./CONVENTIONS.md), [`docs/reference/reference-plugin-exports.md`](./docs/reference/reference-plugin-exports.md), and [`docs/reference/public-spec-source-map.md`](./docs/reference/public-spec-source-map.md) when changing official descriptors or reference plugin bindings.
