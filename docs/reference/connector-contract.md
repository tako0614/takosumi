# Connector Contract

> Stability: stable Audience: operator, kernel-implementer See also:
> [DataAsset Kinds](/reference/artifact-kinds),
> [Providers](/reference/providers),
> [Runtime-Agent API](/reference/runtime-agent-api),
> [Audit Events](/reference/audit-events)

A Connector is the operator-installed software unit that materializes a
DataAsset onto an external runtime (a serverless host, a container orchestrator,
an object storage backend, etc.). Connectors are the only component permitted to
hold cloud or platform credentials at apply time; the kernel itself never holds
them. This reference defines the v1 Connector identity, record schema,
accepted-kind vector, Space visibility rules, signing expectations, envelope
versioning, and the operator-only operations that govern Connector lifecycle.

## Identity

A Connector identity has the closed shape:

```text
connector:<id>
```

The `<id>` segment is operator-controlled. It is never user-named, never derived
from manifest input, and never appears in user-authored manifests. Users select
an Implementation; the resolver picks the Connector bound to the
Implementation's accepted-kind vector and Space visibility.

Identity rules:

- `connector:<id>` is globally unique within the operator installation.
- The same `<id>` value never points to a different Connector code path across
  versions; replacement always goes through the operator `replace` operation,
  which carries an explicit version vector and envelope guard.
- `connector:` is a reserved prefix. No plugin, template, or user manifest may
  mint identities under this prefix. Plan rejects manifests that attempt to.

## Connector record

Each Connector is described by a record that the kernel reads at boot from the
operator-installed Connector registry:

```yaml
Connector:
  id: connector:cloudflare-workers-bundle
  acceptedKinds: [js-bundle]
  spaceVisibility: operator-policy-driven
  signingExpectations: optional
  envelopeVersion: v1
```

Field semantics:

| Field                 | Required | Meaning                                                                     |
| --------------------- | -------- | --------------------------------------------------------------------------- |
| `id`                  | yes      | The full `connector:<id>` identity.                                         |
| `acceptedKinds`       | yes      | Artifact kind strings the Connector accepts.                                |
| `spaceVisibility`     | yes      | Either `operator-policy-driven` (default) or a closed Space-set descriptor. |
| `signingExpectations` | yes      | One of `none`, `optional`, `required`.                                      |
| `envelopeVersion`     | yes      | The control envelope version this Connector speaks, currently `v1`.         |

The record is immutable for a given Connector instance. An operator who needs to
broaden `acceptedKinds`, raise signing expectations, or change envelope version
performs a Connector `replace` operation; the kernel treats this as a new
Connector record bound to the same `connector:<id>` identity, with the previous
record retained for audit and replay.

## Accepted-kind vector

The `acceptedKinds` vector lists the artifact kinds this connector can consume.
`Artifact.kind` is open at the protocol layer, and the bundled kind registry
starts with:

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

See [DataAsset Kinds](/reference/artifact-kinds) for the per-kind size caps,
registered metadata, and discovery API.

Plan-time enforcement:

- A Link or DataAsset binding whose `kind` is not in `acceptedKinds` is rejected
  with an `artifact_kind_mismatch` plan error.
- Adding a new kind to an operator installation requires registering discovery
  metadata with `registerArtifactKind`; a Connector must still explicitly list
  the kind in `acceptedKinds` before it can consume it.

The accepted-kind vector is the only mechanism by which a Connector declares
which artifacts it will materialize. Implementation matching proceeds through
the resolver: an Implementation declares an accepted-kind vector of its own, and
the resolver intersects it with each candidate Connector's vector before
binding.

## Space visibility

Connectors are not globally addressable. Visibility is controlled by operator
policy and is resolved per Space:

- `spaceVisibility: operator-policy-driven` (the default): the kernel consults
  operator policy at resolve time to determine which Spaces see this Connector.
  Different Spaces, including parent and child Spaces, may see different
  Connector sets.
- `spaceVisibility: <closed Space-set descriptor>`: the Connector is visible
  only to Spaces matching the descriptor. Reserved-prefix Spaces (`takos`,
  `operator`, `system`) are governed by the same descriptor semantics.

Resolver behaviour:

- A manifest that references an Implementation whose only candidate Connector is
  invisible to the active Space fails resolution with a closed plan error.
- The set of Connectors visible to a Space is recorded in the ResolutionSnapshot
  for replay; replay against a different visibility state surfaces a
  deterministic divergence.
- Visibility changes never mutate an existing ResolutionSnapshot. They surface
  on the next deploy through a new snapshot.

Operators are expected to drive visibility from policy, not from ad-hoc Space
configuration. This keeps Space-level policy auditable and keeps the resolver
deterministic.

## Signing expectations

The `signingExpectations` field declares what the Connector requires from the
artifacts it accepts:

| Value      | Meaning                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `none`     | Connector accepts unsigned artifacts. Per-key artifact policy may still mandate signing.                        |
| `optional` | Connector accepts both signed and unsigned artifacts. Plan logs the absence of a signature but does not reject. |
| `required` | Connector rejects unsigned artifacts at plan time.                                                              |

Signing expectations are connector metadata in current v1. Artifact signature
implemented:

- Signature verification itself is performed by the operator-installed signing
  backend; the Connector record only declares the expectation.

## Envelope versioning

Connectors speak a control envelope to the runtime-agent. The envelope is
versioned independently from the kernel HTTP API.

- v1 is the only envelope version defined for the v1 release.
- A breaking change to the envelope produces v2, which runs in parallel with v1
  during a transition window.
- During the transition window, both Connector versions are addressable through
  their `envelopeVersion` field; the runtime-agent dispatches based on the
  Connector record.
- The transition window is operator-configurable and recorded in the audit log
  under `catalog-release-rotated`.

For v1 apply / destroy envelopes, runtime-agent requests carry a WAL-derived
`idempotencyKey` when the call comes from the public OperationJournal path. The
same operation tuple is also available as `operationRequest` and in
`metadata.takosumiOperation` (`phase`, `walStage`, `operationId`,
`resourceName`, `providerId`, `operationPlanDigest`, and the raw tuple).
Connectors must treat repeated calls with the same key as the same logical side
effect and forward the key to cloud APIs that expose request-token semantics.

Envelope version is part of the Connector record, not part of the Connector
identity. A Connector keeps its `connector:<id>` across envelope upgrades; the
upgrade path is a `replace` operation that records both the prior and the new
envelope version.

## Operator-only operations

The following Connector operations are reserved for the operator surface. None
of them are addressable from user-authored manifests, and none of them are
exposed on the public CLI deploy path.

- `install`: register a new `connector:<id>` with its initial record. Records
  the install in the audit log under `catalog-release-adopted`.
- `replace`: bind a new Connector record to an existing `connector:<id>`.
  Records the replacement in the audit log under `catalog-release-rotated`. The
  replacement is rejected if it would shrink `acceptedKinds` while bindings
  exist that depend on the removed kinds, unless the operator passes an explicit
  drain plan.
- `revoke`: remove a `connector:<id>` from the active registry. Records the
  revocation in the audit log under `catalog-release-rotated`. Existing
  ActivationSnapshots that reference the revoked Connector remain replayable;
  new resolutions targeting the revoked identity fail.

Operator-only operations are gated by the operator bearer, not the deploy
bearer. The runtime-agent never performs these operations on behalf of users.

## Provider plugin consumption

Provider plugins are downstream consumers of Connectors:

- A provider plugin declares the `connector:<id>` identities it depends on. The
  kernel resolves each declared identity at apply time and rejects the apply if
  any declared Connector is not visible to the active Space.
- Provider plugins receive the resolved Connector record (`id`, `acceptedKinds`,
  `signingExpectations`, `envelopeVersion`) but never the Connector's
  credentials. Credentials remain inside the runtime-agent host.
- A provider plugin must not invent new `connector:<id>` identities. Plugins
  that need a new Connector raise the request through the operator `install`
  operation.

See [Providers](/reference/providers) for the provider plugin record schema and
registration API.

## Runtime-Agent hosting

The runtime-agent hosts Connectors as in-process modules:

- Each Connector is loaded once per runtime-agent boot. The
  `(shape, provider, acceptedArtifactKinds)` tuple is exposed at
  `GET /v1/connectors`.
- The runtime-agent dispatches lifecycle calls (`apply`, `destroy`, `describe`,
  `verify`) to the Connector module by `connector:<id>`.
- Connector code never reaches the kernel host. The kernel calls into the
  runtime-agent over the lifecycle envelope, and the runtime-agent calls into
  the Connector module.
- The runtime-agent fetches artifact bytes through the kernel's artifact
  partition using `TAKOSUMI_ARTIFACT_FETCH_TOKEN`; the Connector receives bytes
  by hash, never the deploy bearer.

See [Runtime-Agent API](/reference/runtime-agent-api) for the lifecycle envelope
wire format and error code enum.

## Related architecture notes

- `reference/architecture/data-asset-model` — the rationale for
  operator-installed Connectors, accepted-kind vectors, and Space visibility.
- `reference/architecture/operator-boundaries` — the trust split that keeps
  Connector credentials in the runtime-agent host.
- `reference/architecture/paas-provider-architecture` — provider plugin
  authoring patterns that consume Connectors.
