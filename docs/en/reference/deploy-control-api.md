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

## Out Of Scope For Deploy-Control

Deploy-Control is the Run/state/output API for OpenTofu execution. It does not
own endpoint families for compatibility profiles, managed Cloud resources, or
official billing. Those surfaces are documented separately and advertised by
capabilities.

The OSS Deploy-Control API must not expose the official hosted Cloud endpoint
families:

```text
/compat/cloudflare/client/v4
/gateway/ai/v1
provider-compatible endpoint families
official managed resource backend controls
managed edge/storage/container resource APIs
official billing/quota/usage endpoints
```

The Compatibility API framework itself remains part of Takosumi. Specific
profiles such as `compat.cloudflare.workers.v1`, `compat.s3.v1`, or an
OpenAI-compatible AI endpoint are scoped, versioned capabilities, not hidden
Deploy-Control routes.

For the official hosted service, the currently documented Cloud endpoint
families are `compat.cloudflare.workers.v1`, `compat.s3.v1`, and the
OpenAI-compatible AI Gateway. Additional endpoint families must be specified
with their own compatibility matrix, auth model, usage contract, and
fail-closed behavior.
