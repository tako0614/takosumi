# Takosumi Cloud Customer Operations

This runbook defines the customer-facing operating surface required before
Takosumi Cloud can be treated as a generally available hosted service.

Takosumi OSS and Takosumi for Operator remain OpenTofu/Terraform control plane
software. This document is for the closed official Takosumi Cloud deployment at
`app.takosumi.com`.

## Scope

Takosumi Cloud exposes the hosted dashboard, Google sign-in, Capsule install
flow, Provider Connection setup, plan/apply review, billing surfaces, exports,
and support operations. The operator must keep production access closed until
the launch-readiness evidence validates.

GA requires these customer operations to be true in production:

- A new user can open an install link, sign in with Google, review the Capsule,
  add required Provider Connections, and continue without CLI fallback.
- A workspace owner can identify the Workspace settings area for members,
  connections, billing, backups, and output sharing.
- Billing state is visible before paid enforcement is enabled.
- Export and self-host migration paths are documented before customers rely on
  hosted state.
- Support and escalation paths are written down and have owners.
- Suspension, deletion, and export wording is explicit before any account or
  Workspace restriction is applied.

## Onboarding Guide

Customer onboarding starts from `https://takosumi.com` or a product install
link from Takos.

Until GA, customer onboarding is closed access. The official Cloud origins
accept only the verified Google account `shoutatomiyama0614@gmail.com`; all
other Google accounts are rejected after OAuth callback and any existing session
outside that allowlist is cleared.

1. Open the external install link. The platform must preserve `git`, `ref`,
   `path`, and allowed `var.*` query parameters into `/new`.
2. Sign in with Google. GitHub OAuth is not a GA sign-in provider.
3. Confirm that the pending install request is visible on the sign-in page
   before continuing.
4. Review the Capsule source, pinned ref, path, compatibility result, and
   required Provider Connections in `/new`.
5. Add any required Provider Connections from Workspace settings.
6. Return to `/new`, run the compatibility check, and create the Capsule only
   after the user confirms the review.
7. Open the Capsule detail page and inspect run status, logs, state, and
   outputs.

No onboarding path may ask a non-operator customer to run `tofu`, `wrangler`, or
manual `.env` setup for the hosted Takosumi Cloud install path.

## Admin Guide

Workspace administration lives under `/workspace/settings`.

The customer-visible sections are:

- General: Workspace name and policy.
- Members: owner/admin/member/viewer membership management.
- Connections: Provider Connections and OAuth helper flows.
- Billing: current mode, USD balance, plans, reservations, and usage.
- Backups: control/state backup history.
- Output shares: explicit output sharing between producer and consumer
  Capsules.

Legacy `/space/settings` paths may redirect for compatibility, but new UI,
support docs, and customer communication must use Workspace wording.

## Billing FAQ

Takosumi Cloud billing must remain understandable before enforcement is opened.

- `disabled`: billing UI can be present, but deploys are not blocked by USD balance
  state.
- `showback`: usage is recorded for customer visibility, but no charge is
  collected.
- `enforce`: deploys require an eligible plan or USD balance.

Before enabling `enforce` for a customer cohort, the operator must verify Stripe
checkout, webhook ingestion, entitlement projection, invoice handling, failed
payment handling, dunning, recovery, refund/credit handling, and billing support
procedures in the launch-readiness evidence.
Cloud-only WfP / AI / managed resource pricing is configured separately in
`TAKOSUMI_CLOUD_USAGE_PRICE_BOOK`; the price table, free tier rule, and minimum
gross-margin guard are defined in [`cloud-pricing.md`](cloud-pricing.md).

The dashboard may show empty plans or disabled billing in closed access. That is
valid only while Takosumi Cloud remains pre-GA or closed.

First create or reuse Stripe prices in the operator Stripe account, write the
non-secret Takosumi billing plan catalog, then run the billing readiness
preflight against operator-private config and the live authenticated billing
plan projection:

```bash
bun run bootstrap:takosumi-stripe-billing -- \
  --private-root takosumi-private \
  --environment production \
  --write-template

# Edit takosumi-private/evidence/billing-plan-spec-production.json.

bun run bootstrap:takosumi-stripe-billing -- \
  --private-root takosumi-private \
  --environment production \
  --out-file evidence/billing-plans-production.json

bun run write:takosumi-billing-config -- \
  --private-root takosumi-private \
  --environment production \
  --plans-file evidence/billing-plans-production.json

bun run write:takosumi-stripe-secret -- \
  --private-root takosumi-private \
  --environment production \
  --secret secret-key \
  --stdin

bun run write:takosumi-stripe-secret -- \
  --private-root takosumi-private \
  --environment production \
  --secret webhook-secret \
  --stdin

cd takosumi
bun run cli -- secrets apply \
  --config ../takosumi-private/platform/wrangler.toml \
  --secrets-dir ../takosumi-private/.secrets/production
cd ..

# Normal deploy path:
TAKOSUMI_BUILDX_BUILDER=takosumi-remote \
WRANGLER_DOCKER_BIN="$PWD/scripts/wrangler-docker-buildx-wrapper.sh" \
  bunx wrangler@latest deploy \
  --config takosumi-private/platform/wrangler.toml

# Alternative for Worker-only deploys that do not change takosumi/runner/Dockerfile
# or copied runner inputs. Use this instead of the normal deploy above; the
# wrapper retags the existing local :worker image when Wrangler asks for a
# versioned runner image tag.
TAKOSUMI_REUSE_EXISTING_CONTAINER_IMAGE=1 \
TAKOSUMI_BUILDX_BUILDER=takosumi-remote \
WRANGLER_DOCKER_BIN="$PWD/scripts/wrangler-docker-buildx-wrapper.sh" \
  bunx wrangler@latest deploy \
  --config takosumi-private/platform/wrangler.toml

bun run check:takosumi-billing-readiness -- \
  --private-root takosumi-private \
  --environment production \
  --checkout-smoke \
  --out-file evidence/billing-readiness-production.json
```

For pre-GA closed access, the production origin may be verified with Stripe
test-mode secrets as a sandbox proof:

```bash
bun run check:takosumi-billing-readiness -- \
  --private-root takosumi-private \
  --environment production \
  --allow-production-test-stripe \
  --checkout-smoke \
  --out-file evidence/billing-readiness-production-sandbox.json

bun run status:takosumi-completion -- \
  --environment production \
  --probe-live \
  --require-complete \
  --billing-checkout-smoke \
  --allow-production-test-stripe \
  --out-file takosumi-private/evidence/completion-status-production-sandbox.json
```

This proves the production-equivalent billing path can create Stripe Checkout
Sessions without opening paid enforcement. In this mode `complete: true` means
the closed pre-GA runtime path is complete with sandbox billing and
`sandboxComplete: true` means runtime checks, live probe, and test-mode Checkout
smoke passed. `launchReady` remains false until accepted production public
readiness evidence is published, and paid enforcement still requires live-mode
Stripe secrets plus `status:takosumi-completion --require-billing-readiness`.

`bootstrap:takosumi-stripe-billing` creates or reuses Stripe prices by stable
lookup key and writes only the non-secret Takosumi billing plan catalog. It reads
the Stripe secret key from an operator-private secret file or an explicit
operator env var, and must not print or write the secret. `write:takosumi-billing-config`
only writes non-secret plan catalog and redirect allowlist vars into the
realized Wrangler config. Deploy `takosumi-private/platform/wrangler.toml`
after writing those vars; otherwise the live billing plan projection still sees
the previous Worker config. Stripe API keys and webhook signing secrets must go
through `write:takosumi-stripe-secret` and the operator secret apply command; do
not place secret values in `wrangler.toml` or evidence files. The readiness
preflight uses `--checkout-smoke` after deploy so every configured plan proves it
can create a Stripe Checkout Session through the live worker.

Usage-based Cloud resources need a separate Stripe invoice item price map. The
Cloud extension records customer-facing usage into the Workspace usage ledger;
then an operator job calls the account-plane
`POST /v1/billing/stripe/usage-invoice-items` route with
`x-takosumi-billing-usage-sync-token`. The route can receive the recorded
`usageEvents`, import them into Installation billing usage reports by
`billingAccountId`, and then create Stripe invoice items from the unexported
reports. Configure
`TAKOSUMI_STRIPE_USAGE_INVOICE_ITEM_PRICES` in the realized Worker config as a
non-secret JSON array, for example:

```json
[
  {
    "meter": "cloudflare.workers_script",
    "unit": "requests",
    "unitAmount": 4,
    "currency": "usd"
  },
  {
    "meter": "takosumi.ai_gateway",
    "unit": "requests",
    "unitAmount": 10,
    "currency": "usd"
  }
]
```

Set `TAKOSUMI_ACCOUNTS_BILLING_USAGE_SYNC_TOKEN` as an operator secret when a
separate sync token is desired. If it is omitted, the route falls back to
`TAKOSUMI_DEPLOY_CONTROL_TOKEN`; production should prefer the narrower dedicated
token before GA. Workers for Platforms stays an internal implementation detail:
bill users as `cloudflare.workers_script`. Do not configure or emit `wfp` /
`workers_for_platforms` as a `meterId`, `resourceFamily`, Stripe usage meter, or
public usage metadata.

Cloud extensions should emit precise usage headers. The platform worker also
records fallback operation usage for successful Gateway requests that have a
verified billing Workspace context and no usage headers, so a missing Cloud
extension usage header does not silently skip billing evidence. Treat this as a
GA safety net; it does not replace precise token, request, or storage metering
inside the closed Cloud extension.

Storage GB-hour billing is not request-count billing. Before KV / R2 / D1
storage is presented as usage-complete, the closed Cloud extension or an
operator metering job must emit measured `gateway_storage_gb_hour` events from
provider inventory with a real `periodStart` / `periodEnd`. Similarly,
Containers and Durable Objects must not be advertised as available Takosumi
Cloud managed resources until their compat/managed routes, usage headers or
fallback preauthorization, ledger smoke, and destroy proof are collected.

GA billing evidence is collected through the `billing-operation` operation-drill
batch and the `external-provider` billing provider batch. The latter covers
Stripe checkout/webhook, failed payment, invoice, tax, plan transition, and
refund/credit evidence:

```bash
bun run status:takosumi-readiness-gaps -- \
  --file takosumi-private/evidence/platform-readiness-production.json \
  --collection-class external-provider \
  --checklist \
  --write-collection-workplan takosumi-private/evidence/external-provider-workplan-production-current.json \
  --json

bun run plan:takosumi-operation-drills -- \
  --workplan-file takosumi-private/evidence/external-provider-workplan-production-current.json \
  --batch billing-provider-events \
  --print-batch-template \
  --out-file takosumi-private/evidence/billing-provider-events-template.json

bun run plan:takosumi-operation-drills -- \
  --batch billing-operation \
  --print-batch-template \
  --out-file takosumi-private/evidence/billing-operation-template.json
```

The batch includes public-safe commands for billing plan preflight, billing /
usage / reservation state capture, private template generation, and manifest
validation. Accepted evidence still requires real webhook event ids,
entitlement state changes, dunning/suspension proof, and refund or credit-note
proof in the operator-private readiness manifest. Public summaries must not
contain payment details, customer identity, card data, or raw webhook payloads.

## Export Guide

Customers must have a clear hosted-to-self-host exit path.

The export path must document:

- which account, Workspace, Capsule, Run, StateVersion, Output, and audit data is
  included;
- which secret values are excluded or re-entered by the customer;
- how the export bundle is encrypted;
- how the download URL is signed and expires;
- how to import into a self-hosted Takosumi or Takos distribution worker;
- how login works after import;
- which hosted resources remain, are retained, or are deleted after export.

The operator must not claim export readiness until a clean import, post-import
login, and sample data verification have been rehearsed.

GA export/import/privacy evidence is collected through the
`export-import-sovereignty` operation-drill batch:

```bash
bun run plan:takosumi-operation-drills -- \
  --batch export-import-sovereignty \
  --print-batch-template \
  --out-file takosumi-private/evidence/export-import-sovereignty-template.json
```

The batch includes account-plane export request/readback commands and private
template generation. It does not make an export ready by itself; accepted
evidence must include an encrypted archive digest, recipient fingerprint,
clean self-host import, post-import login/state verification, retention state,
and privacy request rehearsal using scratch data only.

For node-postgres/Bun substrate exports, the accepted archive digest source is
the completed export operation's `archiveDigest` field. It is computed from the
final `takos-export-<op>.tar.zst[.age]` artifact and should be copied into
`encrypted-export.archiveDigest` evidence together with the operation id and
age recipient.

For the Cloudflare/R2 hosted profile, encrypted metadata exports are delivered
as a Cloudflare/R2 export JSON document. That document embeds the same canonical
installation export bundle under `bundle`, and the import-plan command accepts
either `takos-export/bundle.json` or the Cloudflare/R2 export JSON document.
Data-bearing archive export still requires a substrate export worker; do not
record Cloudflare/R2 metadata export alone as clean-import, post-import-login,
or sample-data verification evidence.

To prepare a self-host restore without reopening the retired public import
route, extract `takos-export/bundle.json` from the archive or use the decrypted
Cloudflare/R2 export JSON document, then generate the target PlanRun request
and Accounts projection create template:

```bash
bun run cli -- internal installations import-plan \
  --bundle-file takos-export/bundle.json \
  --target-issuer https://selfhost.example.com \
  --target-account acct_target \
  --target-workspace workspace_target \
  --created-by-subject tsub_target \
  --target-capsule-id cap_target \
  --out-file import-plan.json
```

The generated plan is review input. It is not a network import and does not by
itself satisfy clean-import or post-import-login readiness evidence.

To execute the clean import path on a target that has an Accounts bearer with
write access to the target Workspace, run:

```bash
bun run cli -- internal installations import-apply \
  --plan-file import-plan.json \
  --accounts-url https://selfhost.example.com \
  --token "$TAKOSUMI_ACCOUNTS_TOKEN" \
  --idempotency-key import-$(date +%s) \
  --provider cloudflare=<target-provider-connection-id> \
  --variables-file target-variables.json \
  --json \
  --out-file import-apply-result.json
```

`import-apply` creates a target PlanRun through
`/v1/capsule-projections/plan-runs`, requires that reviewed plan to be
`succeeded`, then creates the target Accounts projection through
`/v1/capsule-projections` with the reviewed expected guard. It does not
call the retired `/v1/capsule-projections/import` route, and it must not be
recorded as post-import-login or sample-data verification until the restored
target has been opened and checked.

## Privacy Request Ledger

Customer export and deletion requests are recorded through the account-plane
privacy request ledger. The ledger stores request state, retention references,
and operator completion references only. It must not store raw personal data,
support mailbox bodies, payment details, provider credentials, or export bundle
contents.

The customer-facing request API is session-authenticated:

```text
POST /v1/privacy/requests
GET  /v1/privacy/requests
GET  /v1/privacy/requests/:requestId
```

The completion API is operator-only and requires the configured privacy
operations token in `x-takosumi-privacy-operations-token`:

```text
POST /v1/privacy/requests/:requestId/complete
```

`POST /v1/privacy/requests` accepts `kind: "export"` or `kind: "delete"` and
returns a `prq_...` request id, a retention record id, and the active privacy
policy reference. `complete` records the operational result:

- export requests may complete as `exported` or `rejected`;
- delete requests may complete as `login_disabled`, `deleted`, or `rejected`;
- `export_ref` must point to an operator-controlled evidence reference, not to
  a public download URL containing customer data.

GA privacy evidence must include the privacy request id, the completion status,
the retention record id, the policy reference, and the separate private evidence
that proves export/import or deletion handling. The request ledger by itself is
not proof that the data was exported, imported, or deleted.

## Escalation Matrix

Takosumi Cloud support ownership is:

| Area                        | Primary owner           | Escalation                    |
| --------------------------- | ----------------------- | ----------------------------- |
| Sign-in and accounts        | Takosumi Cloud operator | OIDC/account-plane maintainer |
| Install and Capsule review  | Takosumi Cloud operator | Control-plane maintainer      |
| Provider Connection failure | Takosumi Cloud operator | Provider runtime owner        |
| Runner failure              | Takosumi Cloud operator | Runner/container owner        |
| Billing and entitlement     | Takosumi Cloud operator | Billing owner                 |
| Data export or deletion     | Takosumi Cloud operator | Security/privacy owner        |
| Incident response           | On-call operator        | Incident commander            |

Customer-impacting incidents must create an incident record, customer support
note, and follow-up action list before the readiness evidence can pass.

## Suspension, Delete, And Export Wording

Before restricting a customer account or Workspace, the customer-facing message
must say:

- what was restricted;
- whether sign-in, new runs, apply, destroy, exports, and downloads remain
  available;
- what data is retained and for how long;
- how to request export or deletion;
- how to recover access when recovery is allowed;
- which support channel owns the request.

Deletion wording must not imply immediate provider-side resource deletion unless
the destroy flow has actually run and the resulting StateVersion/Output evidence
has been recorded.

Export wording must not promise secret recovery. Secret material remains
write-only and must be re-entered or reconnected by the customer unless a
specific encrypted export mechanism has passed readiness.

## GA Evidence Mapping

This runbook backs the `customer-operations` launch-readiness domain:

- `onboarding-guide`: this document, sections "Scope" and "Onboarding Guide".
- `admin-guide`: this document, section "Admin Guide".
- `billing-faq`: this document, section "Billing FAQ".
- `export-guide`: this document, section "Export Guide".
- `privacy-request-ledger`: this document, section "Privacy Request Ledger".
- `escalation-matrix`: this document, section "Escalation Matrix".
- `suspension-delete-export-wording`: this document, section
  "Suspension, Delete, And Export Wording".

Passing this domain means the written customer operations surface exists. It
does not replace Stripe, support mailbox, privacy operation, export/import, or
incident drills required by other readiness domains and rehearsal steps.
