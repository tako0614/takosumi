# Model Reference

Last updated: 2026-07-16

Takosumi OSS has two public authoring flows and one shared runtime interaction
layer: run plain OpenTofu from Git, or let the host resolve an exact Service
Form-backed Resource. The current wire/provider/state calls the latter a
Resource Shape and exposes it through `/v1/resources`. Either result is exposed through Interface and
consumers are authorized through InterfaceBinding. Control-plane compatibility
profiles translate into the Deploy API; data-plane profiles resolve Ready
canonical Resources.

Takosumi is the sole Resource / Run / state / audit lifecycle authority. The
portable project owns Service Forms, exact FormRefs, data-only Form Packages,
and typed-client conformance. Takosumi is an optional host that owns the Form
Registry, implementations, Target / Policy / credentials, and generic
FormActivation. Takosumi Core still runs the plain Stack flow with zero Form
Packages installed. Takosumi Cloud exact ServiceOfferings, price, billing, and
official capacity sit outside this OSS host model.

## OpenTofu Stack Concepts

| Concept            | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| Workspace          | User/team isolation boundary for projects, state, secrets, runs, and audit |
| Project            | One product, service, or infrastructure group                              |
| Capsule            | One OpenTofu/Terraform module execution unit                               |
| Source             | Git URL/ref/commit/path for a plain OpenTofu/Terraform module              |
| ProviderConnection | Stored provider credential configuration                                   |
| CredentialRecipe   | Provider-specific env/file/pre-run materialization recipe                  |
| ProviderBinding    | Provider name/alias to ProviderConnection mapping                          |
| Secret             | Encrypted credential or input material                                     |
| Run                | One init/validate/plan/apply/destroy/refresh/output action                 |
| StateVersion       | Stored state generation for a Capsule                                      |
| Output             | Captured OpenTofu output value                                             |
| Runner             | Local/docker/remote/operator/cloud execution worker                        |
| AuditEvent         | Actor/action/target/result evidence                                        |

## Service Form Host Concepts

| Concept        | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| Service Form   | Versioned provider-neutral service definition owned by the portable project |
| FormRef        | Exact apiVersion / kind / definitionVersion / schemaDigest identity         |
| Form Package   | Data-only bundle of schema, metadata, mappings, and fixtures                |
| Form Registry  | Inventory of trusted Form Package pins installed on one host                |
| FormActivation | Generic OSS record exposing an exact FormRef to an audience/policy scope    |
| Space          | Resource API namespace and policy scope                                     |
| Environment    | Deployment environment inside a Space                                       |
| Stack          | A group of Service Form-backed Resource objects and operations              |
| Resource       | Desired service-form resource, such as EdgeWorker, ObjectBucket, or Queue   |
| Target         | Concrete implementation destination, such as AWS, Cloudflare, Kubernetes    |
| TargetPool     | Operator-controlled set of available Targets and capabilities               |
| Credential     | Runtime authority used by a Target or Adapter                               |
| Policy         | Rules for placement, cost, region, action, network, and access              |
| Adapter        | Implementation bridge that can preview, apply, observe, and delete          |
| ResolutionLock | Recorded resolver decision for a Resource                                   |
| NativeResource | Concrete provider/platform resource created by an Adapter                   |
| Condition      | Status and readiness evidence                                               |

`Space` here is the Resource API namespace and policy scope.

## Shared Runtime Interaction Concepts

| Concept          | Meaning                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Interface        | Versioned, non-secret runtime declaration owned by a Workspace, Capsule, or Resource                                   |
| Interface input  | Explicit public value from `literal`, `capsule_output`, or `resource_output`, with optional JSON Pointer               |
| InterfaceBinding | Authorization that grants a Principal, ServiceAccount, Capsule, or Resource specific permissions and a delivery method |
| Principal        | Human/account identity consuming an Interface                                                                          |
| ServiceAccount   | Non-human identity consuming an Interface                                                                              |

OpenTofu Output remains an ordinary root-module return value. An Interface may
explicitly map any eligible public Output name; the module does not publish a
reserved Takosumi schema. Interface documents and resolved inputs never contain
credentials. InterfaceBinding delivery is invocation-time authorization and is
independent from ProviderBinding, which authorizes OpenTofu Runs.

## OpenTofu Provider Resolution

Source and Capsule authoring is Git-only. A SourceSnapshot is produced by
`source_sync` for a registered Source; its immutable archive is runner transport,
not a second source kind or a Capsule creation path.

`Source.autoSync` enables scheduled Git-ref polling. It prepares newer immutable
SourceSnapshots when the ref moves. If the resolved commit differs from the
SourceSnapshot currently applied by an active Capsule, Takosumi marks that
Capsule `stale` so the normal Workspace update / RunGroup path can create a
reviewable update plan. It still does not silently apply changes: every
infrastructure update goes through Plan / Apply as a Run unless an explicit
operator policy adds a separate auto-apply gate.

A manual update uses a SourceSyncRun with `manual_plan` intent and pins the
exact SourceSnapshot produced by that Run into the plan. This sync may mark the
Capsule `stale`, but it does not independently start a competing auto-update
plan/apply.

Provider resolution has two OSS outcomes plus policy blocking:

```text
resolved_provider_connection
blocked_missing_connection
blocked_policy
```

Resolution evidence never includes secret values. Public API, UI, and docs use
ProviderConnection and ProviderBinding.

## Same Manifest, Different Connection

The core deployment model is:

```text
same .tf
different ProviderBinding
different ProviderConnection
```

Example:

```yaml
provider_bindings:
  cloudflare.default:
    connection: cloudflare-prod
  aws.tokyo:
    connection: aws-prod-tokyo
```

Takosumi injects the runtime env/files required by the selected
ProviderConnection. The manifest should not contain secrets.

Operator-installed Credential Recipes are guided setup shortcuts, not the provider
boundary. Any provider can use a generic-env ProviderConnection when the user
declares the provider source from `required_providers` and the explicit
environment variables documented by that provider. Those declared env names
must be upper-snake environment identifiers such as `EXAMPLE_API_TOKEN`; they
become the run-local CredentialRecipe, subject to runner policy, provider plugin
policy, and egress policy. Runner/runtime-reserved env names are rejected.

Using your own key is not gated by Takosumi. There is no provider allowlist and
no operator approval: if you supply the credential, any OpenTofu/Terraform
provider runs. A self-hosted Takosumi enables the wildcard runner surface by
default, and uses its explicitly configured default RunnerProfile unless the
caller selects another operator-defined capability profile. Provider names and
labels never select an executor.
A ProviderConnection you supply with your own key is never metered or billed by
Takosumi software. Self-hosted and OSS operator endpoints may record showback
usage, but Takosumi OSS has no built-in price: measurements remain zero /
`unrated` unless the operator injects a `ShowbackRater`. They do not enforce
Takosumi Cloud payment. Takosumi Cloud bills only
Takosumi-provided managed resources; its customer-facing contract lives in
[Takosumi Cloud pricing](https://app.takosumi.com/docs/en/pricing).

## Runner Policy

Runner policy, provider allowlists, lockfile/mirror rules, resource limits, and
network egress policy are internal control-plane safeguards. They decide where a
Run may execute and which provider plugins/resources may be reached, but they
are not public product nouns like ProviderConnection or ProviderBinding.
RunnerProfile lifecycle and availability are typed fields. Its open
`executorId` resolves only through the host-injected executor registry; labels
are descriptive metadata and cannot enable, reserve, schedule, or route a Run.
Operators may configure a runner-local OpenTofu provider plugin cache to speed
direct provider installs. It stores provider binaries only; credentials and
generated run files remain per-run. On Cloudflare Containers, the current
runner Durable Object id is run-scoped, so this cache is only reused while that
single runner instance is alive; SourceSnapshot reuse and provider mirrors are
the portable speed mechanisms.

The user-facing flow should feel like installing an app, but the model remains
Git-native and OpenTofu-native. Creating a new service uses the same guided
install flow as adding an app: choose a Git-backed listing or enter an install
link, configure the smallest visible inputs, review the plan, then deploy.
Takosumi should not add a
separate low-level "create service" CRUD surface for ordinary users; the full
service list can expose details after creation, while the add path stays
install-like.

The Store is only discovery and presentation. A Store node announces a Git
repository/path, icon, and description. It is not a setup or
release authority: branch, tag, commit, SourceSnapshot, and update policy stay
in the Source / Run flow. Switching Store nodes changes the read source for
listings and presentation metadata, not the Capsule execution model.

Repositories may optionally publish `.well-known/tcs.json` presentation
metadata containing display text, icon, and `modulePath`. The icon URL may be
a credential-free absolute HTTPS URL or a repository-relative source path;
resolving and re-hosting a relative path is the responsibility of the Store
indexer that publishes the listing, so listings carry absolute HTTPS URLs.
Listing consumers and repo-metadata readers never synthesize forge-specific
raw-file URLs and drop any icon value that is not credential-free absolute
HTTPS. An unresolved relative path only degrades to the no-icon fallback and
never blocks discovery or install. The document must not declare
`git`, `source`, refs/commits, `installConfigId`, variable presentation/defaults,
`installExperience`, output allowlists, release artifacts, domain defaults, OIDC
wiring, lifecycle actions, or Interface blueprints. Those declarations live in
top-level, DB-owned InstallConfig fields such as `variablePresentation`,
`installExperience`, and `interfaceBlueprints`. A DB-owned `installExperience`
`oidc_client` projection may declare public OIDC client metadata (issuer, client
id, redirect URI) plus required OAuth scopes; `openid` is mandatory and scopes
must be non-empty, unique tokens. Client secrets, access tokens, and refresh
tokens are never projected through repository metadata, OpenTofu variables,
state, or Outputs.

Every DB-owned `interfaceBlueprints` entry requires an explicit immutable
`key`. Takosumi never substitutes its editable display `name` as the
materialization identity.

Git source sync records a bounded observation of this repository-root document
on the immutable `SourceSnapshot`, separately from the selected OpenTofu module
archive. The observation is display evidence only; its absence or invalidity
does not block snapshot reuse or Store-backed planning and cannot mutate the
stored InstallConfig.

Takosumi can reuse SourceSnapshots, provider mirrors, provider plugin caches,
runner capacity controls, package caches, and clear progress phases. The default
fast path is a Git CI/release artifact consumed and SHA-256-verified by the
repository's OpenTofu module. A Capsule can instead opt into `sourceBuild` with
explicit argv commands and expected relative outputs. That phase receives no
provider credentials and cannot select or create infrastructure; the Git module
still owns the OpenTofu plan.

`sourceBuild` is service-side Capsule configuration, not Store metadata and not
an executable field in `.well-known/tcs.json`. Takosumi does not infer commands
from `package.json`, and it does not silently fall back from a missing release
artifact to a build. Expensive OCI/container image builds should remain in the
app repository's CI and registry.

Release/update automation is Git-native: a Source tracks a branch, tag, or
commit ref; source sync resolves that ref to an immutable commit and archive; a
Capsule that is active on an older commit becomes `stale`; Workspace update
plans the change. If the module consumes a prebuilt container/image/bundle, it
does so through ordinary OpenTofu variables, providers, or data sources. An
explicit source build runs against that same pinned snapshot before each
plan/apply/destroy materialization.

The reference runner keeps successful plan containers warm for
`TAKOSUMI_RUNNER_KEEPALIVE_SECONDS` seconds (default `0`; official Cloud uses
`120` so apply / destroy apply can return to the plan runner object while it is
warm) and shuts down non-plan runs after success plus all failed runs
immediately. Operators can also pass `TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR`,
`TAKOSUMI_SOURCE_BUILD_CACHE_DIR`, `TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL`, and runner capacity retry knobs as
non-secret speed settings. This is not a cross-run source-sync cache.

## Service Form Host Resolution (`Resource Shape` compatibility)

The Service Form host flow starts from typed Resource objects with an exact
FormRef and resolves them to Targets. The current API/provider/state has not yet
added FormRef persistence and uses the Resource Shape kind as its compatibility
identity. Existing Resource IDs, kinds, ResolutionLocks, Runs, and state remain
stable throughout migration; no second ledger is created. Objects can be
submitted through the `/v1/resources` Deploy API,
`takosumi_*` provider resources, CLI, dashboard, or Kubernetes CRDs:

```text
exact FormRef + Resource
  -> installed definition + executable implementation + FormActivation
  -> TargetPool / Policy / Credential
  -> Adapter capability
  -> ResolutionLock
  -> NativeResource
```

Users normally describe the shape they want, not the backend. Operators decide
which Targets are available, which Adapters are enabled, and which policies
control placement. Resolver decisions are recorded as ResolutionLocks and do
not move without an explicit migration.
TargetPool, Policy, and Adapter are operator/advanced surfaces; the default UX
shows the Service Form, required inputs, price, preview, and deploy.

Service Forms do not replace existing providers for external infrastructure;
use those providers through the plain Stack flow. Capacity sold and operated by
an operator uses a portable exact Service Form plus an explicit implementation
and generic FormActivation. Cloud adds an exact ServiceOffering when it sells or
officially operates that capacity. Standard/compatible surfaces are
control-plane translations or data planes for that Resource, not lifecycle
authorities.

`/v1/resources` is the sole authority for preview/apply/observe/refresh/import/
delete and canonical Resource, ResolutionLock, NativeResource, Run, status,
Output, and audit evidence. TargetPool, Policy, Adapter, and backend-manager
selection are operator/advanced machinery behind that API.

The absence of a standard surface does not justify a catch-all provider.
One-off gaps and external infrastructure stay in generic-env
ProviderConnections and normal OpenTofu modules. A new `takosumi_*` schema is
justified only for a repeated provider-neutral Service Form backed by typed
schema, planner, adapter, import/drift/state
behavior, and capability evidence. Current `takosumi_*` form resources remain
compatibility state; new typed form-client authority moves to the independent
provider. A provider resource that maps to neither a portable Service Form nor
a Takosumi operator/admin object has no reason to exist.

`takosumi/takosumi` is discontinued and retained only for existing-state
migration and rollback custody. Takoform owns portable authoring; direct API,
CLI, and dashboard own operator/admin operations and converge on the same
managed-service lifecycle.

Takos is a representative consumer of this rule. Takos should be described as
the composition of generic Service Form-backed Resources it actually needs,
not as a product-specific catch-all shape:

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
topology and is consumed by Takos through Interface/InterfaceBinding.

Do not add `takosumi_takos` or an equivalent one-resource wrapper. If Takos
later needs a service form that these generic shapes cannot express, add the
missing service form only after the same prior-art gate passes.

Consumer shapes such as `EdgeWorker` and `ContainerService` can declare
non-secret `connections` to the shapes they use. A connection carries only the
resource reference, requested permissions, and projection kind. Credential
material and concrete runtime binding generation remain in Credential /
ProviderConnection and adapter execution. The HCL surface is `connections =
[...]`; `connection` is reserved by OpenTofu/Terraform.

Adapters report capabilities and perform preview/apply/import/observe/refresh/delete work.
Initial adapter families can include OpenTofu, Cloudflare, AWS, Kubernetes, VM,
and Takosumi-native adapters.

The platform scheduler reuses that same read-only `observe` operation for
`Ready` Resources at their current generation. A bounded durable lease prevents
duplicate observation across isolates, and the scheduler never refreshes,
applies, changes the ResolutionLock, or creates a separate Resource registry.
One backend failure is isolated from the remaining due Resources.

Extensible surfaces use capability tokens. For example, a
`ContainerService` target can publish an operator-defined implementation plugin
with custom interface evidence. The endpoint accepts or rejects those tokens
through resolver/policy, not through a hard-coded provider binary allow-list.
That extension is for backends of an existing typed shape. Adding a new
HCL-facing `takosumi_*` shape still requires a schema/API/provider release so
OpenTofu can keep typed validation, plan diffs, import, and state upgrade
behavior.

Provider capability documents may include operator-defined adapter tokens as
additional boolean keys under `adapters`. Known adapter keys remain
`opentofu`, `aws`, `cloudflare`, `kubernetes`, `vm`, and `takosumi_native`;
extra keys are endpoint-specific and must be backed by TargetPool evidence and a
plugin-aware adapter.

Secrets remain Credential/ProviderConnection material and are never placed in
the Service Form / Resource spec or OpenTofu state. AI Gateway configuration follows the
same secret/env projection rule; it is not a default Resource Shape.

## Compatibility Capabilities

Compatibility APIs are scoped, versioned entrypoints. They are enabled and
advertised as capabilities, for example:

```text
compat.s3.v1
compat.oci.v1
compat.cloudevents.v1
compat.kubernetes.crd.v1
```

They preserve narrow standard facades when Takosumi provides the backend,
import path, or managed-target control. They are not a claim of complete
provider API compatibility, an internal provider-specific
model, or a reason to recreate standards that already work through existing
providers.

Control-plane compatibility profiles translate requests into typed Resource
desired state and call the Deploy API; they own no lifecycle rows or backend
dispatch. Data-plane profiles resolve a Ready canonical Resource plus authorized
Interface/NativeResource evidence. Unsupported operations fail closed instead
of pretending full vendor compatibility.

The public API boundary is documented in [Takosumi API](./api.md). Internal
planning and conformance notes live outside the published docs surface.

## Operator / Cloud Concepts

The following are operation or hosted-service concepts, not portable OSS model
requirements:

```text
commercial customer management
subscription / invoice / payment integration
official managed target pools
official native runtime / object store / queue / DB / edge gateway internals
official billing / SLA / support / abuse controls
```

Takosumi for Operator can operate its own managed target catalog and commercial
service. Takosumi Cloud is the official hosted operation with official managed
capacity.

Cloud sells versioned `ServiceOffering` records rated by a versioned
`PriceCatalog`. Preview returns a `DeploymentQuote` bound to the Resource spec
digest, resolution fingerprint, offering/catalog versions, SKU line items,
currency, estimated total, expiry, and quote digest. Billable apply requires
the quote id/digest, reserves before backend work, captures on success, and
releases on failure or cancellation. Captured reservations and rated UsageEvents
reconcile to payment-provider invoice lines. These are Cloud commercial records
around the Resource lifecycle, not a revived `Deployment` ledger.
