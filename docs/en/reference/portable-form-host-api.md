# Portable Form host API

Takosumi implements the provider-neutral Takoform host boundary without making
Takoform a Takosumi runtime dependency. The neutral API is a thin HTTP
projection over the same canonical `Resource`, `ResolutionLock`, `Run`, state,
output, and Activity audit records used by `/v1/resources`. It creates no
second lifecycle or idempotency ledger.

## Discovery and versioning

`GET /.well-known/takoform` advertises
`forms.takoform.com/v1alpha1` and these endpoints:

- `endpoints.api`: `/apis/forms.takoform.com/v1alpha1`, the exact FormRef API;
- `endpoints.forms`: principal-scoped exact Form availability;
- `endpoints.interfaces`: read-only portable Interface declarations
  materialized for Form-backed Resources;
- `endpoints.capabilities`: the existing `/v1/capabilities` compatibility
  endpoint;
- `endpoints.compatibility_api`: the existing `/v1` candidate API.

The current `terraform-provider-takoform` candidate still calls
`/v1/capabilities` and `/v1/resources` at its configured origin. Those routes
remain available so that provider continues to work, but it remains a legacy
compatibility client: it does not yet send an exact FormRef, ETag precondition,
or idempotency key. A later provider release must consume `endpoints.api` and
the versioned contract before it can count as portable-host conformance.

## Exact routes

The versioned base is `/apis/forms.takoform.com/v1alpha1`:

- `GET /forms` lists principal-scoped `FormAvailability` records;
- `GET /interfaces` lists visible Interface declaration instances;
- `GET /interfaces/{name}` reads one declaration identity and returns an
  explicit ambiguity error until `version` and, when needed,
  `resourceKind`/`resourceName` select one instance;
- `POST /resources/preview` previews one exact desired Resource;
- `PUT /resources/{kind}/{name}` creates or updates it;
- `POST /resources/{kind}/{name}/import` imports a native identity;
- `GET /resources/{kind}/{name}` reads it;
- `POST /resources/{kind}/{name}/observe` observes drift;
- `POST /resources/{kind}/{name}/refresh` republishes canonical state;
- `DELETE /resources/{kind}/{name}` deletes it.

Every request identifies the complete `InstalledFormReference`: API version,
kind, definition version, schema digest, and package digest. Query-based reads
must provide all five identity fields. Partial or substituted identity is never
resolved as “latest”. New preview/apply/import calls additionally require the
exact Form to be installed, executable, activated, and available to the acting
principal.

## Concurrency, replay, and errors

Create uses `If-None-Match: *`; update and lifecycle operations use a quoted
Resource generation in `If-Match`. Mutations require an `Idempotency-Key`.
The key is carried into canonical operation identity; there is no HTTP-side
replay database. Exact apply/import retries return the already completed
canonical Resource, delete of an absent exact Resource is successful, and
stale or different desired state returns `resource_version_conflict`.

Responses return a stable provider-facing error envelope and omit Target,
implementation, manager, credential, capacity, price, SKU, quota, and SLA
state. Raw canonical Outputs are also omitted because a generic host cannot
prove which values are safe portable output fields. Audited runtime values are
published through the Form's `Interface` contract.

Interface declarations are read-only projections of ordinary Takosumi
`Interface` records with exact `form_descriptor` lineage. Descriptor identity
is `(name, version)` and runtime instance identity additionally includes the
Form-backed Resource kind/name and Space. The endpoint exposes only the exact
descriptor document and resolved public values. It never exposes the host
Interface id, `InterfaceBinding`, bearer/token delivery, private declarations,
or raw Resource Outputs. Declaration and authorization remain separate.

A required descriptor is part of Resource admission. Takosumi rejects the
initial mutation before adapter/backend execution when its input source or the
explicit Resource-to-Workspace ownership bridge is unavailable. Backend-
dispatched recovery consumes its pinned admission instead of re-running the
current host check; if declaration materialization can no longer converge, the
canonical Resource becomes `Degraded` rather than being reported `Ready`.

## Conformance runner

`bun run service-form:host-conformance` runs discovery, exact availability,
retained negative desired-fixture rejection, preview/apply/replay/read,
canonical `/v1` Resource parity, digest-substitution rejection, observe,
refresh, canonical audit parity, optional import replay, and idempotent delete
against a host. It accepts JSON files for the exact identity, desired spec, and
optional `StandardFormNegativeFixture[]`; bearer and native import identities
are read only from named environment variables. Unsupported negative fixture
stages fail closed. The emitted proof derives its fixture names only from the
fixtures this runner actually executed; callers cannot attach unexecuted names
after the run. The digest-bound report also includes each positive and negative
fixture's canonical input digest and the exact portable HTTP status/error code,
so a successful proof cannot be relabeled onto different fixture bytes.

The runner emits a digest-bound report suitable for the host half of standard
Form admission evidence. Provider conformance remains separate evidence.
