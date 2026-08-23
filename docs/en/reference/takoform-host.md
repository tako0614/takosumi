# Takoform provider integration

> Migration boundary note: Takosumi OSS retired its embedded Resource/Form
> Host. This page records the bounded compatibility boundary; it is not a new
> Resource authoring guide.

The Takosumi OSS platform edge does not mount a Takoform Host by default, and
the retired paths remain `404`. Takoform is an ordinary OpenTofu provider
selected by a repository module, like Cloudflare, AWS, or any other provider.

OSS retains one generic in-process compatibility composition for migrating an
existing exact v1alpha1 Resource. It is mounted only when host code explicitly
injects the complete maintenance lane. A normal OSS edge or text environment
flag cannot enable it. The external Host (for example, the Takosumi hosted service) owns the
backend, installed and retained Forms, and the explicit transition-pair policy.

## Execution path

```text
repository module
  → ProviderConnection / ProviderBinding
  → credential materialized only inside the runner
  → OpenTofu invokes the Takoform provider
  → configured external Host
  → state / typed Output
  → generic post-apply Interface projection where required
```

The frozen compatibility composition must expose discovery, exact Form
availability, the old exact read/observe/preview/update/delete lifecycle, and
the transition operation on one configured origin. Advertising only the
transition endpoint is invalid.

## Exact Resource Form transition

An ordinary `PUT` cannot change a Resource's exact Form identity. The only
identity-changing operation is:

```text
POST {endpoints.api}/resources/:kind/:name/form-transitions?space=...
```

Its closed request contains:

- `operationId`: `formtx_` plus the SHA-256 of RFC 8785 canonical JSON in the
  `takoform.resource-form-transition-operation@v1` domain. The preimage binds
  logical Resource identity, exact `fromForm` / `toForm`, desired spec digest,
  `expected`, and transition evidence, but excludes `operationId` itself.
- exact structured `fromForm` and `toForm`, including API version, kind,
  definition version, schema digest, and package digest;
- `resource`, the desired Resource bound to `toForm`, with immutable
  name/space/kind, required current `metadata.resourceVersion: N`, and a spec
  valid under the new Form, with secret-like fields and private-key material
  rejected;
- required `expected.resourceVersion` for current generation `N`, repeated as
  quoted `If-Match`; `Idempotency-Key` must equal `operationId`;
- optional exact non-secret `expected.nativeIdentity` only when provider state
  already exposes it; and
- `transitionEvidence`, a `takoform.module-form-transition@v1` marker/digest
  that binds the product/module declaration to the exact pair.

The body never accepts owner, Workspace/Capsule/Run, ResolutionLock, storage
revision, revision id, native evidence, or credential audience/scope claims.
The Host derives them from the current authenticated Run, ProviderBinding,
ProviderConnection, CredentialRecipe, and canonical Resource aggregate. Before
host dispatch, Core durably records a value-free precondition snapshot and a
canonical Resource claim. The claim transaction fences the exact Resource
revision, ResolutionLock/native evidence, and identity fence together. No
secret, credential, or native payload is stored in this ledger.

The provider performs
`GET {endpoints.api}/resources/:kind/:name/form-transitions/:operationId?space=...`
before mutation. It may POST only after exact `404` with
`code:resource_not_found` and
`hostCode:form_transition_operation_not_found`, or after the same
operation/request digest returns
`202 prepared` with `dispatchAttempted:false`. Prepared+true, indeterminate,
digest mismatch, or uncertain GET transport means zero POST. The same-operation
POST acquires a dispatch fence with CAS, so at most one host call occurs.
`requestDigest` is the RFC 8785 SHA-256 in the
`takoform.resource-form-transition-request@v1` domain and binds the exact
request including `operationId`. Committed operations return `200`, unresolved
operations return `202`, and a definitive rejection is a stable `409` carrying
the exact operation, request digest, and failure code.

A commit proof binds the operation, exact old/new FormRefs, evidence digest,
observed spec digest, unchanged native identity, and resource version `N + 1`.
Core first attaches that proof to the exact operation ledger. Only then does it
atomically advance the Resource FormRef/spec,
ResolutionLock, and native Form evidence to `N + 1` and clear the claim. A
short crash window before the terminal operation status is repaired remains
fenced by the Resource's operation-bound revision id, so normal lifecycle
mutations cannot race the repair. A
same-operation replay/readback returns that same `N + 1` receipt even after a
later generation exists and never increments it again. A definite pre-mutation
rejection leaves the old Form/spec/ResolutionLock/native identity unchanged and
releases only the claim after persisting its terminal receipt. A timeout or
lost acknowledgement returns `202 indeterminate`; GET never
dispatches a provider/backend mutation. It may narrowly forward-repair the
canonical database only when the exact host ledger already proves this
operation committed and the stored claim, old preconditions, and desired spec
digest still match.

## Protocol authority

Takosumi documentation does not promote an unpublished Takoform candidate or
infer a Form transition from semver. The installed provider and the configured
Host discovery/contract remain protocol authority. Mounting this maintenance
lane does not turn retained Resource Shape, TargetPool, or SpacePolicy APIs into
a supported OSS authoring surface.
