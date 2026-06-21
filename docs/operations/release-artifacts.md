# Release Artifact Pipelines

> このページでわかること: Takosumi platform worker release に含める
> artifacts、build / promotion gate、rollback evidence。

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| Last reviewed | 2026-06-07                                 |
| Owner         | Takosumi release owner / platform operator |
| Scope         | Takosumi platform worker artifacts         |

## Artifact Matrix

| Artifact                             | Owning path                                                              | Build / publish behavior                                    | Promotion evidence                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Platform worker script               | `takosumi/deploy/platform/worker.ts`, `takosumi/worker`, `takosumi/core` | built by Wrangler deploy from source                        | commit SHA, wrangler dry-run/deploy output, worker version id                           |
| Dashboard SPA                        | `takosumi/dashboard`                                                     | `bun run build`; served through worker `ASSETS`             | dashboard build output, asset digest / deploy log                                       |
| Runner container                     | `takosumi/runner/Dockerfile`                                             | built by Cloudflare Containers during deploy                | image digest / Cloudflare Container smoke evidence                                      |
| D1 migrations / schema               | `takosumi/core/adapters/storage`                                         | applied by platform deploy / migration runner               | migration transcript, schema mirror test                                                |
| Provider Catalog seed / policy packs | schema/store/policy packages and `docs/core-spec.md`                     | shipped with platform worker and DB seed/migration          | provider catalog seed diff, provider catalog policy evidence                            |
| Custom provider runner policy        | runner image / operator boundary policy                                  | shipped with runner and policy code                         | secret-backed provider policy / egress / custom runner class evidence                   |
| Release activator materializer       | operator/Cloud deployment outside OSS                                    | optional webhook target for post-apply app publication      | activation success/failure surfacing, app URL/health proof, no rollback of apply ledger |
| Official OpenTofu modules            | `takosumi/opentofu-modules`                                              | shipped as repo source; consumed by SourceSnapshot / runner | commit SHA, fixture plan evidence where available                                       |

Takosumi does not publish a separate npm or OCI product artifact for the
control plane. The operator deploys one Cloudflare Worker at
`app.takosumi.com`; realized Wrangler config and secret values live in
`takosumi-private` / operator vault, outside the public repo.

## Required Gates

Before production promotion:

```bash
cd takosumi
bun run check
bun test
cd dashboard && bun run build
```

`bun run check` is the package-level Takosumi gate and includes the root
typecheck, worker typecheck, and Cloudflare worker build checks. Production
promotion must not use raw `tsc --noEmit` as a replacement.

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
Cloudflare Container smoke and platform hardening-gate evidence. If app
publication is enabled through `TAKOSUMI_RELEASE_ACTIVATOR_URL`, add release
activation materializer evidence: successful activation, failed/pending
activation surfacing, and proof that the OpenTofu apply ledger remains committed
independently of app publication status.

Validate release activation evidence before promotion:

```bash
cd takosumi
mkdir -p "$TAKOSUMI_PRIVATE/evidence"
bun run release-activation:evidence -- --print-template \
  > "$TAKOSUMI_PRIVATE/evidence/release-activation.json"

# Fill the four evidence/*.md files and replace run ids, StateVersion / Output
# ids, deployment ids, health URLs, and evidence refs with live operator values.
# If the live runtime still emits Space / Installation / OutputSnapshot ids,
# record them under `legacyRuntimeIds` rather than as the public claim shape.
bun run release-activation:evidence -- --update-digests \
  "$TAKOSUMI_PRIVATE/evidence/release-activation.json"
```

The release activation manifest is required only when the release activator is
enabled. It is intentionally separate from the production hardening manifest:
hardening proves the platform can open; release activation proves optional
post-apply app publication is observable, redacted, and independent from the
committed OpenTofu apply ledger. If `TAKOSUMI_RELEASE_ACTIVATOR_URL` is set,
platform readiness `open` also requires the validator output's four
`TAKOSUMI_RELEASE_ACTIVATION_*_EVIDENCE_REF` / `_DIGEST` pairs in realized
operator config.

## Promotion Record

Release sign-off record includes:

- commit SHA
- wrangler config path used (`takosumi-private/platform/wrangler.toml`)
- worker version id after deploy
- dashboard build summary
- runner image digest or Cloudflare Container smoke reference
- release activation materializer reference when enabled
- `takosumi.release-activation-evidence@v1` validation output when enabled
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
