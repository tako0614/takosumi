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
against a host. Supplying `--updated-desired` additionally executes a real,
ETag-fenced update for the same Resource. Supplying `--expect-drift true` and a
fresh `--drift-signal-file` pauses immediately before observe; after independent
automation mutates only the test backend object, it creates that file and the
runner requires the portable observation status to be `drifted`.

The runner accepts JSON files for the exact identity, desired documents, and
optional `StandardFormNegativeFixture[]`; bearer and native import identities
are read only from named environment variables. Unsupported negative fixture
stages fail closed. The emitted portable proof derives fixture names only from
fixtures this runner actually executed, and binds the canonical fixture inputs
and HTTP results by digest, so callers cannot attach or relabel unexecuted
fixtures.

`--output-format standard-runner-report` emits canonical
`takoform.standard-runner-report@v1` JSON for the host half of portable-standard
admission. This mode fails closed unless create/read/update/delete/import/
observe/refresh/drift and at least one positive and negative fixture actually
passed. `--package-root` is also required. The runner verifies that its exact
FormRef, positive desired document, and complete negative fixture closure equal
that retained package and binds each package-file digest to the effective
canonical input digest. The report embeds only the non-secret lifecycle
summary; Takoform recomputes its RFC 8785 digest during admission. Artifact
locations, desired values, connection documents, and runner-local paths are not
echoed. It does not sign, publish, or activate admission evidence. The Takoform
admission release process owns publisher policy, Sigstore signing, provider
evidence, exact package closure, and immutable admission activation.

For each exact retained package, invoke the complete host lane with private
operator paths and a dedicated test Resource:

```console
TAKOFORM_IMPORT_NATIVE_ID=<existing-native-test-id> \
bun run service-form:host-conformance -- \
  --endpoint https://<host> \
  --space <dedicated-test-space> \
  --name <dedicated-test-resource-name> \
  --identity /private/evidence/<kind>/installed-form-reference.json \
  --desired /private/evidence/<kind>/desired.json \
  --updated-desired /private/evidence/<kind>/updated-desired.json \
  --positive-fixture-name canonical \
  --negative-fixtures /private/evidence/<kind>/negative-fixtures.json \
  --package-root /private/readback/takoform/<kind> \
  --token-env TAKOSUMI_DEPLOY_CONTROL_TOKEN \
  --import-native-id-env TAKOFORM_IMPORT_NATIVE_ID \
  --expect-drift true \
  --drift-signal-file /private/evidence/<kind>/backend-drift-complete \
  --output-format standard-runner-report
```

The runner writes an `awaiting-external-drift` object to stderr. Mutate the
already-created native test object through its real backend, then atomically
create the named signal file. Do not signal before the backend read returns the
mutated state. The signal carries no authority and cannot make a non-drifted
observation pass. Use a new signal path and Resource identity for every run;
the runner refuses a pre-existing signal file and times out after five minutes.
