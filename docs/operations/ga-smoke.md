# Hosted Takosumi GA smoke (real-Cloudflare validation)

Every unit/integration test uses a fake runner + in-memory stores, so nothing in
CI proves the **real** deploy loop works against Cloudflare. Before opening
hosted Takosumi access, the real loop must be walked against the real-cloud staging
cell first, then production while production remains closed. See
[`real-cloud-staging.md`](./real-cloud-staging.md) for the full promotion
ladder.

Credentials come ONLY from the operator environment, never the repo. Store values
under the operator-private secret directory and source them into the shell only
for the command that needs them:

```sh
export TAKOSUMI_PRIVATE=/path/to/takosumi-private
bun run check:takosumi-live-evidence-prereqs -- --private-root "$TAKOSUMI_PRIVATE" --environment staging
export CLOUDFLARE_API_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_API_TOKEN")"
export CLOUDFLARE_ACCOUNT_ID="$(cat "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_ACCOUNT_ID")"
```

The preflight checks file presence and mode only. It does not read or print the
Cloudflare token or account id.

## Layer 1 — provider/module integration (runnable now, no worker)

```sh
bun run smoke:cloudflare
```

Applies the official `cloudflare-r2-storage` Capsule against real Cloudflare,
verifies the R2 bucket exists via the Cloudflare API, then destroys it and
verifies it is gone. Idempotent (unique bucket name) and self-cleaning (always
destroys, even on failure). This catches the integration risks no fake-runner
test can: the real Cloudflare API, real provider install, real apply, clean
destroy. Exit 0 = pass.

Optional: `CLOUDFLARE_PROVIDER_VERSION=<x>` to pin the provider to the runner's
mirrored version; `SMOKE_KEEP=1` to keep the workdir; `SMOKE_BUCKET_PREFIX=...`.

## Layer 2 — full platform control plane (the real GA gate)

Layer 1 proves Cloudflare + the module. Layer 2 proves the **control plane**: the
vault minting the ProviderConnection credential, the Capsule Gate,
the runner container, and the install→plan→apply→deployment→destroy ledger — i.e.
the actual platform path a signed-in user walks. It needs a running worker (the
deployed platform worker, or a local stack), so it is operator-gated.

Run it from `takosumi/`:

```sh
TAKOSUMI_ACCOUNT_SESSION_TOKEN="$(
  cat "$TAKOSUMI_PRIVATE/.secrets/staging/TAKOSUMI_ACCOUNT_SESSION_TOKEN"
)" \
CLOUDFLARE_ACCOUNT_ID="$(
  cat "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_ACCOUNT_ID"
)" \
  bun run smoke:platform-control-plane -- \
    --url https://app-staging.takosumi.com \
    --space <scratch-space-id-or-handle> \
    --cloudflare-api-token-file "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_API_TOKEN" \
    --json
```

The command:

1. uses the same signed-in account session surface as the dashboard and creates
   a temporary Workspace-scoped Cloudflare ProviderConnection;
2. uploads the no-build `cloudflare-hello-worker` OpenTofu Capsule;
3. plans and applies it with an explicit ProviderConnection binding;
4. verifies the Worker script through the real Cloudflare API;
5. starts the canonical destroy flow (`DELETE capsule` through the current compatibility route → approve
   destroy-plan → apply destroy-plan);
6. verifies the Worker script is gone, then revokes the temporary Workspace
   ProviderConnection unless `--keep-connection` is set.

R2 remains a Layer 1 / own-key direct integration smoke. Do not use
`cloudflare-r2-storage` as the Layer 2 proof; Layer 2 is the product
control-plane path and uses `cloudflare-hello-worker` because it needs no build
artifact and can be created, verified, and destroyed by the platform loop.

This is a required input to the enforced production hardening gate. Run it
against `https://app-staging.takosumi.com` before production is touched; after
the production platform worker is deployed closed, run the production
non-destructive equivalent and record the final transcript in private evidence as
`platformControlPlaneSmoke.evidenceRef` / `TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF`.

## Relationship to the other gates

- `bun run production-hardening:gates` — platform opening evidence gate. The
  enforced manifest requires container smoke, Layer 2 platform control-plane
  smoke, egress enforcement, restore rehearsal, provider catalog coverage,
  cost-attribution JSON evidence, and secret-boundary evidence.
- `bun run release-activation:evidence` — optional post-apply publication
  evidence gate. Required only when `TAKOSUMI_RELEASE_ACTIVATOR_URL` is enabled;
  it proves successful activation, failed/pending activation surfacing, ledger
  independence, and payload redaction.
- `bun run smoke:cloudflare` — live Cloudflare integration (Layer 1).
- `bun run smoke:platform-control-plane` — live platform control-plane loop
  (Layer 2, the GA go/no-go).
