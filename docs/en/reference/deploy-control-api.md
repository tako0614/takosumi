# Deploy-Control API

Last updated: 2026-07-13

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

## Output Sync

Output Sync is an optional Takosumi feature, not an OpenTofu standard. A host
that implements it advertises capability `takosumi.output-sync.v1`. It is
enabled by default per Workspace and can be disabled without disabling normal
Output capture or explicit Dependencies.

The public API consists of four routes:

```text
GET   /api/v1/workspaces/{workspaceId}/output-sync
PATCH /api/v1/workspaces/{workspaceId}/output-sync
GET   /api/v1/workspaces/{workspaceId}/output-sync/snapshot
POST  /api/v1/workspaces/{workspaceId}/output-sync/reconcile
```

The settings API reads and changes the Workspace setting. The snapshot returns
the current non-sensitive Outputs for the Workspace. Reconcile evaluates
eligible Capsules under the normal Run policy and approval rules. Output Sync
does not define a public event feed.
Active members may read settings and snapshots. Only owners and admins may
change settings or start reconciliation.

Reconcile pins each Capsule to its currently applied SourceSnapshot and plans
`active` / `stale` Capsules in Dependency-DAG layers. Members in one layer may
run in parallel; the next layer starts only after the prior layer is a no-op or
has applied successfully. Clean plans auto-apply, destructive plans stop at the
normal approval gate, and follow-up Output changes are bounded to five
convergence passes. Git ref updates are not mixed into this operation.

`service_exports` and `service_bindings` are optional Takosumi Output
Convention values carried by ordinary OpenTofu Outputs. They may describe an
endpoint, capability, authentication scheme, scope, or grant reference, but
must not contain tokens, passwords, or live data. Runtime data remains behind
the declared MCP, HTTP, S3, or other interface. Apply rejects credential-like
metadata keys and URLs containing userinfo or credential query parameters.

Using an Output across Workspace boundaries requires an explicit
`OutputShare`. When Output Sync is disabled or unavailable, `tofu output -json`
capture, the Capsule Output API, explicit Dependencies, and
`terraform_remote_state` continue to work independently.

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
