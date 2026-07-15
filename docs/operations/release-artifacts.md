# Release Artifact Pipelines

> このページでわかること: Takosumi platform worker release に含める
> artifacts、build / promotion gate、rollback evidence。

| Field         | Value                                      |
| ------------- | ------------------------------------------ |
| Last reviewed | 2026-07-15                                 |
| Owner         | Takosumi release owner / platform operator |
| Scope         | Takosumi platform worker artifacts         |

## Artifact Matrix

| Artifact                                | Owning path / port                                                       | Build / publish behavior                                         | Promotion evidence                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Platform service bundle                 | `takosumi/deploy/platform/worker.ts`, `takosumi/worker`, `takosumi/core` | built by the selected host composition                           | commit SHA, composition build result, immutable deployment revision                      |
| Dashboard SPA                           | `takosumi/dashboard`                                                     | `bun run check:dashboard`; mounted by the selected asset adapter | dashboard build result, asset digest, deployment log                                     |
| Runner executor artifact                | `RunnerProfile.executorId` + operator executor adapter                   | image/binary/remote service format is adapter-owned              | immutable executor revision and contributed runner smoke                                 |
| Control-store migrations / schema       | `takosumi/core/adapters/storage`                                         | applied by the selected storage migration adapter                | migration transcript and logical-schema tests                                            |
| Credential Recipe contribution          | operator/provider contribution + `docs/internal/core-spec.md`            | registered explicitly by the composition; no implicit seed       | contribution diff, driver availability, ProviderConnection policy evidence               |
| Operator-defined runner / egress policy | runner and policy ports                                                  | deployed with the selected executor and network adapters         | explicit executor, credential phase, and egress evidence                                 |
| Release activator materializer          | optional operator/Cloud service outside OSS                              | executor for declared service-side Capsule lifecycle actions     | terminal success/failure proof, app URL/health proof, retained provider state on failure |
| Maintained OpenTofu module sources      | `takosumi/opentofu-modules`                                              | ordinary Git Sources consumed through the same Capsule flow      | commit SHA and fixture plan evidence where available                                     |

Takosumi does not require one universal npm, OCI, Worker, or container artifact
format for the control plane. The operator exposes one logical Takosumi origin
and selects a composition that binds storage, queue/dispatch, assets, and
runner ports. `deploy/platform` is the Cloudflare reference adapter;
`deploy/node-postgres` is another composition. Realized config and secrets live
in operator-owned state outside source repositories. The official
`app.takosumi.com` deployment, Cloud wrapper, hosted docs overlay, and realized
Cloudflare revisions are Takosumi Cloud artifacts documented under
`takosumi-cloud/docs/operations`.

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
bun run check:dashboard
```

`bun run check` is the package-level Takosumi software gate and includes the
supported reference-distribution builds. Production promotion must not use raw
`tsc --noEmit` as a replacement, and the selected host composition must add its
own build/deployment verification.

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

If runner, dispatch, lease/ownership, storage, or binding config changed, add
staging evidence through the selected adapters and the platform hardening
registry. The OSS baseline is provider/substrate neutral; a host adds a
versioned `takosumi.platform-hardening-contribution@v1` definition for any
additional checks. Generate and validate the private manifest with every
installed contribution:

```bash
cd takosumi
bun run production-hardening:evidence -- --print-template \
  --contribution "$OPERATOR_HARDENING_CONTRIBUTION" \
  > "$OPERATOR_EVIDENCE_ROOT/evidence/production-hardening.json"

bun run production-hardening:evidence -- --update-digests \
  "$OPERATOR_EVIDENCE_ROOT/evidence/production-hardening.json" \
  --contribution "$OPERATOR_HARDENING_CONTRIBUTION"
```

Omit `--contribution` when the composition uses only the OSS baseline. Repeat it
once for each installed host contribution; the manifest must cover the exact
composed registry.

The validator emits one non-secret
`TAKOSUMI_PLATFORM_HARDENING_EVIDENCE` JSON bundle. The platform route composes
the OSS baseline with host-code `TAKOSUMI_PLATFORM_HARDENING_CONTRIBUTIONS` and
fails closed on a missing/unknown contribution, capability drift, missing
check, mutable reference, or digest drift. Check-specific documents remain in
private operator evidence storage. There is no per-provider env family and no
fallback reader for the retired fixed six-check schema.

If app publication is enabled through `TAKOSUMI_RELEASE_ACTIVATOR_URL`, add
release activation materializer evidence: successful activation, fail-closed
failed/pending activation surfacing, and proof that provider-applied
StateVersion/Output plus usage remain committed while the Run is failed and
the Capsule/Interface runtime stays non-ready.

Store the stable activator endpoint and bearer secret through the operator's
approved config/vault workflow before enabling the platform setting. Official
Cloud operator helpers and their private file layout are not an OSS contract;
they live in the Cloud operations docs.

Validate release activation evidence before promotion:

```bash
cd takosumi
mkdir -p "$OPERATOR_EVIDENCE_ROOT/evidence"
bun run release-activation:evidence -- --print-template \
  > "$OPERATOR_EVIDENCE_ROOT/evidence/release-activation.json"

# Fill the four evidence/*.md files and replace run ids, StateVersion / Output
# ids, activation record ids, health URLs, and evidence refs with live operator
# values. Do not add legacy runtime ids to the manifest; compatibility rows can
# stay in operator notes, but the structured claim uses the final model only.
bun run release-activation:evidence -- --update-digests \
  "$OPERATOR_EVIDENCE_ROOT/evidence/release-activation.json"
```

The release activation manifest is required only when the release activator is
enabled. It is intentionally separate from the production hardening manifest:
hardening proves the platform can open; release activation proves optional
service-side lifecycle execution is observable and redacted, and that a failed
action retains the committed provider state without falsely succeeding the Run.
If `TAKOSUMI_RELEASE_ACTIVATOR_URL` is set,
platform readiness `open` also requires the validator output's four
`TAKOSUMI_RELEASE_ACTIVATION_*_EVIDENCE_REF` / `_DIGEST` pairs in realized
operator config.

Use the built-in runner activator for `executor = "runner"` commands that can
run inside the restored source snapshot with the same ProviderConnection
credential boundary as the reviewed apply. Commands that require operator-only
tools, an operator checkout outside the source snapshot, or credentials that are
not represented as ProviderConnections should declare `executor = "operator"`
and be handled by the configured release activator materializer.

The bundled Cloudflare release-activator is a reference-adapter helper, not the
Takosumi release protocol or an Operator requirement:

```bash
cd takosumi
bun run operator:release-activator -- serve \
  --source-bucket "$TAKOSUMI_RELEASE_SOURCE_BUCKET" \
  --wrangler-config "$TAKOSUMI_RELEASE_WRANGLER_CONFIG" \
  --command-env-allowlist CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID,TAKOSUMI_CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_CONTAINERS_API_TOKEN
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
logs/status, and gates Run/Capsule/Interface readiness on terminal success. A
failure never discards provider-applied state/output, but it consumes the Plan;
operators recover through a fresh reviewed plan/apply.
Credentials required by this helper itself, such as R2 archive fetch auth, remain
materializer tooling env and are not forwarded to the restored source commands.
Credentials required by the opaque operator command are forwarded only when the
operator explicitly names them in `--command-env-allowlist` (or
`TAKOSUMI_RELEASE_COMMAND_ENV_ALLOWLIST`). The service-side InstallConfig
lifecycle action may carry only non-secret env and cannot carry provider tokens,
database URLs, DSNs, or other credential material. Provider credentials require
an explicit action opt-in, policy permission, and runner capability; operator
actions use only their explicitly configured operator environment.
For a composition that explicitly rolls out Cloudflare Containers, allowlist
`CLOUDFLARE_CONTAINERS_API_TOKEN` as an operator-held deploy token. The Takos
release command uses it only for the final `wrangler deploy` step by mapping it
to Wrangler's standard `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` env names; D1
migrations, output verification, and other provider API checks that require a
Provider Connection run as runner lifecycle actions. If an operator action
needs separate authority, it uses a separately configured operator-held env
allowlist; Provider Connection material is never copied into the operator
activation payload.

## Promotion Record

Release sign-off record includes:

- commit SHA
- composition/config revision used (path stays private)
- immutable platform deployment revision
- dashboard build summary
- immutable executor revision and the applicable contributed runner-smoke reference
- release activation materializer reference when enabled
- `takosumi.release-activation-evidence@v1` validation output when enabled
- platform control DB migration transcript when Takosumi storage schema changed
- targeted test / typecheck summary
- rollback deployment revision and previous commit SHA

Do not include provider account ids, secret values, raw R2 object keys, payment
processor ids, or customer identifiers in public release notes.

## Rollback Artifact Rules

Rollback targets must be immutable:

- composition-native immutable deployment revision
- commit SHA
- runner image digest
- control-plane storage migration id / restore plan when Takosumi schema changed

Do not rely on mutable tags such as `latest`. Platform rollback follows
[`./rollback-sop.md`](./rollback-sop.md).
