# Managed GA smoke (real-Cloudflare validation)

Every unit/integration test uses a fake runner + in-memory stores, so nothing in
CI proves the **real** deploy loop works against Cloudflare. Before opening the
managed offering (the `/managed-offering` 503 gate), the real loop must be walked
against a live (ideally dedicated/scratch) Cloudflare account. These smokes make
that a one-command check anyone — including an agent — can run.

Credentials come ONLY from the environment, never the repo. Put them inline or in
a gitignored `takosumi/.env.smoke` (auto-loaded):

```sh
CLOUDFLARE_API_TOKEN=...    # "Workers R2 Storage: Edit" on the account
CLOUDFLARE_ACCOUNT_ID=...   # a scratch/dedicated account, not prod data
```

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

## Layer 2 — full managed control plane (the real GA gate)

Layer 1 proves Cloudflare + the module. Layer 2 proves the **control plane**: the
vault minting the operator-default (token-vending) credential, the Capsule Gate,
the runner container, and the install→plan→apply→deployment→destroy ledger — i.e.
the actual managed path a signed-in user walks. It needs a running worker (the
deployed platform worker, or a local stack), so it is operator-gated.

Shape (one command, driven through the CLI / Deploy Control HTTP surface against
`TAKOSUMI_SERVICE_URL` with a `TAKOSUMI_DEPLOY_CONTROL_TOKEN`):

1. Ensure an operator-default **token-vending** Cloudflare connection exists
   (the managed key) — `cli connections` / operator-default route.
2. Install the `cloudflare-r2-storage` Capsule into a scratch Space with NO Space
   connection (so it resolves the operator default — the panpii path).
3. `plan` → assert policy passed + the Capsule Gate ran.
4. `apply` → assert the Deployment records the real bucket output; verify the
   bucket via the Cloudflare API (as Layer 1 does).
5. `destroy` (with the now-enforced approval) → assert the bucket is gone.

This is the gate to flip the managed-offering readiness attestation. Until the
platform worker is deployed, run it against a local stack wired to a real CF
token; after deploy, run it against the live worker URL.

## Relationship to the other gates

- `bun run production-hardening:gates` — static production-hardening invariants.
- `bun run smoke:cloudflare` — live Cloudflare integration (Layer 1).
- Layer 2 — live managed control-plane loop (the GA go/no-go).
