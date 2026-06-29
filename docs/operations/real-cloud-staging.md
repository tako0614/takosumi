# Real-cloud staging and promotion ladder

Takosumi GA validation must use a real Cloudflare staging cell before touching
`app.takosumi.com`. Local-substrate is still useful for hostname/OIDC/CORS
shape, but it does not prove Cloudflare Containers, D1/R2/Queue bindings,
custom domains, Cloudflare OAuth/upstream OAuth callbacks, or the platform
control-plane loop.

## Staging cell contract

Use a separate staging platform Worker from production, with separate durable
resources. Do not split Cloud-only handlers into separate extension Workers;
staging uses the same `takosumi-cloud/platform/worker.ts` wrapper model as
production.

| item                   | staging value                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| platform URL           | `https://app-staging.takosumi.com`                                                                                  |
| realized config        | `takosumi-private/platform/wrangler.staging.toml`                                                                   |
| secrets                | `takosumi-private/.secrets/staging/`                                                                                |
| issuer                 | `https://app-staging.takosumi.com`                                                                                  |
| hosted Takosumi access | `TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS="closed"`                                                                        |
| hardening gate         | `TAKOSUMI_PRODUCTION_HARDENING_GATE="observe"` normally; `enforce` only for gate rehearsal                          |
| resources              | staging-only D1, R2, Queue, Durable Object namespace, Container image/version, OAuth app, route, and evidence store |

The public repo keeps only templates and runbooks. Real resource IDs, evidence
refs, bearer tokens, OAuth secrets, Stripe secrets, and provider credentials
stay in `takosumi-private` or the operator vault and are never copied into this
repo.

## Promotion ladder

1. Run repo/static gates from the ecosystem root and Takosumi root:

   ```bash
   bun run check:architecture
   bun run check:design-docs
   bun run check:legacy-names
   bun run check:deploy-config-bindings -- --require-production --require-staging
   bun run prepare:cloudflare-deploy-host
   export TAKOSUMI_BUILDX_BUILDER="takosumi-remote"
   export WRANGLER_DOCKER_BIN="$PWD/scripts/wrangler-docker-buildx-wrapper.sh"
   bun run check:cloudflare-deploy-host
   bun run check:takosumi-live-evidence-prereqs -- --environment both
   bun run ga:status -- --json
   bun run audit:takosumi-completion

   cd takosumi
   bun run check
   bun test
   ```

   From the Takosumi repo root, the same hosted-GA operator gates are exposed as
   proxy scripts so contributors do not have to remember that the implementation
   lives in the ecosystem root:

   ```bash
   bun run ga:status -- --json
   bun run ga:live-prereqs -- --environment staging --scope smoke --json
   bun run ga:billing-readiness -- --environment staging --skip-api --json
   bun run ga:billing-bootstrap -- --environment staging --dry-run --json
   bun run ga:browser-ux-evidence -- --environment staging --json
   bun run ga:synthetic-flow -- --environment staging --json
   bun run ga:sync-readiness -- --json
   bun run ga:deploy-host-check
   ```

   These proxy scripts already resolve the standard `takosumi-private/` layout
   from the ecosystem root. Do not pass `--private-root ../takosumi-private`
   from inside `takosumi/`; that points at the wrong directory.

   Billing bootstrap can be dry-run without Stripe credentials when the
   operator-private plan spec exists. Creating/reusing real Stripe prices,
   writing secret files, putting Wrangler secrets, and running checkout smoke
   still require the operator's Stripe session or Stripe secret key; do not
   replace those with placeholder price ids just to satisfy the readiness gate.

   Browser UX evidence can pass as smoke evidence before a full plan/apply
   rehearsal exists. `ga:synthetic-flow` is stricter: it should remain blocked
   until the signed-in browser evidence, control-plane plan/apply smoke, and
   export probe all pass.

   `check:deploy-config-bindings -- --require-production --require-staging`
   scans the public deploy templates and requires realized operator config for
   both production and staging. The default repo gate keeps those private files
   optional because they are operator-private state, but real-cloud readiness
   must fail closed when either required cell config is absent.
   `check:takosumi-live-evidence-prereqs` is also an operator preflight. It
   checks only file presence and secret file modes under `takosumi-private`;
   it never reads or prints secret values. Run it before Layer 1/2 smoke so a
   missing `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, private readiness
   JSON, or seven hardening evidence files fails with direct next actions
   instead of surfacing later as a missing public summary row. Use
   `--scope smoke`, `--scope readiness`, or `--scope hardening` for partial
   operator runs. Add `--print-private-layout` with the same scope to print
   the standard private paths and template commands before collecting evidence;
   it does not read secret values or write private evidence.
   `ga:status` aggregates the repo audit and private evidence
   preflight into one `takosumi.completion-status@v1` JSON report. It parses
   JSON even when a child command exits non-zero, preserves structured
   `nextActionDetails`, and does not print secret values or child stdout/stderr.
   `--probe-live` controls only the separate live platform / public website
   probe. The default `all` scope and `readiness` scope still run the billing
   readiness preflight, which may call the authenticated live billing API; use a
   narrower scope when avoiding billing network checks.
   `check:cloudflare-deploy-host` is an operator-host preflight, not a normal
   repo gate. It must pass on the machine that runs `wrangler deploy` because
   the platform worker deploy builds and uploads a Cloudflare Container image.
   It also verifies Wrangler 4.103.0 or newer. Use `bunx wrangler@latest ...`
   for real deploys; older Wrangler versions can upload the Worker script and
   container image but fail the Cloudflare Containers application finalize call
   with `Unauthorized`.
   If default Docker fails but `docker run --security-opt apparmor=unconfined`
   works, do not deploy from that host: Wrangler's internal Container build does
   not expose that flag directly. Use `prepare:cloudflare-deploy-host` plus the
   `WRANGLER_DOCKER_BIN` wrapper so Wrangler's `docker build` call is routed to
   the prepared remote BuildKit builder.

   If the operator cannot use the prepared remote BuildKit builder, build and
   push the runner image from a separate host or CI worker where Docker/buildx
   works, then point the private realized config at the Cloudflare registry URI:

   ```bash
   docker buildx build --load --platform linux/amd64 --provenance=false \
     -t takosumi-runner:<tag> \
     -f takosumi/runner/Dockerfile \
     takosumi

   bunx wrangler@latest containers push takosumi-runner:<tag>
   ```

   Then change only the operator-private realized config:

   ```toml
   [[containers]]
   class_name = "OpenTofuRunnerObject"
   image = "registry.cloudflare.com/<account-id>/takosumi-runner:<tag>"
   # image_build_context is used only when image points at a Dockerfile.
   ```

2. Build provider mirror assets, build the dashboard, and dry-run the staging
   realized config:

   ```bash
   cd takosumi
   bun run provider:assets
   cd dashboard && bun install && bun run build
   cd ../../
   bunx wrangler@latest deploy --dry-run --config takosumi-private/platform/wrangler.staging.toml
   ```

3. Deploy staging:

   ```bash
   bunx wrangler@latest deploy --config takosumi-private/platform/wrangler.staging.toml
   ```

4. Probe the staging platform surface:

   ```bash
   TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/staging/TAKOSUMI_DEPLOY_CONTROL_TOKEN")" \
     bun run probe:takosumi-live-state -- \
       --base-url https://app-staging.takosumi.com \
       --expected-issuer https://app-staging.takosumi.com \
       --json
   ```

   This must prove the dashboard shell, JSON `ok:true` from `/healthz` and
   `/readyz`, OIDC discovery, same-origin JWKS with at least one public JWK,
   unauthenticated API gate, `/install?git=...&ref=...&path=...` prefill, and
   the hardening gate shape. `--require-ready` is reserved for enforced
   hardening rehearsal or production. If the probe fails, inspect its
   `nextActionDetails` JSON array for endpoint/check-specific remediation.

5. Run Layer 1 live Cloudflare provider smoke from `takosumi/`:

   ```bash
   CLOUDFLARE_ACCOUNT_ID="$(cat "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_ACCOUNT_ID")" \
   CLOUDFLARE_API_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_API_TOKEN")" \
     bun run smoke:cloudflare
   ```

6. Run Layer 2 platform-control-plane smoke against staging. This is the real
   signed-in user path: a staging account session owns the scratch Workspace,
   creates a Workspace-scoped Cloudflare ProviderConnection, registers and syncs
   the Git Source for the `cloudflare-hello-worker` Capsule, plans, applies,
   verifies through the Cloudflare API, then destroys. Store the transcript only
   in private evidence.

   ```bash
   cd takosumi
   TAKOSUMI_ACCOUNT_SESSION_TOKEN="$(
     cat "$TAKOSUMI_PRIVATE/.secrets/staging/TAKOSUMI_ACCOUNT_SESSION_TOKEN"
   )" \
   CLOUDFLARE_ACCOUNT_ID="$(
     cat "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_ACCOUNT_ID"
   )" \
     bun run smoke:platform-control-plane -- \
       --url https://app-staging.takosumi.com \
       --workspace <scratch-workspace-id-or-handle> \
       --source-git-url https://github.com/tako0614/takosumi.git \
       --source-path providers/cloudflare/modules/cloudflare-hello-worker/module \
       --cloudflare-api-token-file "$TAKOSUMI_PRIVATE/.secrets/staging/CLOUDFLARE_API_TOKEN" \
       --cloudflare-resource-preflight account-resources \
       --json
   ```

   The command uses the public session-authenticated platform API for Workspace,
   connection, Git Source sync, Capsule creation, plan, apply, run inspection,
   and destroy. It does not require opening any edge-public internal route.
   The smoke output redacts token values and
   the Cloudflare account id. The `account-resources` preflight checks D1,
   Workers KV, R2, Queues, and Workflows read access before apply so an active but
   under-scoped token fails before OpenTofu can partially create resources; keep
   the raw transcript in
   `takosumi-private/evidence/platform-control-plane-smoke.md`.

7. Produce staging launch-readiness and hardening evidence. Staging rows may be
   recorded as rehearsal evidence, but they do not satisfy production
   completion.

8. Rehearse rollback and restore on staging. The evidence must include the
   worker version/image digest, rollback target, smoke results, backup id,
   StateVersion/Output check, and audit-chain check.

9. Deploy production closed:

   ```bash
   cd takosumi/dashboard && bun run build
   cd ../..
   bunx wrangler@latest deploy --dry-run --config takosumi-private/platform/wrangler.toml
   bunx wrangler@latest deploy --config takosumi-private/platform/wrangler.toml
   ```

   Production starts with `TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS="closed"`.

10. Probe production without opening hosted Takosumi public access:

    ```bash
    TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/production/TAKOSUMI_DEPLOY_CONTROL_TOKEN")" \
      bun run probe:takosumi-live-state -- \
        --base-url https://app.takosumi.com \
        --expected-issuer https://app.takosumi.com \
        --json
    ```

    To combine this live probe with repo evidence and private prerequisites,
    run the aggregate status command from the operator environment:

    ```bash
    TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/production/TAKOSUMI_DEPLOY_CONTROL_TOKEN")" \
      bun run ga:status -- \
        --json \
        --probe-live
    ```

    The final hosted-access gate is stricter and must stay red until production
    readiness evidence, hardening evidence, billing readiness, and the public
    summaries are accepted:

    ```bash
    TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_PRIVATE/.secrets/production/TAKOSUMI_DEPLOY_CONTROL_TOKEN")" \
      bun run ga:status -- \
        --json \
        --probe-live \
        --require-complete \
        --require-ga-readiness
    ```

11. Enforce production hardening only after the seven private evidence classes
    validate and the live internal gate agrees:

    ```bash
    cd takosumi
    bun run production-hardening:evidence -- "$TAKOSUMI_PRIVATE/evidence/production-hardening.json"
    bun run production-hardening:gates -- \
      "$TAKOSUMI_PRIVATE/evidence/production-hardening.json" \
      --url https://app.takosumi.com/internal/platform/hardening-gates \
      --require-enforced
    ```

12. Stage only sanitized production public evidence into the root quality docs,
    then run strict completion. With the standard operator-private layout, use
    the completion helper from the ecosystem root:

    ```bash
    bun run complete:takosumi-live-evidence -- \
      --readiness-evidence-ref <private-ref> \
      --readiness-public-summary <reviewed-text> \
      --hardening-public-summary <reviewed-text> \
      --append-summary \
      --verify-completion
    ```

    Use the lower-level staging helper only when the private files or gate URL
    live outside the standard `takosumi-private/evidence/*` layout:

    ```bash
    bun run stage:takosumi-live-evidence -- \
      --readiness-file <private-production-readiness.json> \
      --readiness-evidence-ref <private-ref> \
      --readiness-public-summary <reviewed-text> \
      --readiness-out docs/quality/platform-readiness-public-summaries/readiness-<date>-production.json \
      --hardening-manifest <private-production-hardening-manifest.json> \
      --hardening-gate-url https://app.takosumi.com/internal/platform/hardening-gates \
      --hardening-public-summary <reviewed-text> \
      --hardening-out docs/quality/production-hardening-public-summaries/hardening-<date>-production.json \
      --append-summary \
      --verify-completion
    ```

13. Open hosted Takosumi public access only after strict completion passes and operator
    approval is recorded.

## Takos website rehearsal

For staging rehearsals, build the Takos introduction site with the CTA pointing
at staging and a pinned Takos ref:

```bash
cd takos/website
export TAKOS_STAGING_INSTALL_URL="https://app-staging.takosumi.com/install?git=https://github.com/tako0614/takos.git&ref=<release-tag-or-commit>&path=deploy/opentofu"
VITE_CLOUD_INSTALL_URL="$TAKOS_STAGING_INSTALL_URL" \
VITE_CLOUD_USE_TAKOS_URL="$TAKOS_STAGING_INSTALL_URL" \
bun run build
```

Production `takos.jp` must point to `https://app.takosumi.com/install?...` with
a release tag or commit SHA, not `main`, `latest`, or `HEAD`.

## App public URL rehearsal

The generic OpenTofu resource smoke proves that Takosumi can create and destroy
provider resources, state, outputs, and audit records. It does not prove that a
Capsule's application artifact is publicly reachable.

For apps that publish a non-secret URL output such as `launch_url`,
`public_url`, `app_url`, or `url`, add a public URL check to the same private
evidence run:

```bash
bun run smoke:platform-control-plane -- \
  --verification-mode opentofu \
  --output-allowlist-json-file "$TAKOSUMI_PRIVATE/evidence/<app>-outputs.json" \
  --public-url-checks-json-file "$TAKOSUMI_PRIVATE/evidence/<app>-public-url-checks.json"
```

`<app>-public-url-checks.json` is an array of checks. Each `output` must also be
present in the output allowlist.

```json
[
  {
    "name": "launch",
    "output": "launch_url",
    "path": "/",
    "expectedStatus": 200,
    "bodyIncludes": ["Takos"]
  }
]
```

Do not use this check as proof for Takos or yurucommu until their
`takosumi_release.post_apply` path has actually materialized the Worker
artifact and the output points at the published origin. A resource-only
OpenTofu apply with `publicUrlVerified=false` is still incomplete for app
reachability.

## Non-goals

- Do not use production `app.takosumi.com` as the first real-cloud test cell.
- Do not copy operator config, secret values, private evidence refs, resource
  IDs, or provider account IDs into public docs.
- Do not treat staging public-summary rows as GA completion. They are rehearsal
  evidence only; production rows and matching sanitized JSON are required.
