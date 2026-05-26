# AGENTS.md — Takosumi

This repository is **Takosumi**, an operator-portable PaaS contract and reference kernel. It reads `.takosumi.yml` from source, creates an Installation in a Space, and records each apply as a Deployment. It contains the contract package, reference kernel, installer, CLI, generic runtime-agent host, portable official kind catalog packages, and the umbrella package published to JSR. Backend-specific native kind plugin packages and concrete runtime-agent connectors live in the sibling `takosumi-plugins` repository.

Canonical contract: [`@takos/takosumi-contract`](https://jsr.io/@takos/takosumi-contract) (`packages/contract/`).

## Spec Status

Takosumi AppSpec is kind-agnostic and intentionally small:

- AppSpec root: `{ apiVersion, metadata, components }`
- Component: `{ kind, spec, publish, listen }`
- `apiVersion` is bare `"v1"`.
- Root `kind: App`, component `build`, `use:` edges, placeholder interpolation, `routes`, `interfaces`, and `permissions` are not part of the contract.

`Component.kind` is an opaque alias or URI. Its meaning comes from operator-injected `kindAliases`, descriptor metadata, Space policy, and the operator's implementation binding. The Installer API carries source and apply requests; it does not define kind semantics.

Official descriptors are package-owned under `packages/kind-*/spec/kind.jsonld` and are published as `https://takosumi.com/kinds/v1/<name>`. Operators may adopt those descriptors or use their own catalog.

## Workspace

```text
takosumi/
├── deno.json
├── packages/
│   ├── contract/                @takos/takosumi-contract
│   ├── kernel/                  @takos/takosumi-kernel
│   ├── installer/               @takos/takosumi-installer
│   ├── cli/                     @takos/takosumi-cli
│   ├── runtime-agent/           @takos/takosumi-runtime-agent
│   ├── kind-*/                  portable @takos/takosumi-kind-* descriptors
│   └── all/                     @takos/takosumi
├── docs/, website/, deploy/, fixtures/, scripts/
└── README.md, CONVENTIONS.md, CHANGELOG.md
```

Kind packages are split by ownership:

- Portable kind packages define author-facing shapes: `kind-worker`, `kind-web-service`, `kind-postgres`, `kind-object-store`, `kind-gateway`.
- Native kind plugin packages and concrete runtime-agent connectors bind concrete backends into the reference kernel and live in `../takosumi-plugins`: Cloudflare Workers/R2/DNS, Deno Deploy, AWS Fargate/RDS/S3/Route53, GCP Cloud Run/Cloud SQL/GCS/Cloud DNS, Kubernetes, Docker Compose, systemd, MinIO, filesystem, Docker Postgres, CoreDNS, Cloudflare Containers, and Azure Container Apps.

## Public Concepts

| Concept      | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| AppSpec      | `.takosumi.yml` in a source root                                               |
| Installation | Space-scoped AppSpec record, including the current Deployment pointer/status   |
| Deployment   | one apply result, including history, audit evidence, and rollback target state |

Specification language should stay centered on these concepts. Ownership, billing, permissions, account dashboards, and deploy facades belong to operator distributions such as Takosumi Cloud.

## Publish / Listen

Component connections use only `publish` and `listen`.

- `publish: { <name>: { as } }` offers component material as `component.publication`.
- `listen: { <binding>: { from, as, prefix?, mount?, required? } }` resolves a same-AppSpec `component.publication` or an operator-owned external publication path.

OIDC is an external publication from an operator account plane, for example `operator.identity.oidc`. It is not a special Takosumi core component kind.

## Source And Build

Takosumi installs source. Build/prepare is owned by CI, workflow automation, or an operator build service. Prepared output is passed to the Installer API as `source.kind: "prepared"`. File paths that matter to runtime belong in the kind's `spec`, such as `worker.spec.entrypoint`.

Do not reintroduce `component.build`, `jobs:`, `steps:`, `matrix:`, `triggers:`, or a pipeline DSL into AppSpec.

## Reference Kernel Binding

The reference implementation uses `KernelPlugin` factories, passed as a plain array:

```ts
createPaaSApp({
  kindAliases,
  plugins: [
    cloudflareWorkerPlugin(),
    cloudflareR2ObjectStorePlugin(),
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

Use `409 failed_precondition` for lifecycle guard failures such as source pin mismatch, prepared digest mismatch, expected guard mismatch, missing required external publication, or non-portable local source omission. Use `413 resource_exhausted` for request, manifest, or source size limits. The v1 surface does not use a caller-supplied Idempotency-Key header.

## JSR Publish Layout

Packages publish independently. There is no ecosystem-wide GA version.

Core/runtime/tooling:

- `@takos/takosumi-contract`
- `@takos/takosumi-kernel`
- `@takos/takosumi-installer`
- `@takos/takosumi-cli`
- `@takos/takosumi-runtime-agent`
- `@takos/takosumi`

Portable kind descriptor packages in this repository:

- `@takos/takosumi-kind-worker`
- `@takos/takosumi-kind-web-service`
- `@takos/takosumi-kind-postgres`
- `@takos/takosumi-kind-object-store`
- `@takos/takosumi-kind-gateway`

Native plugin packages in `../takosumi-plugins` keep their published
`@takos/takosumi-kind-*` package names, but they are no longer part of this
repository's umbrella package or publish dry-run.

## Commands

```bash
deno task check
deno test --allow-all
deno task fmt:check
deno task lint
deno task lint:json-ld
deno task spec:check-drift
deno task publish:dry-run
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
