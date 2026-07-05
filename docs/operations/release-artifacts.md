# Release Artifact Pipelines

> このページでわかること: Takosumi platform worker release に含める
> artifacts、build / promotion gate、rollback evidence。

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| Last reviewed | 2026-06-07                                 |
| Owner         | Takosumi release owner / platform operator |
| Scope         | Takosumi platform worker artifacts         |

## Artifact Matrix

| Artifact                                      | Owning path                                                              | Build / publish behavior                               | Promotion evidence                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Platform worker script                        | `takosumi/deploy/platform/worker.ts`, `takosumi/worker`, `takosumi/core` | built by Wrangler deploy from source                   | commit SHA, wrangler dry-run/deploy output, worker version id                           |
| Dashboard SPA                                 | `takosumi/dashboard`                                                     | `bun run build`; served through worker `ASSETS`        | dashboard build output, asset digest / deploy log                                       |
| Runner container                              | `takosumi/runner/Dockerfile`                                             | built by Cloudflare Containers during deploy           | image digest / Cloudflare Container smoke evidence                                      |
| Platform control DB migrations / schema       | `takosumi/core/adapters/storage`                                         | applied by platform deploy / migration runner          | storage migration transcript, schema mirror test                                        |
| CredentialRecipe seed / provider policy packs | schema/store/policy packages and `docs/internal/core-spec.md`            | shipped with platform worker and Takosumi storage seed | recipe seed diff, provider allowlist diff, ProviderConnection policy evidence           |
| Custom provider runner policy                 | runner image / operator boundary policy                                  | shipped with runner and policy code                    | secret-backed provider policy / egress / custom runner class evidence                   |
| Release activator materializer                | operator/Cloud deployment outside OSS                                    | optional webhook target for post-apply app publication | activation success/failure surfacing, app URL/health proof, no rollback of apply ledger |
| Official OpenTofu modules                     | `takosumi/opentofu-modules`                                              | shipped as repo source; consumed by Source / runner    | commit SHA, fixture plan evidence where available                                       |

Takosumi does not publish a separate npm or OCI product artifact for the
control plane. The operator deploys one Cloudflare Worker at
`app.takosumi.com`; realized Wrangler config and secret values live in
`takosumi-private` / operator vault, outside the public repo.

Capsule application artifacts are not Takosumi platform release artifacts. If a
Git-hosted OpenTofu module needs a prebuilt Worker bundle, container image,
object key, URL, digest, or version, that value is a normal module input owned
by the app repository, CI/release pipeline, registry, or provider. Takosumi
keeps the Git SourceSnapshot, provider cache/mirror evidence, plan/apply Run,
StateVersion, Output, and audit trail; it does not fetch or interpret the
deployable app artifact on behalf of the module.

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

From the ecosystem root on the operator machine, write the stable activator
endpoint and bearer token to the private repo before enabling the platform
worker setting:

```bash
bun run write:takosumi-release-activator-secrets -- \
  --url https://<stable-operator-release-activator>/activate \
  --generate-token
```

The helper writes `TAKOSUMI_RELEASE_ACTIVATOR_URL` and
`TAKOSUMI_RELEASE_ACTIVATOR_TOKEN` as `0600` files under `takosumi-private` and
does not print the token. It rejects localhost and trycloudflare URLs because
GA evidence must point at a stable operator endpoint.

Validate release activation evidence before promotion:

```bash
cd takosumi
mkdir -p "$TAKOSUMI_PRIVATE/evidence"
bun run release-activation:evidence -- --print-template \
  > "$TAKOSUMI_PRIVATE/evidence/release-activation.json"

# Fill the four evidence/*.md files and replace run ids, StateVersion / Output
# ids, activation record ids, health URLs, and evidence refs with live operator
# values. Do not add legacy runtime ids to the manifest; compatibility rows can
# stay in operator notes, but the structured claim uses the final model only.
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

Use the built-in runner activator for `executor = "runner"` commands that can
run inside the restored source snapshot with the same ProviderConnection
credential boundary as the reviewed apply. Commands that require operator-only
tools, an operator checkout outside the source snapshot, or credentials that are
not represented as ProviderConnections should declare `executor = "operator"`
and be handled by the configured release activator materializer.

The bundled Cloudflare-hosted operator helper is intentionally small:

```bash
cd takosumi
bun run operator:release-activator -- serve \
  --source-bucket "$TAKOSUMI_RELEASE_SOURCE_BUCKET" \
  --wrangler-config "$TAKOSUMI_RELEASE_WRANGLER_CONFIG" \
  --command-env-allowlist CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID
```

It fetches the SourceSnapshot archive from R2, verifies the recorded digest,
extracts it into an operator work directory, and runs the opaque `post_apply` argv.
The default work root is `/var/tmp/takosumi-release-activator`; set
`TAKOSUMI_RELEASE_WORK_ROOT` or `--work-root` when the operator host uses a
different large disk. Each activation injects job-local `TMPDIR`,
`BUN_INSTALL_CACHE_DIR`, `BUN_TMPDIR`, `XDG_CACHE_HOME`, and
`NODE_COMPILE_CACHE`, so `bun install`, `bunx wrangler`, and build steps do not
depend on a shared tmpfs `/tmp`.
Takosumi does not add database-specific migration resources, product-specific
publication code, or resource-aware activation plugins. Any work after apply is
just a command owned by the Capsule/operator; Takosumi only runs it, records
logs/status, and keeps that result separate from the committed OpenTofu ledger.
Credentials required by this helper itself, such as R2 archive fetch auth, remain
materializer tooling env and are not forwarded to the restored source commands.
Credentials required by the opaque operator command are forwarded only when the
operator explicitly names them in `--command-env-allowlist` (or
`TAKOSUMI_RELEASE_COMMAND_ENV_ALLOWLIST`). The OpenTofu
`takosumi_release.post_apply.env` descriptor remains non-secret and cannot carry
provider tokens, database URLs, DSNs, or other credential material.

## Promotion Record

Release sign-off record includes:

- commit SHA
- wrangler config path used (`takosumi-private/platform/wrangler.toml`)
- worker version id after deploy
- dashboard build summary
- runner image digest or Cloudflare Container smoke reference
- release activation materializer reference when enabled
- `takosumi.release-activation-evidence@v1` validation output when enabled
- platform control DB migration transcript when Takosumi storage schema changed
- targeted test / typecheck summary
- rollback worker version id and previous commit SHA

Do not include provider account ids, secret values, raw R2 object keys, payment
processor ids, or customer identifiers in public release notes.

## Rollback Artifact Rules

Rollback targets must be immutable:

- Cloudflare worker version id
- commit SHA
- runner image digest
- control-plane storage migration id / restore plan when Takosumi schema changed

Do not rely on mutable tags such as `latest`. Platform rollback follows
[`./rollback-sop.md`](./rollback-sop.md).
