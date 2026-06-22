# Takosumi Cloudflare Worker And OpenTofu Runner Scaffold

This directory is the Cloudflare deployment scaffold for the Takosumi control-plane and OpenTofu runner boundary. It is
used by the platform worker composition and local-substrate profiles, but it is not a standalone public API product.
The target public control-plane model is Workspace / Project / Capsule / Source / ProviderConnection /
CredentialRecipe / ProviderBinding / Secret / Run / Plan / Apply / Destroy / StateVersion / Output / Runner /
AuditEvent / Operator. Cloudflare Containers host the OpenTofu runner that executes queued `plan`, `apply`, and
`destroy` Runs.

This scaffold is OSS Takosumi infrastructure for running existing OpenTofu/Terraform providers as-is. It is not the
Cloudflare Compatibility Gateway, a Workers for Platforms backend, or a managed resource backend.

## Files

- `wrangler.toml`: control-plane Worker, D1, R2, Queue, coordination Durable Object, and OpenTofu runner container binding template. Wrangler runs a Bun custom build and uploads the bundled Worker without a second esbuild pass.
- `../../worker/src/index.ts`: Worker entrypoint.
- `../../worker/src/handler.ts`: route dispatcher that keeps edge-local health/storage probes local, forwards canonical Takosumi API requests to the service app, and dispatches OpenTofu execution to the runner container binding.
- `../../worker/src/d1_storage.ts`: D1-backed snapshot storage driver for service stores.
- `../../worker/src/d1_deploy_stores.ts`: D1-backed deployment record and revoke-debt stores.
- `../../worker/src/r2_object_storage.ts`: R2-backed object storage port for operator-internal extensions.
- `../../runner/Dockerfile`: Cloudflare Container image scaffold for a Bun HTTP runner with the OpenTofu CLI installed.
- `../../runner/entrypoint.ts`: container-only Bun server that receives run messages from the container Durable Object and invokes `tofu`.

## Routing Shape

The Worker forwards the canonical Takosumi `/api/v1` control-plane routes to the embedded service app. New
operator-facing docs should describe those routes with the final public model:

- Workspace, Project, Capsule, Source, ProviderConnection, CredentialRecipe, ProviderBinding, Secret, Run, Plan, Apply,
  Destroy, StateVersion, Output, Runner, AuditEvent, and Operator.
- `/install` is not forwarded to this service app. It is a dashboard SPA path that preserves query parameters and
  pre-fills `/new` when this scaffold is mounted by a platform composition.

The current embedded service still has legacy route and storage names such as Space, Installation, Dependency,
OutputShare, RunGroup, Deployment, and Activity. In this README they describe the current implementation only; they are
not the target OSS public vocabulary.

The `/internal/v1/runner-profiles`, `/internal/v1/plan-runs`, `/internal/v1/apply-runs`, and
`/internal/v1/installations/*` routes are internal seams for accounts-plane and CLI adapters. They are not the
edge-public Takosumi model and should not appear in operator-facing capability or OpenAPI inventories.

Destroy is represented as a guarded `destroy_plan` -> approval -> `destroy_apply`
Run workflow. Internally, the legacy seam may still materialize reviewed plan
artifacts through older plan/apply run records. The runner adapter calls the `RUNNER`
Durable Object, whose Cloudflare Container materializes source snapshots, writes variables as
`takosumi.auto.tfvars.json`, and runs OpenTofu. Plan creates a reviewed `tfplan` artifact and records its digest. Apply
restores that reviewed artifact from R2, verifies the digest, recreates the source workspace if needed, and executes
`tofu apply <tfplan>`. The Durable Object also restores and persists `terraform.tfstate` through an operator-managed R2
sidecar. Apply does not depend on a still-warm runner-local file and does not re-plan with `-auto-approve`. The
`RUN_QUEUE` binding remains available for asynchronous runner integration, but it is not a separate public API. Queue
deliveries schedule the per-run `OpenTofuRunOwnerObject`; that owner Durable Object drives the long controller dispatch
and retry bookkeeping outside the queue delivery lifetime.

Internal/service paths are also forwarded to the embedded service app:

- `/internal/v1/*` for the in-process deploy-control seam (not edge-public).
- `/internal/v1/runtime/agents/*` for private compatibility fleet ledgers when an operator distribution enables them.
- `/capabilities`, `/readyz`, `/livez`, `/openapi.json`, and `/metrics`.

The Worker-local routes remain at the edge:

- `/healthz` reports Worker health only.

The only container binding here is the OpenTofu runner. The single edge-public API surface is `/api/v1`; any
`/internal/v1` execution profile / plan-run / apply-run references describe the internal seam only.

## Cloud-Only Managed Edge Boundary

This OSS scaffold does not include Workers for Platforms dispatch, Cloudflare Compatibility Gateway, AWS/GCP
compatibility APIs, S3 gateway, Resource Driver systems, Compat Pack systems, managed Edge/Storage/Container resources,
official billing, official quota/usage, or official resource backends. Those belong to closed Takosumi Cloud. The OSS
Cloudflare runner path uses the existing `cloudflare/cloudflare` provider with explicit ProviderConnections,
CredentialRecipes, ProviderBindings, and temporary run-time env/file injection.

Cloudflare Containers here are an operator-selected runner substrate for OpenTofu execution. They are not Takosumi
Managed Container or a Cloud managed resource product.

Do not bind operator provider credentials, control-plane bearer tokens, state backend credentials, or storage admin
credentials into user workloads. Provider material enters the OpenTofu runner only through explicit
ProviderConnections, CredentialRecipes, ProviderBindings, and per-run env/file injection.

## Persistence

D1 is used in two places:

- `CloudflareD1SnapshotStorageDriver` persists the service storage snapshot.
- `createCloudflareD1DeployStores` persists deployment records, deployment record locks, and revoke-debt records.

R2 is used for reviewed OpenTofu plan artifacts, operator-managed OpenTofu state objects, and operator-internal object extensions. The current key layout still uses legacy implementation names: canonical plan artifacts live under `spaces/{spaceId}/installations/{installationId}/runs/{runId}/plan.bin.enc` with the inspected plan JSON stored as `spaces/{spaceId}/installations/{installationId}/runs/{runId}/plan.json.zst.enc`. State snapshots live in the separate `R2_STATE` bucket under `spaces/{spaceId}/installations/{installationId}/envs/{environment}/states/{generation}.tfstate.enc`. These object paths are storage compatibility details, not public vocabulary; they map to Workspace / Capsule / Run / StateVersion / Output concepts in the final model. Older `opentofu-plan-runs/` objects are accepted only as an internal compatibility fallback for legacy plan records. Set `R2_ARTIFACTS_BUCKET_NAME` to the actual bucket name so `planArtifact.ref` uses the same `r2://<bucket>/...` identity the operator configured. The Worker stores Takosumi digests in R2 custom metadata and verifies plan digests before apply or read. Run records and audit metadata remain in D1.

The OpenTofu runner scaffold expects its working directory at `TOFU_WORK_DIR` (default `/workspace`). Source materialization, prepared-source wire/decompressed archive caps from internal execution `resourceLimits`, unsafe tar entry rejection, reviewed plan artifact promotion/restore, R2 state sidecar restore/persist, provider env minimization, and command timeout enforcement are implemented here. Stricter substrate-level egress enforcement remains operator integration work.

## Operator Steps

1. Replace placeholder D1/R2/Queue identifiers in `wrangler.toml`.
2. Configure Worker secrets/vars such as `TAKOSUMI_INTERNAL_API_SECRET`, `TAKOSUMI_SECRET_STORE_PASSPHRASE`, and optional `TAKOSUMI_METRICS_SCRAPE_TOKEN`.
3. Pin the runner image inputs, including `OPENTOFU_VERSION`. Provider material must enter through explicit ProviderConnections, CredentialRecipes, ProviderBindings, and the vault / per-phase mint path.
4. Record a real Cloudflare Container smoke proof (not Miniflare/local Docker) showing the deployed `OpenTofuRunnerObject` can start the container, answer `/healthz`, and run the operator-approved non-production OpenTofu fixture.
5. Deploy the control-plane Worker with `wrangler deploy --config deploy/cloudflare/wrangler.toml` from the product root or `wrangler deploy` from this directory. Docker must be available because Wrangler builds and uploads the runner image.

Use `/healthz` for Worker-only health. If a migration service app is mounted, do not replace service `/readyz` with a Worker-local response; service readiness should still come from that mounted app.
