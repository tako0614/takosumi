# Deploy-Control API

Last updated: 2026-07-14

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
Interface
InterfaceBinding
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
GET    /capsules/:capsule_id/outputs

POST   /v1/interfaces
GET    /v1/interfaces
GET    /v1/interfaces/:id
PATCH  /v1/interfaces/:id
DELETE /v1/interfaces/:id

POST   /v1/interfaces/:id/bindings
GET    /v1/interfaces/:id/bindings
GET    /v1/interfaces/:id/bindings/:bindingId
DELETE /v1/interfaces/:id/bindings/:bindingId

GET    /audit
```

`Secret` is the encrypted boundary of the OpenTofu Stack flow. In the current
v1alpha1 surface, provider secret material is write-only during
ProviderConnection registration and is materialized only for a Run. Takosumi
does not yet publish a standalone `POST /secrets` API or a `Secret` Resource
Shape. The latter is a future shape that requires its own schema, planner,
adapter, import, and drift contract; it is not one of the ten current bundled
compatibility shapes.

## Outputs and Runtime Interfaces

After a successful apply, Takosumi captures ordinary root-module Outputs from
`tofu output -json` in the StateVersion / Output ledger. The module owns each
Output name and value shape. Takosumi does not require a reserved name, nested
schema, runtime declaration, or credential in an Output.

To expose a deployed runtime as MCP, HTTP, a file handler, or another protocol,
create a service-side `Interface`. `Interface.spec` contains the consumer-owned
`type` and `version`, an arbitrary non-secret JSON `document`, and `access`.
Explicit `inputs` connect dynamic public values.

```json
{
  "workspaceId": "ws_1",
  "name": "researchTools",
  "ownerRef": { "kind": "Capsule", "id": "cap_1" },
  "spec": {
    "type": "mcp.server",
    "version": "2025-11-25",
    "document": {
      "transport": "streamable-http",
      "display": { "title": "Research tools" }
    },
    "inputs": {
      "endpoint": {
        "source": "capsule_output",
        "capsuleId": "cap_1",
        "outputName": "mcp_url"
      }
    },
    "access": {
      "visibility": "workspace",
      "resourceUriInput": "endpoint"
    }
  }
}
```

Input sources are `literal`, `capsule_output`, and `resource_output`. An input
may include an RFC 6901 JSON Pointer when only part of an Output is needed.
Takosumi resolves values into `status.resolvedInputs` and records provenance
from the originating Run / StateVersion / Output digest or Resource generation.
Outputs marked sensitive by OpenTofu or the explicit mapping, and unavailable
values, are not eligible runtime inputs. Output names themselves remain opaque.

An `InterfaceBinding` explicitly authorizes a Principal, ServiceAccount,
Capsule, or Resource with permissions and a credential-delivery method. The
credential value is never stored in the Interface, Binding, Output, state, Run,
log, or audit record. A supported issuer or materializer delivers it only to an
authorized invocation; unsupported delivery fails closed as `NotReady`.

Principal `oauth2` delivery becomes Ready only with a credential-free absolute
HTTPS resource URI, a host issuer, and host-side proof that the Interface owner
controls that hostname. A literal or Output URL alone is neither ownership proof
nor OAuth audience authority.

When an Output changes, only Interfaces that explicitly reference it resolve a
new revision. This does not plan or apply the whole Workspace, nor does it
reapply consumer Capsules. Use an explicit Capsule Dependency or
`terraform_remote_state` when the desired relationship is ordinary
OpenTofu-to-OpenTofu input wiring.

Migration from the pre-v1 `service_exports`, `service_bindings`, and
`app_deployment` conventions is a one-time operator operation at
`GET|POST /internal/v1/workspaces/:workspaceId/migrations/output-interfaces`.
The report returns no values: it exposes only the exact Capsule, InstallConfig,
and current Output fences plus available non-secret Output names. Known
first-party Capsules use service-side Interface blueprints; unknown third-party
Capsules use only the Output name and Interface type/version explicitly selected
by the owner. Completion requires a Resolved Interface and durable Activity
evidence, and legacy Output discovery is never fallback authority. The concrete
execution and rollback procedure belongs in operator runbooks, not the published
client contract.

## Provider Connections

ProviderConnection creation stores credential metadata and encrypted secret
references. A Run resolves ProviderBindings to ProviderConnections, evaluates the
CredentialRecipe, and injects only temporary env/file material into the runner.

Operator-managed capacity is an explicit service-side contract. A public
managed ProviderConnection declares an opaque `managedProviderProfile`, and its
receiving platform extension declares the exact same profile. Run-scoped token
audience verification uses this profile; Takosumi does not derive authority
from `providerConfig.base_url`, the request host/path, or the provider address.
Missing/mismatched profiles are unavailable, and OSS defines no fixed profile
catalog. `providerConfig` stays ordinary non-secret provider-block JSON.

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

Takosumi OSS treats provider infrastructure/state materialization and declared,
service-side InstallConfig Capsule lifecycle actions as one reviewed Run
boundary. Lifecycle actions are pinned with the Plan; they are never discovered
from a Git manifest, repository metadata, or OpenTofu Output.

With no declared action, a successful provider `apply` is sufficient. When a
`post_apply` action is declared, the host must inject the generic release
activator and that action must return terminal `succeeded` before the Capsule
runtime can become ready.

The seam is intentionally generic:

```text
OpenTofu apply
  -> construct provider-applied StateVersion / Output
  -> declared post_apply action (host-injected activator)
  -> atomic ledger commit:
       succeeded => Run succeeded + Capsule active
       otherwise => StateVersion / Output retained + Run failed + Capsule error
  -> materialize Ready Interface blueprints only after succeeded
```

Operator webhook activators receive no provider credentials, no runner env, and
no sensitive OpenTofu outputs. Runner activators receive only dispatch-scoped
ProviderConnection / CredentialRecipe material minted from the same reviewed
ProviderBinding set as apply/destroy. Secret-shaped output names or values are
filtered before either hook. Every result other than `succeeded` (`pending`,
`skipped`, `failed`, a missing activator, or an exception) fails closed. The
provider-applied StateVersion / Output and actual provider apply usage/billing
capture are retained, but the Run fails with
`capsule_lifecycle_action_failed`, the Capsule becomes `error`, and Interface
blueprints do not become Ready. The Plan is consumed as applied, so generic
recovery is a fresh reviewed plan/apply rather than retrying the same Plan.

A declared `pre_destroy` action runs before provider destroy. Takosumi does not
call `runner.destroy` unless the action terminally succeeds. Failure after an
activator was invoked makes runtime safety Unknown; a pre-mutation failure such
as a missing activator re-evaluates the still-pinned runtime revision.

Capsules may mark individual post-apply commands with `executor = "runner"` or
`executor = "operator"`. Runner commands are restored into the source snapshot
and receive non-secret metadata such as `TAKOSUMI_OUTPUTS_JSON` plus
the non-secret provider configuration resolved from the exact binding as
`TAKOSUMI_PROVIDER_CONFIGS_JSON` (`takosumi.provider-configurations@v1`) when
the reviewed run had ProviderBindings. Its `providers` array has one entry for
every resolved binding and identifies it by provider source and alias (`null`
means the default provider block). A binding that uses provider defaults is
still present with `configuration: {}` rather than being omitted. Both the
binding digest and RunEnvironment evidence digest fence its contents. Command
env cannot override this reserved name. Dispatch-only
provider credentials remain a separate bundle and reach the runner only when
the action explicitly opts in.
Operator commands are not attempted by the built-in runner activator. Without
an operator/Cloud release activator that owns the credential boundary for work
outside the runner sandbox, the Run fails closed immediately.
Commands may also declare `timeout_seconds` / `timeoutSeconds` as an execution
constraint. This remains a service-side InstallConfig declaration, not a Git
manifest or OpenTofu Output: Takosumi does not interpret the command semantics,
but the runner enforces the declared timeout for long app-owned activation
bridges such as container artifact upload or provider-gap setup.

The platform Worker can enable the generic webhook bridge with:

```text
TAKOSUMI_RELEASE_ACTIVATOR_URL
TAKOSUMI_RELEASE_ACTIVATOR_TOKEN
```

The URL is non-secret operator config. The token is a Worker secret. Production
URLs must be `https`; `http` is accepted only in explicit local substrate/dev
mode. The webhook receives a `takosumi.operator.release-activation@v2` JSON
payload with canonical `workspaceId`, Capsule, StateVersion, Output, and Run
ledger references plus already-filtered non-sensitive outputs. Its
`providerConfigurations` field carries the same exact non-secret envelope;
secret-like keys and values are rejected again before dispatch. It does not
accept retired Space / Installation / Deployment aliases. Public readiness
evidence is expressed as Workspace /
Project / Capsule / StateVersion / Output claims. This payload is an
operator-controlled bridge contract, not a customer API surface. It must return
one of:

```json
{ "status": "skipped" }
{ "status": "pending", "message": "queued" }
{ "status": "succeeded", "healthUrl": "https://example.com/healthz" }
{ "status": "failed", "message": "publication failed" }
```

The webhook materializer is where product-specific publication lives. Takosumi
Core only forwards the SourceSnapshot reference, non-sensitive outputs, and
declared opaque argv commands. It does not inspect whether those commands migrate
a database, publish an artifact, update an index, or perform another app-owned
activation task.
Any URL in a successful response is operational health evidence only. Launcher
URLs and presentation are declared and authorized separately through an
`interface.ui.surface` Interface and InterfaceBinding; the activator response
is neither runtime-surface authority nor a fallback.

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
