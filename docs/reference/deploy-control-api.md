# Deploy-Control API

Last updated: 2026-06-19

This API controls OpenTofu/Terraform execution in Takosumi OSS. It runs existing
providers as-is. Public compatibility profiles are separate capability-versioned
surfaces that map into the Resource Shape model, not hidden deploy-control
gateway routes.

## Public Surface

The OSS deploy-control surface is centered on:

```text
Workspace
Project
Capsule
Source
ProviderConnection
ProviderBinding
Secret
Run
StateVersion
Output
AuditEvent
```

A Capsule-driven plan Run is the caller contract: clients create or select a
Capsule, bind providers through ProviderBindings, create a `plan` Run, review the
saved plan result, then approve an `apply` or `destroy` Run against that saved
plan/state context.

## Minimal API Shape

```text
POST   /projects
GET    /projects/:id

POST   /capsules
GET    /capsules/:id
PATCH  /capsules/:id

POST   /connections
GET    /connections
GET    /connections/:id
DELETE /connections/:id

POST   /runs
GET    /runs/:id
GET    /runs/:id/logs
POST   /runs/:id/approve
POST   /runs/:id/cancel

GET    /state/:capsule_id/versions
GET    /outputs/:capsule_id

POST   /secrets
GET    /audit
```

## Provider Connections

ProviderConnection creation stores credential metadata and encrypted secret
references. A Run resolves ProviderBindings to ProviderConnections, evaluates the
CredentialRecipe, and injects only temporary env/file material into the runner.

Provider resolution statuses in OSS are:

```text
resolved_provider_connection
blocked_missing_connection
blocked_policy
```

The response must not include raw secrets, secret references, internal resolver
IDs, temporary credentials, or generated credential files.

## Runs

A Run records:

```text
source snapshot
tool version
provider lock digest
provider bindings
injected env metadata, not values
plan result
apply result
logs
outputs
state version
actor
timestamps
audit evidence
```

Secrets are redacted before logs or diagnostics are persisted.

## Release Activation Seam

Takosumi OSS treats a successful `apply` as an OpenTofu/Terraform ledger commit:
state versions, outputs, run history, and AuditEvent evidence are persisted.

Application publication is a separate operator/Cloud extension step. A host may
inject a post-apply release activator to publish a product artifact after the
apply ledger commit succeeds.

The seam is intentionally generic:

```text
OpenTofu apply
  -> StateVersion / Output ledger commit
  -> optional host-injected release activation
  -> AuditEvent: release_activation.pending|succeeded|failed
```

Operator webhook activators receive no provider credentials, no runner env, and
no sensitive OpenTofu outputs. Runner activators receive only dispatch-scoped
ProviderConnection / CredentialRecipe material minted from the same reviewed
ProviderBinding set as apply/destroy. Secret-shaped output names or values are
filtered before either hook. A release activation failure records AuditEvent
evidence but does not roll back the OpenTofu apply ledger; callers must surface
it as "infrastructure applied, application activation failed/pending" rather
than as a generic apply failure.

Capsules may mark individual post-apply commands with `executor = "runner"` or
`executor = "operator"`. Runner commands are restored into the source snapshot
and receive non-secret metadata such as `TAKOSUMI_OUTPUTS_JSON` plus
dispatch-only provider credentials when the reviewed run had ProviderBindings.
Operator commands are not attempted by the built-in runner activator; they
remain pending unless the host configures an operator/Cloud release activator
that owns the credential boundary for work outside the runner sandbox.

The platform Worker can enable the generic webhook bridge with:

```text
TAKOSUMI_RELEASE_ACTIVATOR_URL
TAKOSUMI_RELEASE_ACTIVATOR_TOKEN
```

The URL is non-secret operator config. The token is a Worker secret. Production
URLs must be `https`; `http` is accepted only in explicit local substrate/dev
mode. The webhook receives a `takosumi.operator.release-activation@v1` JSON
payload with deploy-control ledger ids, the current runtime Capsule /
StateVersion / Output context, deployment summary, and already-filtered
non-sensitive outputs. Public readiness evidence is expressed as Workspace /
Project / Capsule / StateVersion / Output claims. This payload is an
operator-controlled bridge contract, not a customer API surface. It must return
one of:

```json
{ "status": "skipped" }
{ "status": "pending", "message": "queued" }
{ "status": "succeeded", "launchUrl": "https://example.com" }
{ "status": "failed", "message": "publication failed" }
```

The webhook materializer is where product-specific publication lives. Takosumi
Core only forwards the SourceSnapshot reference, non-sensitive outputs, and
declared opaque argv commands. It does not inspect whether those commands migrate
a database, publish an artifact, update an index, or perform another app-owned
activation task.

## Cloud-Only Exclusions

The OSS API must not expose:

```text
/compat/cloudflare/client/v4
/gateway/ai/v1
provider-compatible Gateway endpoint routes
official managed resource backend controls
managed edge/storage/container resource APIs
official billing/quota/usage endpoints
```

Those belong to closed Takosumi Cloud.

The current Cloud extension route scope is `compat.cloudflare.workers.v1` and
the OpenAI-compatible AI Gateway only. Other Cloud extension routes must be
separately specified; OSS compatibility profiles remain scoped, versioned
capabilities outside this deploy-control API.
