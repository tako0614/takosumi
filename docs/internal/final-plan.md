# Takosumi Final Plan

Last updated: 2026-07-15

This document is the authoritative Takosumi product direction.

## 0. Definition

Takosumi is an open, Git-based OpenTofu control plane.

```text
Takosumi =
  Git-based OpenTofu control plane
  + plain OpenTofu stack execution
  + Resource Shape Deploy API (`/v1/resources` lifecycle authority)
  + Interface / InterfaceBinding API
  + Resolver / Planner / Reconciler
  + Target / Credential / OIDC / Secret / Policy
  + Compatibility API framework
  + Adapter system
```

Takosumi is not a cloud clone. It runs plain OpenTofu stacks as-is with
existing OpenTofu/Terraform providers, and its managed-service path resolves a
provider-neutral service form (`ResourceShape`) to operator-enabled targets.
The lifecycle authority for that path is the `/v1/resources` Deploy API, not an
OpenTofu provider, compatibility handler, adapter, or backend manager.

The product split is:

```text
Takosumi:
  OSS core control plane.

Takosumi for Operator:
  Takosumi + customer/tenant/billing/quota/operator operation.

Takosumi Cloud:
  the official hosted Takosumi for Operator, with official managed targets,
  Cloud-operated managed service backends, versioned pricing, billing,
  support, and SLA.
```

Takosumi Cloud is an official deployment of Takosumi for Operator. It is not a
separate product core.

## 1. The Key Rule

Keep external infrastructure on industry-standard providers when those
providers already work. Define every Takosumi-managed service offering as a
provider-neutral Resource Shape and keep its lifecycle in the Deploy API.
Standard and vendor-compatible protocols are entrances or data planes for that
service; they are not competing lifecycle authorities.

```text
External resource already has an adequate OpenTofu provider/API:
  use it through the plain OpenTofu Stack flow.

Takosumi/operator offers the service as managed capacity:
  define a provider-neutral typed Resource Shape with schema, validation,
  planner, lifecycle/state/import/drift behavior, and capability evidence.
  Expose standard or compatible protocols around that same Resource when useful.

One-off implementation gap with no managed-service contract:
  keep it in an ordinary module plus ProviderConnection; do not invent a shape.
```

This is not "Takosumi should create every missing provider." It is:

```text
vendor-neutral provider or standard API already exists:
  prefer it. Takosumi can manage credentials, runs, state, outputs, policy, and
  usage around that surface without adding a takosumi_* resource.

standard surface exists:
  do not recreate its provider-specific resource vocabulary in takosumi_provider.
  A Takosumi-managed service may still have its own provider-neutral shape and
  use the standard as a control-plane translation or data-plane protocol.
  Examples: S3-compatible object storage, OCI registry, Kubernetes CRD,
  CloudEvents, OpenAI-compatible API, scoped Cloudflare Workers-compatible API.

standard surface does not exist, but the need is one-off:
  use a declared-env-capable ProviderConnection and a normal OpenTofu
  provider/module.

Takosumi/operator offers a durable managed service form:
  add a typed Takosumi shape with schema, validation, planner, adapter,
  import/drift/state story, and capability evidence.

provider schema does not correspond to a provider-neutral Takosumi-managed
service form or an operator/admin object:
  do not add it. It has no reason to exist in the Takosumi provider.
```

The `takosumi/takosumi` provider is therefore not the preferred or required
path just because Takosumi is involved. It is an optional typed HCL facade for
provider-neutral Resource Shapes owned by the Deploy API. A standard protocol
may be a better client or data plane, but it never makes the provider or compat
handler the lifecycle authority.

Before adding any `takosumi_*` resource, the design must pass a prior-art gate:

```text
1. Is this only external infrastructure that an existing provider/module can
   own through the Stack flow?
2. Does Takosumi/operator actually offer and operate this capacity?
3. Is there one durable provider-neutral service form rather than a vendor API
   resource clone?
4. Does its lifecycle require Takosumi-owned resolution, binding projection,
   policy, metering, import/drift, or managed-target placement?
```

If answer 1 is yes and answers 2-4 are no, do not add a Takosumi Resource. If
answers 2-4 are yes, define the managed service as a Resource Shape even when a
standard control/data protocol exists. `takosumi/takosumi` remains optional:
the Deploy API is canonical, and provider/CLI/dashboard/compatibility are clients.

The client surface is intentionally replaceable. If a better universal provider
or protocol appears, new clients may use it, but supported control operations
translate into the same Resource lifecycle and data-plane operations resolve
the same Ready Resource. Takosumi never requires the HCL provider merely to keep
the managed-service state canonical.

Examples:

```text
Ordinary S3/R2/GCS bucket:
  use existing OpenTofu providers such as hashicorp/aws,
  cloudflare/cloudflare, or a MinIO/S3-compatible provider.

Object storage that must be projected as a managed binding into an EdgeWorker,
locked by Takosumi resolution, metered by an operator, or exposed through a
provider-neutral service contract:
  keep the standard S3-compatible API as the data-plane surface. Enable
  compat.s3.v1 only when Takosumi owns the import/data path, binding
  projection, policy, metering, or managed-target control.

Ordinary VM, Kubernetes, or container infrastructure:
  use existing OpenTofu providers when that is sufficient.

Provider-neutral edge JavaScript app hosting:
  use takosumi_edge_worker. This is one service shape, not the whole Cloud
  product identity.

AI Gateway or OpenAI-compatible upstream access:
  do not create a Takosumi Resource Shape by default.
  publish the endpoint/model as an Interface when runtime discovery is needed;
  deliver the API key through InterfaceBinding, Secret, ProviderConnection, or
  generic env according to whether it is runtime or provider authentication.

Push notification delivery:
  do not create a Takosumi Resource Shape or takosumi_provider resource.
  APNs, FCM, Web Push, email, webhook, Matrix-compatible push gateways, and
  product-native notification delivery stay in the product host, a normal
  OpenTofu module/provider, a client-owned gateway, or generic env. Takosumi may
  define a product-neutral notification pusher contract, where a client registers
  an HTTP pusher (`app_id`, `pushkey`, `data.url`, format) and the host sends a
  minimal gateway envelope. Takosumi still does not advertise a
  PushNotification capability, resolver shape, managed target, or provider
  resource.
```

Do not add a Takosumi-owned resource just because another cloud already has a
provider. Add one only when Takosumi needs to own a portable service form,
resolution lock, binding projection, policy surface, or compatibility import
path.

## 2. Two Authoring Flows And One Shared Interface Layer

### 2.1 Plain OpenTofu Stack Flow

Users can bring a normal Git repository containing OpenTofu/Terraform.

```text
Git URL + ref/tag/commit + module path
  -> checkout
  -> tofu init
  -> tofu plan
  -> policy check
  -> approval
  -> tofu apply
  -> state / outputs / logs / audit
```

Takosumi does not abstract the cloud provider in this flow. Users use existing
providers directly.

```hcl
resource "aws_s3_bucket" "assets" {
  bucket = "my-assets"
}
```

Takosumi manages the outside of the run:

```text
ProviderConnection
CredentialRecipe
ProviderBinding
run-scoped env/file injection
state
outputs
logs
audit
approval
policy
```

#### OpenTofu Output Boundary

The plain Stack flow ends a successful apply by running `tofu output -json`
and capturing the resulting `StateVersion` and ordinary root `Output` values.
Explicit output-to-input Dependencies and `terraform_remote_state` remain
ordinary OpenTofu integration choices.

Output is a module return value, not Takosumi's runtime declaration language.
A Capsule can expose any valid root Output name and value shape. Takosumi does
not require `service_exports`, `service_bindings`, `app_deployment`, a reserved
MCP name, a nested Takosumi schema, or credentials in Output. When Takosumi
needs one of those public values for an Interface, service-side configuration
explicitly maps the Interface input to the Output name and optional JSON
Pointer.

When Takosumi executes a repository module through a generated root, that root
must re-export the selected child outputs with the same names, values, and
sensitivity metadata; otherwise the runner executes the repository module as
the root. Interface resolution reads only persistent captured root outputs.
Ephemeral outputs are unavailable, and sensitive outputs are rejected as
Interface inputs even though they remain valid OpenTofu language features.

Capturing a changed Output does not schedule Workspace-wide reconciliation.
Only an explicit output-to-input Dependency marks the declared downstream
Capsule stale. Runtime Interface consumers observe a new resolved Interface
revision without applying their own OpenTofu Capsule.

#### Artifact Reference Boundary

Source archives, state generations, raw output envelopes, Run artifacts, and
backup artifacts use host-allocated opaque refs. The portable names are
`archiveRef`, `stateRef`, `rawArtifactRef` / `rawOutputRef`, and `ref`; none
encode an R2 bucket, object-key layout, filesystem path, or durability scheme.
Takosumi Core requests refs through an injected allocator before dispatch and
never reconstructs them from Workspace, Capsule, Resource, generation, or Run
ids. The runner/storage adapter owns physical placement and durability and must
persist at the supplied ref. Physical key layouts belong only to that adapter.

Provider execution has one invariant:

```text
all valid provider sources
  -> one provider-neutral OpenTofu execution path (`opentofu-default`)

known provider
  -> optional Credential Recipe, guided UI, and warm-cache convenience

unknown provider
  -> the same execution path, with explicit env/file ProviderConnection when
     credentials are needed
```

There is no verified/unverified provider tier, provider-specific runner
auto-selection, or Takosumi provider allowlist derived from recipe metadata.
Provider installation uses a configured cache or mirror when available and the
normal OpenTofu registry path otherwise. An operator may explicitly require a
mirror, deny a provider source, or select a capability-specific runner profile,
but those are policy/capability decisions rather than provider catalog status.

Provider configuration and child-module defaults are connection data. A
managed connection may declare non-secret `providerConfig` and
`moduleInputDefaults`; core renders those generic maps after validating them.
Core must not infer Cloudflare, AWS, or another provider's HCL arguments or
module variable names.

Public operator-managed capacity additionally requires an explicit opaque
`managedProviderProfile` on the service-side ProviderConnection and the same
exact profile on the receiving platform extension. That profile is the
run-token audience and the only managed-provider issuer selection authority in
the default composition. `providerConfig.base_url`, provider source, request
host/path, and Output values never imply managed-provider usability or token
authority. Missing/mismatched profiles fail closed, and Core owns no fixed
profile catalog.

Credential Recipe discovery replaces provider catalog listing. A recipe says
how to create temporary env/files and may be absent for a perfectly valid
provider. Concrete failures use stable reasons such as invalid provider source,
package unavailable, platform binary unavailable, protocol mismatch, policy
denial, missing runner capability, checksum mismatch, or OpenTofu init failure.

Deployable cloud resources are still OpenTofu resources when the selected
provider can express them. For example, a Cloudflare Worker app should declare
its `cloudflare_workers_script`, bindings, queue consumers, routes, and durable
backing resources in the app repository's `.tf` when those provider resources
are adequate. Takosumi should not replace that with a hidden release API.

Application build and artifact creation normally happen in the app repository's
CI/release pipeline or inside an explicitly declared OpenTofu path. For projects
that need build-on-install, a Capsule may carry an explicit service-side
`sourceBuild` recipe. Takosumi runs its argv commands against the pinned Git
SourceSnapshot without provider credentials, checks declared relative outputs,
and then runs the repository's OpenTofu module. Takosumi never infers commands or
secretly decides which build/artifact path to use.

Store listings announce installable Git repositories. A listing is only the
Git pointer plus lightweight discovery/display metadata such as name,
description, icon, tags, and publisher. It must not own setup inputs,
install-flow projections, output allowlists, release artifacts, domain defaults,
or OIDC wiring.

The store is discovery and presentation only. Git URL, branch, tag, commit,
module path, SourceSnapshot, and automatic update policy belong to the Git
Source / Run flow; a store node must not become the release authority for an
installed Capsule.

Store nodes are switchable. Changing the selected store changes listing
discovery and presentation metadata only; it must not change how Takosumi
resolves refs, creates SourceSnapshots, or runs OpenTofu.

An explicit Capsule update resolves the Git ref through a SourceSyncRun, waits
for the exact immutable SourceSnapshot produced by that Run, checks that
snapshot, and pins it into the OpenTofu plan. A manual review sync must not race
the user with a second auto-update plan/apply. Scheduled/webhook observation may
evaluate an explicitly enabled Capsule auto-update policy; only a clean,
non-destructive plan can continue automatically.

A repository may publish `.well-known/tcs.json` as an optional repo-owned
presentation document for Store indexers. It is not a Takosumi manifest and is
not required for direct Git installs. It can contain display text, icon URL,
and `modulePath`. It must not declare `git`, `source`, refs/commits,
`installConfigId`, variable presentation/defaults, install projections, output
allowlists, release artifacts, domain defaults, OIDC wiring, lifecycle actions,
or Interface blueprints. Unknown authority-like fields are ignored. Public
values come from the module's typed OpenTofu outputs after service-side policy
is applied. Do not use source comments as the metadata schema.

`source_sync` records a bounded observation of the repository-root document on
the immutable `SourceSnapshot`, separately from the selected module archive.
This preserves one Git/commit authority even when `Source.defaultPath` points at
a nested OpenTofu module. The observation is presentation evidence only:
missing, malformed, or changed repository metadata never blocks snapshot reuse,
plan/apply, OIDC provisioning, or Interface resolution.

Install UX and runtime semantics are instead explicit, top-level, DB-owned
`InstallConfig` declarations. `variablePresentation` describes ordinary
OpenTofu variables; `installExperience` maps selected variables to generic UX
concepts; `interfaceBlueprints`, `lifecycleActions`, `sourceBuild`,
`outputAllowlist`, and policy remain their own top-level fields. These fields
are administered through the InstallConfig API and are physically separate
from `store`. They can be created freely for a Workspace/operator without
changing the Git repository or inventing a Takosumi repository manifest.

`lifecycleActions` is a narrow service-side provider-gap/application-init bridge,
not another deployment model. The selected actions are pinned with the reviewed
Plan. If `post_apply` actions are present, terminal `succeeded` is required
before the Capsule becomes `active` or its Interface blueprints can become
Ready. Missing execution support, `pending`, `skipped`, `failed`, and exceptions
all fail closed: the successful provider mutation, StateVersion, Output, and
usage/billing evidence are retained, while the Run is failed, the Capsule
is `error`, and the Plan is marked applied so it cannot be replayed. Recovery is
a fresh reviewed plan/apply. If `pre_destroy` actions are present, all must
terminal-succeed before provider destroy starts. Takosumi core records only the
generic action phase/result; it does not add an app-specific receipt or infer an
action from Output data.

```json
{
  "variablePresentation": [
    {
      "name": "worker_name",
      "type": "string",
      "format": "subdomain",
      "required": true,
      "label": { "ja": "公開名", "en": "Public name" }
    }
  ],
  "installExperience": {
    "projections": [
      { "kind": "service_name", "variable": "project_name" },
      {
        "kind": "public_endpoint",
        "variables": {
          "subdomain": "worker_name",
          "url": "app_url",
          "routePattern": "cloudflare_route_pattern"
        },
        "baseDomain": "app.takos.jp"
      },
      {
        "kind": "oidc_client",
        "variables": {
          "issuerUrl": "takosumi_accounts_issuer_url",
          "clientId": "takosumi_accounts_client_id"
        },
        "callbackPath": "/api/auth/callback/takos",
        "scopes": ["openid", "profile", "email"]
      },
      {
        "kind": "artifact",
        "variables": {
          "url": "worker_bundle_url",
          "sha256": "worker_bundle_sha256"
        }
      }
    ]
  }
}
```

`type`, `format`, `required`, `advanced`, and `secret` describe presentation
and validation only. Submitted values remain ordinary OpenTofu variables:

```text
type:
  string / number / boolean / json

format:
  text / url / hostname / subdomain / password / token / email / sha256
```

Unknown Git modules remain valid plain OpenTofu Capsules and use the generic
variable editor. Takosumi must not infer semantics from names such as
`worker_name`, `app_url`, or `client_id`; a DB-owned projection must map them
explicitly. An `oidc_client` projection must also declare its application
callback path. Takosumi does not invent reserved issuer/client variable names
or a Takos-specific callback route when mappings are omitted.

`public_endpoint` is a UX projection, not a hard-coded app rule. If it maps a
`subdomain` variable, Takosumi may reserve
`<workspace-handle>-<label>.<managed-base-domain>` as the broadly available
scoped default. An explicit `managedPublicHostname.mode = "vanity"` keeps the
requested `<label>.<managed-base-domain>` unchanged and consumes one hostname
slot from the immutable Workspace owner account. Both forms are
first-come-first-served and conflict errors must not disclose the owning
Workspace or Capsule. The reservation and vanity slot belong to the Capsule
lifetime and are released only after a successful Capsule destroy, not when an
individual runtime route is deleted. Reservations created before owner-slot
enforcement are grandfathered as `scoped`; only an explicit post-migration
`mode = "vanity"` claim consumes the new quota. This prevents retired
custom-domain reservation rows from consuming vanity slots. If it maps a `url` or
route-pattern variable that points outside the managed base domain, it is a
custom/user-owned hostname and must go through domain ownership verification
before runtime activation in managed target implementations. Generic
ProviderConnection / non-managed providers may still receive these values as
ordinary OpenTofu variables; Takosumi should not reject the module merely
because it chooses to use its own provider-side routing.
Takosumi Cloud does not yet implement that verification or certificate
lifecycle. User-owned custom domains are therefore Planned, and non-empty
custom-domain requests against Cloud-managed routes must fail closed before
routing or activation state is written.

Subdomain, password, and app-specific env are not universal Takosumi
requirements. A Capsule that does not need a public endpoint should not show a
public endpoint field; a Capsule that does not need a first-run secret should
not show a password/token field. Only its selected DB-owned InstallConfig maps
those concepts onto ordinary module variables.
Artifact URLs, SHA-256 digests, container image maps, and app-specific env
knobs are also ordinary OpenTofu variables. `variablePresentation` may place
them in an advanced section, but Takosumi must not turn them into a hidden side
channel or special non-OpenTofu deploy mechanism.

The dashboard must not maintain hard-coded "system" or "advanced" variable-name
lists for install inputs. If an input should be hidden behind details, marked as
secret, or surfaced as a common setup field, that presentation comes from
the selected InstallConfig's `variablePresentation` and `installExperience`;
the submitted value is still just a normal OpenTofu variable. Replacing or
editing a Store listing can never mutate these fields. Historical DB rows that
nested them under `store` may be lifted at read time for migration, but every
new write and every public projection uses the top-level shape.

The preferred fast path is a Git CI or release pipeline that publishes a
versioned, publicly fetchable artifact plus a SHA-256 digest. The OpenTofu
module consumes that URL and digest as normal input variables and verifies the
digest during plan/apply. Takosumi may store or pass those values as Capsule
configuration, but it does not rewrite or select application artifacts outside
the declared OpenTofu module.

The alternative is explicit `sourceBuild`, not an implicit fallback. It is
service-side Capsule configuration, never Store-owned or auto-executed from
`.well-known/tcs.json`. Each command is an argv array, each working directory and
expected output must remain inside the checkout after symlink resolution, and
the build phase receives no provider credential. The same recipe is replayed
before plan/apply/destroy so a stateless runner can reconstruct the reviewed
module tree. Dependency lockfiles and deterministic builds are therefore
required. Operators may disable this lane or set runner resource/network limits.

Hosted/operator installs should prefer CI-produced artifacts, especially for
OCI images and other expensive builds. Source build exists for ordinary
JavaScript/static/native preparation and self-host use; it is not a hidden
container-build service and does not replace app-owned release automation.

App-owned post-apply hooks are allowed only as a narrow compatibility bridge for
provider gaps or app initialization that is not a cloud resource itself, such as
database migrations. They are not the primary deploy model and should shrink as
the app's OpenTofu module and the underlying providers gain coverage.

Generic env remains a required escape hatch. Any OpenTofu provider can be used
when the user declares the provider source, allowed provider policy, egress
policy, and explicit env/file materialization.

### 2.2 Shared Interface Layer

`Interface` is the shared runtime declaration for infrastructure created by
either authoring flow or for an externally managed endpoint registered directly
in Takosumi. It is owned by a Workspace, Capsule, or Resource and describes how
a consumer can use the resulting runtime. `Interface` does not create resources,
select providers, run templates, or replace OpenTofu.

```text
OpenTofu Stack or Resource Shape
  -> ordinary public output
  -> service-side Interface input mapping
  -> resolved Interface revision
  -> InterfaceBinding authorization
  -> Takos, agent, or another runtime consumer
```

The public object has this stable envelope:

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "Interface",
  "metadata": {
    "id": "if_123",
    "workspaceId": "ws_123",
    "name": "primary-mcp",
    "ownerRef": { "kind": "Capsule", "id": "cap_123" },
    "generation": 3,
    "labels": {}
  },
  "spec": {
    "type": "mcp.server",
    "version": "2025-11-25",
    "document": {
      "transport": "streamable-http",
      "display": { "title": "Office MCP" }
    },
    "inputs": {
      "endpoint": {
        "source": "capsule_output",
        "capsuleId": "cap_123",
        "outputName": "mcp_url"
      }
    },
    "access": {
      "visibility": "workspace",
      "resourceUriInput": "endpoint"
    }
  },
  "status": {
    "phase": "Resolved",
    "observedGeneration": 3,
    "resolvedRevision": 7,
    "resolvedInputs": {
      "endpoint": "https://office.example.com/mcp"
    },
    "provenance": {
      "endpoint": {
        "runId": "run_123",
        "stateVersionId": "sv_123",
        "outputId": "out_123",
        "outputDigest": "sha256:..."
      }
    },
    "conditions": []
  }
}
```

Core owns only the stable envelope:

```text
identity / Workspace / owner / generation
namespaced type and version
arbitrary non-secret JSON document
named input references
visibility / Policy / authorization resource URI
resolved revision / provenance / conditions
```

The `document` is stored without type-specific interpretation. Unknown
type/version pairs can be stored, resolved, and read; only a consumer claiming
support for that pair validates its content. Takosumi Core therefore does not
gain a new schema whenever MCP, a file handler, or another runtime protocol
evolves. Arbitrary JSON does not mean arbitrary execution: Interface resolution
does not run code, templates, expressions, shell commands, or HTTP requests.
For `mcp.server`, the document describes transport/discovery metadata only.
Takos performs MCP `initialize` and `tools/list` at connection time; persisted
tool lists are never runtime authority.

Named `inputs` support exactly these sources in v1alpha1:

```text
literal:
  an explicitly configured non-secret JSON value

capsule_output:
  an ordinary public root Output captured for a Capsule, selected by
  capsuleId + outputName + optional RFC 6901 JSON Pointer

resource_output:
  a public output from a Resource Ready at its current generation, selected by
  resourceId + outputName + optional RFC 6901 JSON Pointer
```

References are Workspace-local. One resolution pass pins each referenced
Capsule StateVersion or Resource generation before reading any of its inputs,
so inputs from the same owner cannot mix revisions. Core returns
`document + resolvedInputs`; it does not interpolate values into `document`.
JSONPath, transforms, fallback expressions, string templates, and automatic
Output-name inference are outside the contract.

Resolution is event-driven and fail closed:

```text
successful apply or refresh:
  resolve affected Interfaces and publish a new resolved revision atomically

plan with unknown values:
  keep the current resolved revision and report pending observation

missing / null / sensitive / invalid pointer / unavailable source generation:
  mark NotReady and do not expose the previous value as current

apply failure after possible partial provider changes:
  mark Unknown and stop runtime credential issuance until refresh/recovery

drift observation without a successful refresh/apply:
  add Drifted condition and keep the pinned revision; do not switch endpoints

owner destroy starts:
  mark Terminating and stop new credential issuance

owner destroy succeeds:
  mark Retired and revoke its InterfaceBindings
```

The shipped Capsule lifecycle observer covers successful apply, uncertain
apply/restore failure fencing, destroy start/success, queued-plan observation,
and drift-check completion. A queued plan adds `ObservationPending` without
changing the pinned resolved revision or revoking an existing Ready Binding.
Terminal plan observation removes only its matching pending condition; a
successful drift check adds or clears `Drifted` while retaining the pinned
revision. None of these transitions are inferred from Output or variable names.

Runtime authorization does not rely on the observer alone. It derives the
Capsule's current safety from the durable Run ledger before exposing an
Interface or accepting its Binding: uncertain apply/restore failures become
`Unknown`, an in-flight destroy becomes `Terminating`, and a successful destroy
becomes `Retired`. A normal Source update may mark a Capsule `stale`; that does
not invalidate the last successfully pinned Interface revision. Runtime
discovery hydrates only the requested Workspace and idempotently repairs a
missed blueprint materialization. The same Workspace-scoped boundary rebuilds
Resource Interface lifecycle from the durable Resource ledger, so a failed
best-effort observer cannot leave missed Ready, Unknown, Terminating, or Retired
state indefinitely. Neither repair path performs an all-tenant cold-start scan.

An Interface change does not schedule a Workspace-wide OpenTofu reconcile.
Only an explicit Output-to-input Dependency marks a downstream Capsule stale.
The Interface id remains stable while `generation` tracks desired changes and
`resolvedRevision` tracks observed input changes.

Public routes are:

```http
GET /v1/interfaces
POST /v1/interfaces
GET /v1/interfaces/:id
PATCH /v1/interfaces/:id
DELETE /v1/interfaces/:id
GET /v1/interfaces/:id/bindings
POST /v1/interfaces/:id/bindings
GET /v1/interfaces/:id/bindings/:bindingId
DELETE /v1/interfaces/:id/bindings/:bindingId
POST /v1/interfaces/:id/token
```

The Interface spec is Takosumi service-side DB configuration. Dashboard,
Takos, or Store UX may propose a spec, but after acceptance the Takosumi record
is authoritative and independent of the Store node. v1alpha1 does not require
a `takosumi_interface` OpenTofu resource, Takosumi provider, repository
manifest, well-known Output name, or Output convention.

`visibility` is discovery policy, not authorization: runtime use still requires
an exact `InterfaceBinding`. `policyRef` is an optional host extension point.
When no policy evaluator is injected, an Interface carrying `policyRef` stays
`NotReady` with `UnsupportedPolicy`; Core never treats an unknown policy as
allowing access.

An InstallConfig may carry service-side `interfaceBlueprints`. Takosumi
materializes each blueprint once, after the Capsule's first successful apply,
and substitutes that Capsule id into explicit `capsule_output` inputs. The
accepted Interface then has its own lifecycle: later catalog/config edits never
silently rewrite it. A blueprint is operator DB configuration, not repository
metadata or a second app manifest. Every blueprint has an explicit immutable
`key` used only for one-shot materialization identity; its editable Interface
`name` is never an implicit key or compatibility fallback.

`InterfaceBinding` is the separate runtime authorization object. Its subject
may be a Principal, ServiceAccount, Capsule, or Resource:

```json
{
  "kind": "InterfaceBinding",
  "metadata": { "id": "ifb_123", "workspaceId": "ws_123" },
  "spec": {
    "interfaceId": "if_123",
    "subjectRef": { "kind": "Principal", "id": "acct_pairwise_subject" },
    "permissions": ["mcp.invoke"],
    "delivery": { "type": "none" }
  },
  "status": {
    "phase": "Ready",
    "observedInterfaceRevision": 7,
    "conditions": []
  }
}
```

Permission and delivery tokens are extensible, but an unsupported delivery
type never becomes `Ready`. An exact Principal binding can use a
credentialless upstream (`delivery.type = none`). It can also use
`delivery.type = oauth2`, but that Binding becomes `Ready` only when the host
injects an Interface credential issuer and the Interface resolves the public
resource URI named by `spec.access.resourceUriInput`. That URI must be a
credential-free absolute HTTPS URI, and an ownership authorizer
must prove that the Interface owner controls its hostname. A literal or Output
URL alone is never ownership proof or OAuth audience authority. `oauth2` does
not accept `credentialRef` or delivery options in this shipped slice.

The default OSS composition proves ownership only for a Capsule-owned resource
whose hostname has an active reservation for that exact Workspace and Capsule.
An operator may inject a stricter or external-resource authorizer, but omitting
proof always leaves the Binding NotReady; arbitrary URLs never inherit trust.

For `oauth2`, an authenticated runtime Principal requests exactly one
permission from `POST /v1/interfaces/:id/token`. Immediately before issuance,
Core reconciles the Interface and rechecks the Workspace, Principal subject,
Ready Binding, permission, current Interface revision, owner lifecycle, and
resolved resource URI, including fresh host ownership authorization. The
authorized resource URI is the OAuth audience. Core then calls the host issuer
and accepts only a Bearer credential whose lifetime is at most 60 seconds; the
response is non-cacheable and has no refresh token. Core records only non-secret
issuance evidence and never persists the returned raw token.

The shipped Accounts-backed host composition issues opaque `taksrv_` access
tokens and durably stores only the token hash and the exact Workspace,
Interface, Binding, resolved-revision, audience, scope, subject, and expiry
evidence. Its `/oauth/userinfo` and authenticated `/oauth/introspect`
responses identify this credential with `token_use = interface_oauth` and
return `aud`, `scope`, plus
`takosumi.workspace_id`, `takosumi.interface_id`,
`takosumi.interface_binding_id`, and
`takosumi.interface_resolved_revision`; a Capsule-owned Interface also carries
`takosumi.capsule_id`. A Capsule verifies the required values against the
current request resource and permission before accepting the Bearer. Takos uses
its Accounts delegated token only to authenticate the token request; it never
forwards that delegated token to the Capsule, and it keeps the issued
credential only in call-local memory for catalog discovery or one invocation.

Introspection always authenticates a registered client. Interface OAuth
introspection additionally requires the caller to send the exact resource URI,
and an invocation route accepts the result only when `aud`, the single
permission scope, Workspace, Interface, Binding, and resolved revision all
match. Ordinary OAuth and personal access credentials use explicit
`token_use = oauth_access` and `token_use = personal_access` claims. Token
prefixes remain an opaque generation format and never select an authorization
path or principal kind.

`delivery.type = workload_token` remains `NotReady` in v1alpha1 even when the
Principal OAuth issuer is configured. A future workload implementation must
use ServiceAccount identity and short-lived, audience-bound tokens carrying
`iss`, `sub`, `aud`, `scope`, `iat`, `exp`, `jti`, and Binding/Interface
revision. Secret-backed delivery likewise remains `NotReady` until a host
materializer implements it. Static external credentials, when unavoidable,
are referenced through Secret and materialized only for the authorized
invocation.

`delivery.credentialRef` is syntactically a `secret/...` or `credential/...`
identifier, never an inline value. Enabling a credential-bearing delivery also
requires the host materializer to resolve that identifier inside the same
Workspace before it may become Ready.

Interface documents, literals, and resolved inputs never contain bearer tokens,
passwords, signing keys, or Secret values. This layer never writes runtime
credentials into OpenTofu Output/state, Runs, logs, or audit records; a normal
module's provider-managed sensitive state remains governed by encrypted state
storage and is never eligible for Interface resolution. ProviderConnection
remains provider Run authentication and is not reused as runtime Interface
authorization.

Resource Shape `interfaces` remain resolver capability tokens, not Interface
objects. Resource `connections` remain adapter-owned infrastructure binding
requests. Capsule Dependency remains Output-to-OpenTofu-input wiring.
InterfaceBinding alone represents runtime consumer authorization.

Migration from the retired Output convention is a one-time operation, not a
compatibility mode:

```text
known first-party Capsule:
  create explicit Interface input mappings from the existing public endpoint
  outputs, then remove service_exports / service_bindings / app_deployment

token / bearer / signing-key output:
  do not import the value; rotate it and move access to an oauth2
  InterfaceBinding or explicit Secret materialization

unknown third-party convention:
  ask the Workspace owner to select the Output name and Interface type/version;
  never guess from a well-known name
```

The importer is idempotent and records migration evidence. During rollout,
Takosumi may shadow-compare legacy discovery with the resolved Interface, but
the legacy record is never fallback authority. After consumers read only the
Interface API, remove the Output Sync capability, projection/grant code, old
schemas/routes, and legacy documentation.

### 2.3 Resource Shape Flow

Users can also declare provider-neutral Takosumi shapes when they want
Takosumi-managed service semantics.

```text
Resource Shape
  -> TargetPool / Policy / Credential
  -> Adapter capability evidence
  -> Resolver
  -> ResolutionLock
  -> NativeResource
```

The shape names the service form. The operator decides which targets and
adapters can satisfy it.

Resource materialization uses the same OpenTofu runner and `Run` ledger as a
plain Stack, but the Run subject is the Resource itself. A module-backed Adapter
lowers the resolved descriptor to a generated root plus an operator-owned child
module and dispatches it with a Resource state scope. It does not synthesize a
Capsule, InstallConfig, Git Source, Capsule StateVersion, or Capsule Output.
The Resource record owns its observed generation, public outputs, and latest
successful Run/encrypted-state pointer; `ResolutionLock` owns the pinned Target
and implementation evidence. This keeps execution/audit generic while keeping
the two ownership models explicit.

The v1alpha1 default public shapes are:

```text
EdgeWorker
ObjectBucket
KVStore
Queue
SQLDatabase
ContainerService
```

### 2.4 Deploy API And Optional OpenTofu Provider

`/v1/resources` is the Deploy API for provider-neutral service forms. It is the
only lifecycle authority for a managed Resource. All clients use the same
preview/apply/observe/refresh/import/delete behavior, and the canonical
`Resource`, `ResolutionLock`, `NativeResource`, Run, status, Output, and audit
evidence live behind this API. The retired `Deployment` ledger is not restored.

`takosumi/takosumi` is an optional typed HCL client of the Deploy API. All
`takosumi_*` resources are Takosumi-owned Resource Shape or operator/admin
objects. They are not wrappers around AWS, Cloudflare, Kubernetes, S3, OpenAI,
or any other vendor provider, and the provider does not define service
availability, select a backend, own lifecycle state, or price an operation.

```text
Deploy API:
  provider-neutral desired Resource state
  preview and apply lifecycle authority
  status / events / observe / refresh / import / delete
  ResolutionLock and NativeResource evidence
  adapter/backend-manager dispatch after resolution

takosumi/takosumi provider (optional client):
  typed HCL schema for Takosumi-owned Resource Shapes
  Deploy API client
  capability discovery
  preview/apply/status polling
  minimal OpenTofu state mapping

not:
  a generic cloud abstraction provider
  a clone of existing OpenTofu providers
  a place to call vendor APIs directly
  a catch-all takosumi_resource { type, spec } provider
```

When this document says a shape is provider-neutral, it means
vendor-independent as a Takosumi-owned service contract. It does not mean the
`takosumi` provider is a generic third-party provider directory. Ordinary
provider resources remain in the plain Stack flow. Industry-standard surfaces
such as S3-compatible APIs, OCI registry APIs, Kubernetes CRDs, CloudEvents, or
OpenAI-compatible endpoints stay the external protocol when they fit. When the
service is Takosumi-managed, those surfaces translate into or resolve a
provider-neutral Resource Shape rather than replacing its lifecycle.

There are two extension layers:

```text
HCL shape layer:
  new takosumi_* resource types require a schema/API/provider release.
  This preserves OpenTofu plan diffs, validation, import, state upgrades, and
  completion.

implementation layer:
  operators can add targets, implementation tokens, adapter plugins, and
  capability evidence without changing the HCL shape.
  The resolver accepts those operator-defined tokens through TargetPool,
  Policy, Adapter, and ResolutionLock.
```

This means a provider-neutral service form such as `ContainerService` can land
on Kubernetes, Cloudflare Containers, VM fleet, Takosumi Native, or an
operator-defined runtime plugin while the user's HCL stays the same. It does
not mean a live Takosumi endpoint can invent arbitrary new OpenTofu resource
schemas at runtime.

The public Resource API is Takosumi-native but should follow standard API
conventions:

```text
object shape:
  apiVersion / kind / metadata / spec / status

operations:
  preview before apply
  idempotent create/update by stable name
  explicit delete
  observe/refresh for drift
  import when adopting existing resources

tooling:
  discovery through /.well-known/takosumi and /v1/capabilities
  capability-based behavior, not edition branching
  schema-backed validation
  cursor pagination for lists
  structured error codes
  no secret material in specs, status, logs, or OpenTofu state
```

Compatibility APIs use real standards where they are intentionally exposed:
S3-compatible APIs for object storage data-plane, OCI registry APIs for
artifacts/images, CloudEvents for event ingress, Kubernetes CRDs for
Kubernetes northbound integration, OpenAI-compatible endpoints for AI gateway
access, and a scoped Cloudflare Workers-compatible subset for Worker import /
deploy. A control-plane compatibility handler translates the request into a
typed Resource request and calls the Deploy API. It never writes lifecycle
state, selects a manager, or maintains a compatibility-owned registry. A
data-plane handler resolves a Ready canonical Resource plus authorized
Interface/NativeResource evidence. Unsupported operations fail closed; the
profile is not a promise of full vendor API compatibility.

Future shapes are added only when they have a real schema, planner, adapter
path, and user value. Do not expose `takosumi_resource { type, spec }` as the
normal interface.

## 3. Product Split

### 3.1 Takosumi OSS

Takosumi OSS includes:

```text
Git integration
OpenTofu runner
state / output / run / audit management
Interface / InterfaceBinding API and resolution
ProviderConnection
CredentialRecipe
ProviderBinding
generic env provider support
Resource Shape API
Resolver / Planner / Reconciler
Target / TargetPool
Credential / OIDC / Workload Identity
Secret / Policy / RBAC basics
Adapter framework
Compatibility API framework
usage event emission
Takosumi Resource API clients such as provider / CLI / dashboard
scoped compatibility API surfaces
```

Takosumi OSS does not include:

```text
commercial billing enforcement
payment provider integration
subscription / invoice
official managed capacity
official Takosumi native runtime internals
official support / SLA / abuse operation
```

### 3.2 Takosumi for Operator

Takosumi for Operator is the edition for people who operate Takosumi for their
own users, customers, organization, school, hosting service, or internal
platform.

It adds:

```text
customer / tenant management
multi-tenant workspace management
billing account / subscription / plan
quota / metering / invoice / payment integration
DB-backed operator configuration
CLI / API / runbook operations
managed target offerings
support and abuse tooling
commercial audit export
```

It still uses the same Takosumi engine, Resource API, provider, adapters, and
capability discovery.

### 3.3 Takosumi Cloud

Takosumi Cloud is the official hosted Takosumi for Operator.

It adds official operation:

```text
official account system
official runner and target pools
official versioned pricing, billing, and invoicing
official usage metering
official support / SLA / abuse controls
Takosumi Native Runtime
Takosumi Native Object Storage
Takosumi Native KV / Queue / DB
Takosumi Edge Gateway
Takosumi AI Gateway
```

Takosumi Cloud product identity:

```text
Managed application and data resources on official targets, with explicit USD
prices, usage metering, invoices, and OpenTofu deploys.
```

Cloudflare-compatible APIs are import/deploy paths, not the product identity.

## 4. Resource Shapes

### 4.1 EdgeWorker

`EdgeWorker` is the provider-neutral service form for Worker-compatible
JavaScript/TypeScript edge applications.

It is not a generic container service and it is not a generic HTTP service. A
container is a different service form. A VM is a different service form.

```hcl
resource "takosumi_edge_worker" "api" {
  name               = "api"
  artifact_url       = "https://example.com/releases/api-worker.js"
  artifact_sha256    = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
  compatibility_date = "2026-06-29"

  profiles = [
    "workers_bindings",
    "node_compat",
  ]
}
```

`profiles` are examples of endpoint-defined capability/profile tokens. The
OpenTofu provider must not freeze this list in the provider binary; support is
advertised and enforced by the Takosumi endpoint through capabilities,
TargetPool policy, adapter evidence, and the Resolver.

The same rule applies to Resource Shape `interfaces` such as ObjectBucket
interface requirements. These lower-case capability tokens are not runtime
`Interface` objects. Takosumi owns the typed service form (`ObjectBucket`,
`EdgeWorker`, `Queue`, etc.); the concrete interface/profile tokens are
capability evidence that an endpoint or operator can extend.

Important rules:

```text
Takosumi does not build the JavaScript bundle by default.
The Git/OpenTofu module decides where the artifact comes from.
An explicit sourceBuild recipe may prepare the pinned Git checkout before tofu.
sourceBuild is argv-only, credential-free, output-checked, and policy-controlled.
When the provider is executed outside the Takosumi runner, use artifact_url +
artifact_sha256 so the generated OpenTofu module fetches and verifies the
declared CI/release artifact.
Public runtime routes are canonical `http.route` Interfaces with exact
InterfaceBindings. A future custom-domain/certificate lifecycle may introduce
a separate typed Resource only after that service form passes the prior-art
gate.
Bindings/connections are separate contracts.
Secrets are Credential/Secret material, not spec fields.
```

Possible implementations:

```text
cloudflare_workers
takosumi_edge_runtime
operator-provided EdgeWorker adapter plugin
```

Takosumi Cloud may implement `EdgeWorker` with Cloudflare Workers for Platforms
and a Takosumi-managed dispatch layer. That is an implementation detail for one
shape. Object storage, KV, database, queue, container, workflow, and AI surfaces
are peer Cloud-provided services in Takosumi Cloud. AI Gateway remains a service
endpoint rather than a Resource Shape, but billable AI requests still enter the
same Cloud managed-operation boundary before upstream model execution.

Managed provider-compatible paths use the same TargetPool / Adapter decision as
Resource Shapes. A managed Target can either declare a complete module-backed
descriptor (`providerSource`, `providerConfig`, `moduleTemplate`, explicit
input/output mappings), or select an operator-installed adapter plugin for
direct materialization. Core never derives these fields from Target or shape
names. For example, the provider configuration may explicitly contain:

```json
{
  "base_url": "https://app.takosumi.com/compat/cloudflare/client/v4"
}
```

The OpenTofu adapter renders the explicit provider arguments without renaming or
augmenting them. URL values require the operator allowlist. For managed targets,
credentials are delivered as provider-native runner env rather than
generated-root secret variables. In Takosumi Cloud this means the Cloudflare
provider can receive a Workspace-bound Takosumi personal access token or service
token through the normal `CLOUDFLARE_API_TOKEN` env name while the provider block
only contains the managed `base_url`.

Managed hostname ownership has exactly one authority: the OSS control-plane
hostname reservation store. The Stable Cloudflare routes subset does not claim
a hostname: it can only project an existing profile-owned EdgeWorker's canonical
Cloud system `url` output into a Resource-owned `http.route` / `v1alpha1`
Interface plus an exact Principal `edge.request` Binding. Any runtime routing
projection is a recoverable cache of that canonical state, not a compatibility
lifecycle ledger. Route DELETE revokes the Binding and retires the Interface;
it never releases a hostname. Arbitrary custom domains remain unsupported until
the separate ownership/certificate lifecycle exists.

From the user's perspective the service is an `EdgeWorker`, selected through
the dashboard, CLI, direct Deploy API, a supported compatibility client, or the
optional `takosumi_edge_worker` HCL resource. No OpenTofu provider is required.
Behind the Deploy API, the selected Target/Adapter decides whether the
implementation is Workers for Platforms, Takosumi native runtime, or an
operator-provided plugin. Do not hard-code WfP into a client or Resource Shape.

For Takosumi Cloud official managed targets, typed Resources use an installed
adapter/backend manager behind the Deploy API instead of nesting an OpenTofu
destroy/apply per resource. A manager consumes only the resolved operation; it
does not parse an OpenTofu provider request or invoke a compatibility handler.
The Cloudflare compatibility handler must call the Deploy API, never the other
way around. Workers for Platforms, Object Storage, KV, SQL, Queue, and other
substrates remain replaceable manager implementations behind provider-neutral
service forms.

All Cloud-managed service entrypoints share the Cloud extension boundary before
any backend API call:

```text
OpenTofu provider / control-plane Compatibility API / Dashboard / CLI
  -> auth + source Workspace + owner billing account
  -> provider-neutral Resource desired state
  -> Deploy API preview
  -> ResourceShape + ServiceOffering resolution
  -> versioned PriceCatalog + DeploymentQuote
  -> apply with quote id + quote digest
  -> billing reservation
  -> TargetPool / Policy / ResolutionLock (advanced/operator machinery)
  -> adapter / selected backend manager
  -> backend API
  -> capture reservation on success | release on failure
  -> usage rating + invoice reconciliation
```

The versioned `ServiceOffering` catalog is the Cloud source of truth for which
Resource Shapes, regions, implementation versions, managers, and SKUs can be
sold. The versioned `PriceCatalog` is the source of truth for fixed, minimum,
and usage prices. A service form with no active offering, a billable SKU with no
price, an unconfigured manager, or an expired/mismatched quote fails before a
billing reservation and before any backend API call. A free SKU is an explicit
rated-zero price, not a missing price. The request is never silently routed
through a compatibility handler or another manager.
In Takosumi Cloud's official deployment, `EdgeWorker` selects the Cloudflare
Workers for Platforms dispatch-namespace manager. Other Cloud-provided service
forms use the same Deploy API and billing boundary, but they do not become WfP
Workers: ObjectBucket selects the object-storage manager, SQLDatabase selects
the database manager, KVStore selects the KV manager, Queue selects the queue
manager, DurableWorkflow selects the workflow manager, AI Gateway selects the
AI gateway profile router, and future/native service forms select the
operator-installed manager for that service form.

`/compat/cloudflare/client/v4` is therefore only a protocol adapter. Its
supported create/update/delete operations translate to the same EdgeWorker
Resource request and call the Deploy API. Reads project the canonical Resource;
the handler owns no script/resource lifecycle database. Its scoped Workers
routes operations use the capability-limited compatibility route port to
create/read/update/retire the canonical `http.route` Interface and exact
InterfaceBinding; the route id is the Interface id, and no compatibility KV or
backend route call is made. The Stable subset has exactly one active route per
profile-owned EdgeWorker, requires an explicit path, and permits at most one
terminal `*`; multiple/overlapping routes and host-only patterns fail
explicitly rather than inventing match precedence. Standard data-plane facades similarly resolve an
already-Ready Resource before manager access.
AI Gateway does not become a Resource Shape unless Takosumi later offers a
durable provider-neutral AI service form; its request/token metering still uses
the Cloud rating and invoice-reconciliation boundary. The official EdgeWorker
manager can use Workers for Platforms today and be replaced later without
changing the Resource Shape, Deploy API, provider schema, or compatibility
profile.

### 4.2 ObjectBucket And S3-Compatible Object Storage

`ObjectBucket` is the provider-neutral service form for object storage when
Takosumi owns binding projection, policy, metering, managed-target placement,
or compatibility import/data paths.

It does not replace ordinary object-storage providers.

Why it exists:

```text
Takosumi or an operator may provide object storage.
Apps, SDKs, and existing OpenTofu providers need a standard way to consume it.
The correct standard surface is S3-compatible API.
```

Ordinary object storage remains outside Takosumi Resource Shapes:

```text
AWS S3:
  use hashicorp/aws in the plain OpenTofu Stack flow.

Cloudflare R2:
  use cloudflare/cloudflare in the plain OpenTofu Stack flow.

GCS / MinIO / other S3-compatible storage:
  use the existing provider or standard S3-compatible endpoint.
```

Takosumi enables `compat.s3.v1` only when the operator intentionally exposes an
object-storage import/data path, binding projection, policy, metering, or
managed target control. This lets Takosumi-provided storage be received and used
through the same S3-compatible provider/SDK surface. `takosumi_object_bucket`
exists for the control-plane shape; S3-compatible APIs remain the data-plane
surface.

### 4.3 KVStore / Queue / SQLDatabase / ContainerService

These are minimum service forms needed by Takos and yurucommu-style apps.

```hcl
resource "takosumi_kv_store" "cache" {
  name = "cache"
}

resource "takosumi_queue" "delivery" {
  name        = "delivery"
  max_retries = 5
}

resource "takosumi_sql_database" "main" {
  name            = "main"
  engine          = "sqlite"
  migrations_path = "migrations"
}

resource "takosumi_container_service" "agent" {
  name        = "agent"
  image       = "ghcr.io/example/agent:1.0.0"
  public_http = true
}
```

Rules:

```text
KVStore:
  provider-neutral key-value state/binding surface.

Queue:
  async delivery and event fan-out.

SQLDatabase:
  sqlite is the default engine token. Engine, connection-permission, and
  projection tokens are open; any non-default token is executable only when an
  operator Target implementation explicitly advertises the matching capability.

ContainerService:
  OCI container service. It is separate from EdgeWorker.
```

Do not collapse these into a generic `service` or into EdgeWorker. The service
form is the user-facing contract; the backend is selected by TargetPool,
Policy, capability evidence, and ResolutionLock.

Takos itself should be representable as a composition of these generic service
forms, not as a special `takosumi_takos` catch-all resource:

```text
Takos distribution:
  EdgeWorker        -> takos-worker
  SQLDatabase       -> workspace/control database
  KVStore           -> session/cache/state binding
  ObjectBucket      -> files and workspace objects
  Queue             -> agent jobs and product events
  ContainerService  -> takos-agent container
```

The separately installed `takos-git` Capsule has its own generic service
topology and is consumed through Interface/InterfaceBinding; it is not part of
the Takos distribution topology.

Consumer shapes declare non-secret `connections` to the shapes they use. The
connection contract carries only resource references, requested permissions,
and projection kind; credentials and concrete binding materialization stay in
Credential / ProviderConnection / adapter execution.

Immediately before preview/apply, the control plane resolves each reference to
a Resource that exists in the same Space, is Ready at its current generation,
and has a ResolutionLock. The adapter receives only that Resource's kind,
selected Target, NativeResource references, and public outputs. Missing,
cross-Space, or not-Ready references fail before adapter/backend execution.
Deletion is dependency ordered: a referenced Resource cannot be deleted while
a desired consumer still points at it. This preserves the dependency semantics
that ordinary OpenTofu references already express and prevents adapters from
guessing resource names or credentials. Resource API applies also reject any
update that would introduce a cycle into the desired connection graph.

```hcl
resource "takosumi_edge_worker" "takos_worker" {
  name          = "takos-worker"
  artifact_path = "/work/dist/takos-worker.js"

  connections = [{
    name        = "FILES"
    resource    = takosumi_object_bucket.files.id
    permissions = ["read", "write"]
    projection  = "runtime_binding"
  }]
}
```

This keeps Takos on the same provider-neutral shape model as third-party apps.
If a future Takos component needs a service form that is not covered by these
shapes, add that missing service form only after the prior-art gate passes. The
proof command is:

```bash
bun run opentofu:takos-shape-provider-proof
```

### 4.4 AI Gateway Is Not A Resource Shape

AI Gateway remains a Takosumi Cloud / operator service endpoint, not a default
`takosumi_*` resource.

In Takosumi Cloud, billable AI Gateway requests still pass through the common
Cloud managed-operation boundary:

```text
/gateway/ai/v1
  -> auth + source Workspace + owner billing account
  -> CloudManagedOperation(entrypoint = ai_gateway)
  -> CloudManagedDispatchPlan
  -> selected manager configured check
  -> usage / rating / billing guard
  -> AI gateway profile router
  -> upstream model provider
```

Apps should receive AI configuration like any other external service:

```text
TAKOSUMI_AI_BASE_URL
TAKOSUMI_AI_API_KEY
TAKOSUMI_AI_DEFAULT_MODEL
OPENAI_BASE_URL
OPENAI_API_KEY
```

Public endpoint/model values can be resolved through an Interface. API keys
come from InterfaceBinding, Secret, ProviderConnection, or generic env according
to the authentication boundary. They must not be stored in Resource Shape
specs, Interface documents/resolved inputs, or OpenTofu state.

## 5. Future Shape Families

Future shapes are introduced one provider-neutral service form at a time. This
list is a candidate vocabulary, not a commitment to recreate vendor provider
resources. Add a shape when Takosumi/operator actually offers that managed
capacity and therefore must own its lifecycle, bindings, resolution, policy,
metering, import, and drift semantics. A standard API may remain its compat or
data-plane surface; it does not remove the need for a canonical shape when
Takosumi sells and operates the service. External infrastructure that Takosumi
does not operate remains on its mature provider through the Stack flow.

```text
Route
Connection
Secret
RelationalDatabase
DurableWorkflow
Job
Machine
MachinePool
KubernetesCluster
Artifact
ContainerImage
```

Do not add a public shape until it has:

```text
clear user-facing service form
shape-specific HCL schema
validation
planner
adapter path
import/drift/state story
capability story
tests
```

Do not merge unlike service forms. Edge Worker, container service, machine,
workflow, and job are different shapes even if some backend can implement more
than one.

## 6. Target, Adapter, And Plugin Model

Backend selection belongs to TargetPool, Policy, capability evidence, and the
Resolver. It should not normally be embedded in the user resource.

TargetPool, Policy, adapter/plugin configuration, target credentials, and
implementation overrides are operator/advanced surfaces. The default user flow
is service form -> required configuration -> price -> preview -> deploy. A user
does not need to choose a provider or manager to consume an official offering.

Target types are opaque extensible tokens. The following are examples only;
Core attaches no provider or module semantics to them:

```text
aws
cloudflare
gcp
azure
kubernetes
vm
proxmox
libvirt
ssh
takosumi_native
opentofu
operator-defined target type
```

TargetPool implementation entries can point to adapter plugins.

```hcl
resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name     = "containers-main"
    type     = "kubernetes"
    ref      = "cluster-prod"
    credential_ref = "conn_k8s_prod"
    priority = 80

    implementation = [{
      shape          = "ContainerService"
      implementation = "custom_container_runtime"
      plugin         = "takosumi-plugin-container-runtime"

      options_json = jsonencode({
        runtime_class = "edge"
      })

      interfaces = {
        oci_container = "native"
        public_http   = "shim"
        "custom.mesh" = "native"
      }
    }]
  }]
}
```

`ref` is a target-native reference such as a Cloudflare account id, Kubernetes
cluster ref, VM fleet id, or operator target handle. `credential_ref` is the
ProviderConnection / Credential id used when the selected adapter needs
provider credentials. These are separate fields.

Plugin options are non-secret configuration. Secrets and tokens stay in
Credential or ProviderConnection.

The adapter plugin shape is intentionally Vite-like:

```ts
export default {
  name: "takosumi-plugin-example",
  implementations: [
    {
      shape: "ContainerService",
      implementation: "example_container_runtime",
    },
  ],
  async preview(ctx) {},
  async apply(ctx) {},
  async observe(ctx) {},
  async delete(ctx) {},
};
```

Takosumi core defines the contract. Operators decide which plugins are
installed and trusted. The standard platform worker supports a generic
fetch-compatible plugin binding seam; Cloud/Operator deployments map plugin ids
to handler bindings, and OSS core never imports the closed implementation.

## 7. ProviderConnection And CredentialRecipe

ProviderConnection remains the standard credential boundary.

```text
ProviderConnection:
  stored or referenced credential configuration.

CredentialRecipe:
  env/file/pre-run materialization rule for one provider mode.

ProviderBinding:
  mapping from OpenTofu provider address/alias to ProviderConnection.
```

OAuth, AssumeRole, impersonation, AI upstream token vending, and Cloudflare
login helpers are setup or pre-run flows. They are not public ownership kinds.

An open declared-env capability is required:

```text
CredentialRecipe.declaredEnv = true
  arbitrary OpenTofu provider source
  explicit env/file names
  runner policy
  provider plugin policy
  egress policy
```

The recipe id is opaque and operator-selected; Core assigns no behavior to a
reserved `generic-env` id. This is how Takosumi stays open to providers it does
not know yet. Core owns the generic `declaredEnv` structural validation, and a
host can map the reusable declared-env runtime driver to any opaque
recipe/auth-mode key.

Credential Recipes and their runtime drivers are service-installed
contributions. Core has no bundled-catalog fallback: an omitted catalog is an
empty catalog, an omitted driver registry has no drivers, and an unknown recipe
fails closed. The shipped Worker and Bun/Postgres reference compositions may
explicitly install the reference provider package, including generic env, but
another operator may replace that complete catalog and driver registry without
changing Core. Recipe presence controls only whether that credential
materialization mode is installed; it never admits or rejects execution of the
provider source itself.

Static env/file modes do not need provider-specific runtime code: Core verifies
their registration-pinned material structurally and mints it unchanged. A
`preRun` mode is published only when the selected host composition installs a
mint driver for that exact opaque recipe/auth-mode key. Placeholder drivers are
not conformance; an unimplemented generated-credential mode is absent from
discovery and fails closed if an old stored row still references it.

OAuth follows the same composition rule. Core accepts an explicit registry of
opaque helper ids and performs generic state signing, redirect, token exchange,
and callback handling. Vendor descriptor discovery and token-response mapping
belong to the provider package selected by the Worker/Bun host composition; an
unconfigured Core installs no OAuth helpers.

## 8. Compatibility API Framework

Compatibility APIs are framework capabilities in standard Takosumi. They are
scoped, versioned protocol adapters, not lifecycle authorities and not a
promise of complete cloud API compatibility. Whether a specific compatibility
profile is enabled is reported through capabilities.

Examples:

```text
compat.oci.v1
compat.cloudevents.v1
compat.kubernetes.crd.v1
compat.cloudflare.workers.v1
compat.s3.v1
compat.redis.v1
compat.postgres.v1
```

These names are possible capability tokens, not a roadmap to rebuild standard
APIs. Redis, Postgres, SQS, S3, and OCI should stay on existing providers or
standard endpoints unless an operator-owned import path, binding projection,
policy, or metering gap is proven.

The key rule still applies:

```text
If the existing standard/provider is enough, use it.
If Takosumi needs an import path, binding projection, policy, metering, or
managed target control, expose a scoped compatibility profile around the
canonical Resource lifecycle.
```

Examples:

```text
Cloudflare Workers subset:
  translate supported script control operations into EdgeWorker Deploy API
  calls, and scoped system-hostname route operations into canonical
  http.route Interface / InterfaceBinding operations.

S3 API:
  resolve a Ready ObjectBucket for data-plane calls; supported control-plane
  operations translate into ObjectBucket Deploy API calls. It is not mandatory
  for normal external S3/R2/GCS use.

OCI registry:
  useful when an app or operator exposes ContainerImage / Artifact flows
  through an explicit Git CI or release pipeline. Takosumi may reference and
  validate those artifacts, but it does not own hidden build semantics.

CloudEvents:
  useful for Queue / EventHandler / DurableWorkflow trigger import.
```

All control-plane profiles obey one state rule:

```text
compat request
  -> validate the advertised compatibility subset
  -> translate to a typed Resource request
  -> call /v1/resources preview/apply/delete
  -> project canonical Resource status back to the compatible response
```

They do not call backend managers directly, create compatibility-owned
resource rows, or become a backend used by a Resource adapter. Data-plane
profiles authorize and resolve an existing Ready Resource; they do not create
one implicitly.

Unsupported claims:

```text
complete AWS API compatibility
complete Cloudflare API compatibility
all Terraform provider compatibility
```

## 9. Resolution Lock And State

Resolver decisions must be locked.

```json
{
  "resourceId": "tkrn:prod:EdgeWorker:api",
  "selectedImplementation": "cloudflare_workers",
  "target": "cloudflare-main",
  "locked": true,
  "reason": [
    "worker_fetch native",
    "workers_bindings native",
    "space policy matched"
  ]
}
```

Takosumi must not silently migrate a resource to another backend. Migration is
an explicit operation.

State is split into:

```text
OpenTofu state
Takosumi resource state
Native resource state
```

The OpenTofu provider state keeps Takosumi ids and outputs. Native provider
identifiers, resolution details, and secret material belong in Takosumi state,
not in user HCL.

## 10. Discovery And Capabilities

Every Takosumi endpoint exposes:

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

Providers and tools branch on capabilities, not edition names.
Adapter/target capabilities report what the operator has enabled; they do not
create implicit Resource Shape mappings. Object storage remains a standard
endpoint/provider concern unless `compat.s3.v1` is explicitly enabled by an
operator for an import/data path, binding projection, policy, metering, or
managed target control.

Example:

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "resources": {
    "Stack": true,
    "EdgeWorker": true,
    "ObjectBucket": true,
    "KVStore": true,
    "Queue": true,
    "SQLDatabase": true,
    "ContainerService": true
  },
  "interfaces": {
    "api": true,
    "bindings": true,
    "inputSources": ["literal", "capsule_output", "resource_output"]
  },
  "adapters": {
    "aws": true,
    "cloudflare": true,
    "kubernetes": true,
    "vm": false,
    "takosumi_native": true
  },
  "compat": {
    "s3": false,
    "oci": true,
    "cloudevents": true,
    "provider_cloudflare_workers": true
  },
  "identity": {
    "oidc_issuer": true,
    "workload_identity": true
  },
  "operator": {
    "multi_tenant_workspaces": true,
    "runner_pools": true,
    "usage_showback": true
  },
  "extensions": ["example.runtime.v1"]
}
```

Commercial customer management, billing, and payment are not fixed OSS
capability fields. A host that installs them advertises explicit versioned
extension tokens such as `billing.commercial.v1` and publishes the matching
endpoint in the extension catalog. This keeps discovery open to capabilities
that the OSS contract does not know in advance and prevents an edition-shaped
`commercial` branch from becoming a second product taxonomy.

An endpoint reports Interface support only when the advertised CRUD,
resolution, lifecycle, and binding behavior is implemented. Interface type and
version tokens remain consumer contracts; generic Interface support does not
claim that every consumer understands every document.

`compat.s3.v1` should stay false unless an operator intentionally exposes an
S3-compatible import/data path. Object storage can remain entirely on existing
providers and standard endpoints.

## 11. Takosumi Cloud Public Offering

Takosumi Cloud should be documented like a simple cloud service.

Public service names:

```text
Apps / Services
Edge Worker
Container
Bindings
Routes
Secrets
KV
Object Storage
Database
Queue
AI Gateway
Durable Workflow
Pricing / Usage / Invoices
Custom Domains (Planned)
*.app.takos.jp names
```

The managed public hostname contract has two one-label forms under an
operator-managed public base domain. Takosumi Cloud's base domain is
`app.takos.jp`. The default scoped form is
`<workspace-handle>-<label>.<managed-base-domain>` and does not consume a
vanity slot. The optional vanity form is `<label>.<managed-base-domain>` and
consumes one finite slot owned by the immutable Workspace owner account. Names
are first-come-first-served.
Arbitrary user-owned custom domains are a separate lifecycle and must
pass ownership verification, certificate provisioning, plan/quota, and abuse
policy before runtime activation. That lifecycle is not implemented today, so
all user-owned custom-domain activation is Planned and non-empty requests fail
closed.
This is a hard product boundary: operator-owned managed hostnames such as
`<workspace-handle>-<label>.app.takos.jp` are the broad default namespace.
Vanity operator-owned names use a finite owner slot, while arbitrary user-owned
hostnames require verified ownership, account attribution, separate plan/quota
controls, and abuse policy before activation.
Managed hostname reservations and vanity slots belong to the Capsule lifetime;
a successful Capsule destroy releases them. Deleting a Cloud routing record
does not release OSS hostname ownership.

Implementation can use Cloudflare primitives such as Workers for Platforms,
Dynamic Workers, R2, D1, KV, Queues, Workflows, Containers, and AI Gateway.
Those are implementation details behind official managed targets.

Docs must publish a compatibility matrix:

```text
Stable:
  EdgeWorker deploy
  one explicit-path route per EdgeWorker canonical Cloud system hostname
  ObjectBucket with S3-compatible data-plane surface
  AI Gateway as an OpenAI-compatible env/endpoint surface

Preview:
  EdgeWorker runtime secrets / vars / service bindings through the Cloudflare
  compatibility profile (ProviderConnection runner injection remains a stable
  generic OpenTofu capability)
  KV
  Queue
  SQLDatabase
  ContainerService
  DurableWorkflow

Planned:
  Database extensions
  custom domains (verified ownership and certificate lifecycle)

Unsupported:
  DNS full management
  WAF
  Zero Trust
  Registrar
  Cloudflare account IAM
  Load Balancer
  Email Routing
```

Current managed hostname support:

```text
Workspace-scoped names under the operator managed public base domain
owner-slot vanity names under the same base domain
```

Planned custom-domain support:

```text
user-owned apex and subdomains
verified ownership
certificate issuance and renewal
plan/quota/abuse policy
```

The OSS hostname reservation authority is the source of truth for managed name
ownership. Operator/Cloud configures the managed base domain, vanity-slot
limits, reserved labels, and abuse policy. Cloud KV / Durable Object state is
only routing / activation state. The separate verified custom-domain and
certificate lifecycle will live in the Operator/Cloud layer when implemented.

## 12. Billing Boundary

Takosumi OSS can emit usage events.

```text
resource id
meter id
quantity
unit
usdMicros
ratingStatus
timestamp
operation
target
```

The canonical amount field is `usdMicros` (1 USD = 1,000,000 micros).
`ratingStatus` distinguishes an explicitly `rated` zero from an `unrated`
measurement. OSS has no price table: without a host-injected `ShowbackRater`,
plan and `runner_minute` measurements are recorded as zero / `unrated` and
never block a Run. A host can install any explicit price policy; Cloud uses its
versioned `PriceCatalog` and persists `rated` evidence. Legacy `credits` are only
a historical storage/client compatibility concern.

Takosumi for Operator and Takosumi Cloud can turn those measurements into:

```text
rating
account balance / explicit credit adjustments
quota
auto recharge
payment enforcement
invoice
support and abuse workflows
```

Takosumi Cloud pricing is explicit and versioned:

```text
ServiceOffering:
  offering id / version
  ResourceShape kind + supported API version
  region / implementation version / manager id
  enabled capabilities and lifecycle actions
  referenced SKU ids

PriceCatalog:
  catalog id / version / currency / effective interval
  SKU id + price version
  fixed charge / minimum charge / usage rate / unit / tiers
  tax classification and invoice description metadata

DeploymentQuote:
  quote id / issued at / expiry / quote digest
  Resource desired-state digest
  resolution fingerprint / ServiceOffering version
  PriceCatalog id / version
  fixed and estimated usage line items
  subtotal / tax treatment / estimated total micros / currency
```

Preview of a billable Cloud Resource returns a `DeploymentQuote`. Apply must
present `quoteId + quoteDigest`; Cloud verifies that the desired-state digest,
resolution fingerprint, offering, prices, currency, and expiry still match.
Apply may not silently re-price or resolve to a different implementation. A
changed request, catalog, or resolution requires a new preview and quote.

Billing reservation state is monotonic and idempotent:

```text
quoted -> reserved -> captured
                   -> released
quoted -> expired
```

Cloud reserves the quoted fixed/minimum amount before backend materialization,
captures it only after the canonical Resource operation succeeds, and releases
it after failure or cancellation. Retries use the same idempotency key and
cannot double reserve or double capture. Usage that is knowable only after the
operation is rated from immutable UsageEvents against the quote's price version.
Unknown offering/SKU/price/currency, an expired quote, or a quote mismatch fails
closed before backend work. Zero-price service is represented by an explicit
`rated` zero line item; missing price never means free.

Invoice reconciliation is a GA requirement, not an accounting afterthought.
For every billing period Cloud must prove:

```text
captured deployment reservations
+ rated immutable UsageEvents
- releases / refunds / credits
= internal billable ledger total
= payment-provider invoice line total (within declared rounding rules)
```

Each invoice line carries account, Workspace/Resource attribution, offering and
SKU versions, quantity/unit, unit price, currency, tax treatment, quote or usage
event ids, billing period, and idempotency key. Reconciliation records unmatched,
duplicate, late, and corrected lines and blocks a period from being marked
closed until differences are resolved or explicitly audited.

Usage attribution keeps the source Workspace / Resource / Capsule for
drill-down, but the commercial payer, payment method, invoice, and optional
prepaid balance are owner-account scoped. A user does not maintain a separate
commercial balance for every Workspace they own.

If funds or quota are exhausted in Takosumi Cloud, Cloud-managed resources stop
or degrade according to the published service policy. That enforcement,
reservation ledger, price catalog, quotes, payment-provider integration, and
invoice reconciliation are not OSS core.

## 13. Non-Goals

Do not build:

```text
complete AWS API compatibility
complete Cloudflare API compatibility
a Takosumi clone of every existing OpenTofu provider
generic takosumi_resource { type, spec } as the primary interface
Takosumi runtime schemas inside reserved OpenTofu Outputs
Workspace-wide reconcile triggered by ordinary Output changes
backend selection as normal user HCL
Cloud-only branches in the takosumi provider
secret material inside Resource Shape specs
secret material inside Interface documents or resolved inputs
commercial billing enforcement inside OSS core
```

Do build:

```text
plain OpenTofu Stack execution
declared-env-capable ProviderConnection escape hatch
shared Interface / InterfaceBinding API for Capsule and Resource runtimes
first-class typed shapes only after the prior-art gate proves generic
providers/standards are not enough
capability-driven provider behavior
TargetPool adapter plugin system
scoped compatibility import paths
clear OSS / Operator / Cloud boundaries
```

## 14. GA Contract

Takosumi software GA and Takosumi Cloud managed-service GA are related but
separately evidenced. OSS GA does not require Cloud billing; Cloud GA does.

Takosumi software GA requires:

```text
plain OpenTofu Stack flow remains conformant
/v1/resources is the only Resource lifecycle authority
provider/CLI/dashboard/compat control requests converge on that API
compat data planes resolve Ready canonical Resources
no adapter or backend manager calls a compat handler as its implementation
provider remains an optional client
TargetPool/Policy/Adapter remain usable but live in operator/advanced UX
Resource/Run/state/output/audit recovery and migration evidence is complete
```

Takosumi Cloud may call a service shape Stable only when it additionally proves:

```text
an active versioned ServiceOffering and PriceCatalog
preview -> DeploymentQuote with immutable request/resolution/price binding
apply -> idempotent reserve -> backend -> capture/release
immutable usage rating against the bound SKU/price version
payment-provider invoice reconciliation and period-close evidence
unsupported offering, missing price, expired quote, and missing manager fail closed
dashboard shows service -> inputs -> price -> preview -> deploy by default
live tenant isolation, abuse/support, observability, backup/restore, and billing evidence
```

EdgeWorker and ObjectBucket are the initial Stable candidates. KVStore, Queue,
SQLDatabase, ContainerService, and DurableWorkflow remain Preview until each one
passes the same lifecycle, price, billing, reconciliation, recovery, and live
evidence contract. GA is not inferred from a self-test or from one green client.

## 15. Immediate Build Order

1. Keep plain OpenTofu Stack execution reliable.
2. Keep arbitrary provider support through declared-env-capable
   ProviderConnections.
3. Add Interface storage/API, generic input resolution, lifecycle, provenance,
   and InterfaceBinding authorization without an Output convention.
4. Move first-party runtime consumers to Interface reads and invocation-time
   Principal OAuth credentials; remove Output Sync and legacy projection paths.
5. Make `/v1/resources` the single Deploy API authority for preview/apply/
   observe/refresh/import/delete; remove compatibility-owned lifecycle state.
6. Finish provider-neutral Resource Shape schemas, planner, resolver, state,
   and ResolutionLock for
   EdgeWorker, ObjectBucket, KVStore, Queue, SQLDatabase, and ContainerService.
7. Keep `takosumi/takosumi` as an optional typed client for those shapes.
8. Put TargetPool/Policy/adapter/backend-manager selection behind Deploy API;
   expose it only in operator/advanced settings.
9. Translate control-plane compatibility profiles into Deploy API calls and
   make data-plane profiles resolve canonical Ready Resources.
10. Add versioned Cloud ServiceOffering / PriceCatalog / DeploymentQuote and
    atomic reserve/capture/release.
11. Reconcile immutable usage/reservations/refunds to payment-provider invoices.
12. Add new shapes one provider-neutral service form at a time, not as a
    catch-all resource or provider clone.
13. Simplify the default UX to service -> configuration -> price -> preview ->
    deploy; keep target, policy, and adapter details in advanced/operator views.
14. Host Takosumi Cloud as the official Takosumi for Operator deployment.

## 16. Final Sentence

Takosumi is an open Git + OpenTofu control plane whose managed-service contract
is a provider-neutral Resource Shape deployed through one `/v1/resources`
lifecycle authority. Existing providers remain the Stack-flow path for external
infrastructure; the optional Takosumi provider, dashboard, CLI, and
control-plane compatibility profiles are clients of the same Deploy API, while
data-plane profiles resolve its canonical Ready Resources. Adapters and backend
managers stay behind resolution, and Takosumi Cloud adds explicit versioned
offerings, prices, quotes, reservations, usage rating, and invoice
reconciliation around that lifecycle. Capsule and Resource runtimes are exposed
through one non-secret Interface/InterfaceBinding layer, while OpenTofu Outputs
remain ordinary module return values.
