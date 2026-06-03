# Takosumi Cloudflare Worker And OpenTofu Runner Scaffold

This directory is the Cloudflare deployment scaffold for the Takosumi deploy control plane. The Worker owns the public control-plane API, audit/storage adapters, and queue producer/consumer wiring. Cloudflare Containers host the OpenTofu runner that executes queued `plan`, `apply`, and `destroy` runs.

## Files

- `wrangler.toml`: control-plane Worker, D1, R2, Queue, coordination Durable Object, and OpenTofu runner container binding template. Wrangler runs a Bun custom build and uploads the bundled Worker without a second esbuild pass.
- `wrangler.dispatch.toml`: Workers for Platforms dynamic dispatch Worker template. It has only the dispatch namespace binding and non-secret vars.
- `src/worker.ts`: Worker entrypoint.
- `src/wfp_dispatch_worker.ts`: tenant / user Worker dynamic dispatch entrypoint. It resolves the user Worker from the first URL path segment and strips operator-only headers before dispatch. It does not enforce tenant egress allowlists.
- `src/handler.ts`: route dispatcher that keeps edge-local health/storage probes local, forwards canonical Takosumi API requests to the service app, and dispatches OpenTofu execution to the runner container binding.
- `src/d1_storage.ts`: D1-backed snapshot storage driver for service stores.
- `src/d1_deploy_stores.ts`: D1-backed deployment record and revoke-debt stores.
- `src/r2_object_storage.ts`: R2-backed object storage port for operator-internal extensions.
- `runner/Dockerfile`: Cloudflare Container image scaffold for a Bun HTTP runner with the OpenTofu CLI installed.
- `runner/server.ts`: container-only Bun server that receives run messages from the container Durable Object and invokes `tofu`.

## Routing Shape

The Worker forwards the canonical Takosumi v1 deploy API to the embedded service app:

- `GET /v1/runner-profiles`
- `POST /v1/plan-runs`
- `GET /v1/plan-runs/:id`
- `POST /v1/apply-runs`
- `GET /v1/apply-runs/:id`
- `GET /v1/installations/:id`
- `GET /v1/installations/:id/deployments`
- `GET /v1/installations/:id/deployment-outputs`

Destroy is represented as a PlanRun with `operation: "destroy"` followed by an ApplyRun. The service app owns PlanRun / ApplyRun records in D1. Its Cloudflare runner adapter calls the `TAKOS_OPENTOFU_RUNNER` Durable Object, whose Cloudflare Container materializes the PlanRun source, writes variables as `takosumi.auto.tfvars.json`, and runs OpenTofu. Plan creates a reviewed `tfplan` artifact, records the binary plan digest as `planArtifact.digest`, and the Durable Object immediately promotes the artifact to `TAKOS_ARTIFACTS` as an `object-storage` artifact under `opentofu-plan-runs/<planRunId>/tfplan`. ApplyRun restores that reviewed artifact from R2 into the runner, verifies the binary digest, recreates the source workspace if needed, and executes `tofu apply <tfplan>`. The Durable Object also restores and persists `terraform.tfstate` through an operator-managed R2 sidecar under `opentofu-state/`, keyed by Installation id when available and by source identity otherwise. Apply does not depend on a still-warm runner-local file and does not re-plan with `-auto-approve`. The `TAKOS_OPENTOFU_RUN_QUEUE` binding remains available for asynchronous runner integration, but it is not a separate public API.

Internal/service paths are also forwarded to the embedded service app:

- `/api/internal/v1/*` for operator/internal APIs.
- `/api/internal/v1/runtime/agents/*` for private compatibility fleet ledgers when an operator distribution enables them.
- `/health`, `/capabilities`, `/readyz`, `/livez`, `/status/summary`, `/openapi.json`, and `/metrics`.

The Worker-local routes remain at the edge:

- `/healthz` reports Worker health only.
- `/coordination/*` routes to `TakosCoordinationObject`.
- `/storage/healthz` checks D1/R2 bindings.
- `/queue/test` verifies Queue producer wiring.

The Cloudflare public API in this profile is the PlanRun / ApplyRun model above. The only container binding here is the OpenTofu runner.

## Workers for Platforms Boundary

Workers for Platforms is the tenant / user Worker dispatch runtime, not the OpenTofu runner. In the Cloudflare reference topology:

- The Takosumi Worker and D1/R2/Queue/Durable Object bindings run the control plane.
- Cloudflare Containers materialize `git` / `prepared` / operator-enabled `local` sources, run `tofu plan -out <tfplan>`, `tofu apply <tfplan>`, and destroy-plan apply operations with runner-only provider credentials.
- A separate Workers for Platforms dispatch namespace routes tenant / user Worker traffic.
- An outbound Worker should enforce tenant egress policy before user Worker traffic reaches external services. This checked-in dispatch Worker does not configure or prove that enforcement.

Do not bind operator provider credentials, Deploy Control bearer tokens, state backend credentials, or storage admin credentials into user Workers. User Workers may receive tenant-scoped bindings only. If a tenant workload needs a secret-like value, materialize a tenant-scoped short-lived token or a tenant-owned binding rather than an operator secret.

The current scaffold records the intended WfP boundary in RunnerProfile through `cloudflareWorkersForPlatforms` and `secretExposurePolicy`. The dispatch namespace, outbound Worker script, outbound binding configuration, and isolation proof are operator-live evidence items. Treat `enforceNetworkPolicy: true` as satisfied only when the operator can show that the dispatch namespace has an outbound Worker configured and that the outbound Worker enforces the declared allowlist.

## Persistence

D1 is used in two places:

- `CloudflareD1SnapshotStorageDriver` persists the service storage snapshot.
- `createCloudflareD1DeployStores` persists deployment records, deployment record locks, and revoke-debt records.

R2 is used for reviewed OpenTofu plan artifacts, operator-managed OpenTofu state sidecar objects, and operator-internal object extensions. Plan artifacts live under `opentofu-plan-runs/`; state sidecar objects live under `opentofu-state/backends/<stateBackendRefDigest>/`. Set `TAKOS_ARTIFACTS_BUCKET_NAME` to the actual bucket name so `planArtifact.ref` uses the same `r2://<bucket>/...` identity the operator configured. The Worker stores Takosumi digests in R2 custom metadata and verifies plan digests before apply or read. Run records and audit metadata remain in D1.

The OpenTofu runner scaffold expects its working directory at `TOFU_WORK_DIR` (default `/workspace`). Source materialization, prepared-source wire/decompressed archive caps from RunnerProfile `resourceLimits`, unsafe tar entry rejection, reviewed plan artifact promotion/restore, R2 state sidecar restore/persist, provider env minimization, and command timeout enforcement are implemented here. Stricter substrate-level egress enforcement remains operator integration work.

## Operator Steps

1. Replace placeholder D1/R2/Queue identifiers in `wrangler.toml`.
2. Configure Worker secrets/vars such as `TAKOSUMI_INTERNAL_API_SECRET`, `TAKOSUMI_SECRET_STORE_PASSPHRASE`, and optional `TAKOSUMI_METRICS_SCRAPE_TOKEN`.
3. Pin the runner image inputs, including `OPENTOFU_VERSION`, and provide provider credentials through Cloudflare secrets or a container-safe secret injection path.
4. If tenant / user Workers are enabled, create the Workers for Platforms dispatch namespace and outbound Worker without operator secret bindings. Configure the dispatch namespace outbound Worker and keep proof that it enforces the RunnerProfile allowlist.
5. Deploy the control-plane Worker with `wrangler deploy --config deploy/cloudflare/wrangler.toml` from the product root or `wrangler deploy` from this directory. Docker must be available because Wrangler builds and uploads the runner image.
6. Deploy the tenant dispatch Worker with `wrangler deploy --config deploy/cloudflare/wrangler.dispatch.toml`. Keep provider credentials, Deploy Control tokens, D1 admin bindings, and R2 admin bindings out of this Worker.

Use `/healthz` for Worker-only health. If a migration service app is mounted, do not replace service `/readyz` with a Worker-local response; service readiness should still come from that mounted app.
