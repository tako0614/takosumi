# Release Artifact Pipelines

> このページでわかること: Takosumi platform worker release に含める
> artifacts、build / promotion gate、rollback evidence。

| Field | Value |
| --- | --- |
| Last reviewed | 2026-06-07 |
| Owner | Takosumi release owner / platform operator |
| Scope | Takosumi platform worker artifacts |

## Artifact Matrix

| Artifact | Owning path | Build / publish behavior | Promotion evidence |
| --- | --- | --- | --- |
| Platform worker script | `takosumi/deploy/platform/worker.ts`, `takosumi/worker`, `takosumi/src/service` | built by Wrangler deploy from source | commit SHA, wrangler dry-run/deploy output, worker version id |
| Dashboard SPA | `takosumi/dashboard` | `bun run build`; served through worker `ASSETS` | dashboard build output, asset digest / deploy log |
| Runner container | `takosumi/runner/Dockerfile` | built by Cloudflare Containers during deploy | image digest / Cloudflare Container smoke evidence |
| D1 migrations / schema | `takosumi/src/service/adapters/storage` | applied by platform deploy / migration runner | migration transcript, schema mirror test |
| Provider Template seed / policy packs | schema/store/policy packages and `docs/core-spec.md` | shipped with platform worker and DB seed/migration | provider template seed diff, provider-template policy evidence |
| Custom provider runner policy | runner image / operator boundary policy | shipped with runner and policy code | provider env set policy / egress / custom runner class evidence |
| Official OpenTofu modules | `takosumi/opentofu-modules` | shipped as repo source; consumed by SourceSnapshot / runner | commit SHA, fixture plan evidence where available |

Takosumi does not publish a separate npm or OCI product artifact for the
control plane. The operator deploys one Cloudflare Worker at
`app.takosumi.com`; realized Wrangler config and secret values live in
`takosumi-private` / operator vault, outside the public repo.

## Required Gates

Before production promotion:

```bash
cd takosumi
bunx tsc --noEmit
bun test
cd dashboard && bunx tsc --noEmit && bun run build
```

If docs or public contract changed:

```bash
cd takosumi
bun run docs:build
cd ..
bun run check:architecture
bun run check:architecture:strict
bun run check:design-docs
bun run check:legacy-names
```

If runner image, queue, Durable Object, or binding config changed, add staging
Cloudflare Container smoke and platform hardening-gate evidence.

## Promotion Record

Release sign-off record includes:

- commit SHA
- wrangler config path used (`takosumi-private/platform/wrangler.toml`)
- worker version id after deploy
- dashboard build summary
- runner image digest or Cloudflare Container smoke reference
- D1 migration transcript when schema changed
- targeted test / typecheck summary
- rollback worker version id and previous commit SHA

Do not include provider account ids, secret values, raw R2 object keys, payment
processor ids, or customer identifiers in public release notes.

## Rollback Artifact Rules

Rollback targets must be immutable:

- Cloudflare worker version id
- commit SHA
- runner image digest
- migration id / restore plan for DB-affecting changes

Do not rely on mutable tags such as `latest`. Platform rollback follows
[`./rollback-sop.md`](./rollback-sop.md).
