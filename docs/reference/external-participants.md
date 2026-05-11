# External Participants

> Stability: reserved / future RFC Audience: operator, integrator,
> kernel-implementer See also: [Closed Enums](/reference/closed-enums),
> [Risk Taxonomy](/reference/risk-taxonomy),
> [Catalog Release Trust](/reference/catalog-release-trust),
> [Audit Events](/reference/audit-events),
> [RevokeDebt Model](/reference/revoke-debt)

This reference records reserved vocabulary for **ExternalParticipants** and
**ExternalImplementations**: systems that run outside the Takosumi kernel and
may contribute namespace exports or provider plugins into a Space in a future
RFC. Current v1 install / deploy contracts do not require external participant
exports; they may depend only on operator-owned namespace exports.

## ExternalParticipant model

The following model is candidate future-RFC material, not current v1 storage,
API, or resolution contract. An ExternalParticipant would be a system that
operates outside the Takosumi kernel and supplies namespace exports to one or
more Spaces. Typical examples are:

- an external account-plane adapter that publishes identity exports through an
  operator-owned namespace,
- an external secret manager that publishes future `secret/*` references,
- an external catalog publisher that publishes future catalog discoveries.

If this vocabulary is accepted later, the participant would be
**identity-bearing** but **never trusted to own kernel state**. Current v1 does
not register external participants, verify their export signatures, or resolve
their exports.

### Identity

A participant id has the form:

```text
external-participant:<id>
```

The `<id>` segment is operator-controlled. Once registered, the id is immutable:
rotating the id is modeled as `revoke` followed by `register` of a new id. The
id appears in `RevokeDebt.externalParticipantId`, in
`audit-events.payload.externalParticipantId`, and in
`namespace-export.source.kind = external-participant` references.

## ExternalParticipant registration record

Future RFC candidate registration record:

```yaml
ExternalParticipant:
  id: external-participant:auth-provider
  spaceVisibility:
    - space:platform
    - space:tenant-a
  declaredExports:
    - namespace: auth/oidc
      capabilities: [issue-token, introspect-token]
    - namespace: auth/oidc/jwks
      capabilities: [serve-jwks]
  publicKey: ed25519:<base64>
  verifiedAt: 2026-04-12T07:43:11.214Z
  expiresAt: 2027-04-12T00:00:00.000Z # optional
```

Field semantics:

| Field             | Required | Notes                                                                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`              | yes      | `external-participant:<id>`. Immutable.                                                                                      |
| `spaceVisibility` | yes      | Closed list of `space:<id>` ids the participant may serve. Outside this list resolution returns `not-found`.                 |
| `declaredExports` | yes      | Closed list of `(namespace, capabilities[])` tuples. Resolution rejects exports outside this list.                           |
| `publicKey`       | yes      | Ed25519 public key, base64 url-unsafe encoded with `ed25519:` prefix.                                                        |
| `verifiedAt`      | yes      | Timestamp of the most recent successful registration verification.                                                           |
| `expiresAt`       | no       | When set, registration auto-revokes at this instant. The kernel emits `external-participant-revoked` with `reason: expired`. |

If accepted, the record would be persisted in the partition declared in
[Storage Schema](/reference/storage-schema); rotation of the public key would be
a `revoke` + `register` cycle, never an in-place mutation.

## Verification protocol

Future verification would run at three points: registration, every export
resolution that traverses the participant, and every freshness refresh. Current
v1 has no such verification path.

### Registration challenge-response

The future operator flow would submit a registration request; the kernel would
issue a 32-byte random challenge bound to the proposed `id` and `publicKey`:

```text
challenge = random(32)
expectedSignature = Ed25519-sign(privateKey,
  canonical("external-participant-register" || id || publicKey || challenge))
```

The participant would return the signature. The kernel would verify, persist
`verifiedAt`, and emit `external-participant-registered`.

### Export-time signature

If a participant publishes an export in a future RFC, it attaches an Ed25519
signature over the canonical bytes of the export envelope:

```text
sig = Ed25519-sign(privateKey,
  canonical(externalParticipantId || namespace || capability ||
            exportContentDigest || issuedAt))
```

The future verifier would check the signature at:

- resolution time, against the registered `publicKey`,
- ResolutionSnapshot freshness refresh,
- post-commit re-resolution after approval invalidation.

A failed signature emits a `severity: error`
`external-participant-verification-failed` audit event and surfaces an
`implementation-unverified` Risk on any plan that selected an Implementation
backed by the participant. Approval cannot grant past a signature failure; the
operator must fix the participant or revoke it.

## Namespace visibility

ExternalParticipant exports are placed under a participant-namespace prefix that
is computed from the registration record, not from the export envelope:

```text
external-participant:<id>/<declaredExports[i].namespace>/<exported-name>
```

Visibility rules:

- A Space resolves an external export only when the Space id is in
  `spaceVisibility`. Outside that set the resolution returns `not-found`,
  indistinguishable from an absent export, so operators cannot probe for
  participants they have no claim on.
- Within a Space, the operator policy gates which `declaredExports` rows the
  Space's resolvers may bind. Two Spaces with the same participant in
  `spaceVisibility` may bind disjoint capability sets.
- A `shadowed-namespace` Risk fires when the same `(namespace, name)` is
  exported by both an internal source and an ExternalParticipant. Approval is
  required to bind the participant copy.

## Revocation

An operator revokes a participant with the internal API or the CLI. Revocation
is a state transition on the registration record, not a deletion: the record is
retained for audit and for RevokeDebt linkage.

Revocation pipeline:

1. The kernel marks the registration as `revoked` and emits
   `external-participant-revoked`.
2. Every dependent ResolutionSnapshot is marked `refresh-required`. Subsequent
   resolutions that need the participant's exports return `denied` with
   `errorCode: external_participant_revoked`.
3. Generated material that was projected from the participant's exports is
   enqueued for cleanup. Cleanup that fails permanently produces a `RevokeDebt`
   row with `reason: external-revoke`, owned by the importing Space.
4. SpaceExportShare rows that depended on the participant transition to
   `revoked` and propagate per
   [RevokeDebt — Multi-Space ownership](/reference/revoke-debt#multi-space-ownership).

Revocation is irreversible: re-registering uses a fresh `id`. Cleanup debt that
survives revocation surfaces in operator dashboards under the participant id
until the debt is `cleared`.

## ExternalImplementation

A third party may register a provider plugin as an **ExternalImplementation**,
which is the Implementation form of an ExternalParticipant. The registration
record reuses the participant identity and adds the implementation surface:

```yaml
ExternalImplementation:
  id: external-participant:acme-deploy
  port: provider
  shape: workers/script
  manifestDigest: sha256:<hex>
  publicKey: ed25519:<base64> # may equal the participant's key
  verifiedAt: 2026-04-12T07:43:11.214Z
```

Verification mirrors the participant flow: a registration challenge verifies the
manifest digest and the public key; every plan that selects the implementation
re-verifies the manifest digest.

A signature failure on an ExternalImplementation surfaces the
`implementation-unverified` Risk (`severity: error`, `fix kind: operatorFix`).
The Risk does not unblock through approval; the operator must rotate the
implementation key, re-publish a signed manifest, or remove the implementation
from the port selector.

## Audit events

External participant lifecycle emits the following closed events (see
[Audit Events](/reference/audit-events) for the envelope):

- `external-participant-registered` — issued on first successful
  challenge-response verification.
- `external-participant-verified` — issued whenever an export-time or
  refresh-time signature verification succeeds against a participant that is
  also in `refresh-required` state.
- `external-participant-revoked` — issued on operator revocation, on `expiresAt`
  auto-revoke, and on a permanent verification failure.

Each event payload references `externalParticipantId`, the operator actor, and
the prior / new registration digest.

## Operator surface

There is no current public or internal participant lifecycle API. The current
public `takosumi` CLI does not expose external-participant or
external-implementation subcommands.

Future candidate internal API:

| Method | Path                                                   | Purpose                                 |
| ------ | ------------------------------------------------------ | --------------------------------------- |
| POST   | `/api/internal/v1/external-participants`               | Register a participant.                 |
| GET    | `/api/internal/v1/external-participants`               | List participants visible to the actor. |
| GET    | `/api/internal/v1/external-participants/:id`           | Fetch a participant record.             |
| POST   | `/api/internal/v1/external-participants/:id/revoke`    | Revoke a participant.                   |
| POST   | `/api/internal/v1/external-implementations`            | Register an implementation.             |
| POST   | `/api/internal/v1/external-implementations/:id/revoke` | Revoke an implementation.               |

Every write requires the internal HMAC credential. Reads scope to participants
whose `spaceVisibility` includes a Space the actor has `admin` or `read` on.

## Related architecture notes

- `docs/reference/architecture/space-model.md` — ExternalParticipant identity
  origin and Space visibility model.
- `docs/reference/architecture/namespace-export-model.md` — ExternalParticipant
  exports in the namespace export tree and the shadowed-namespace resolution
  rule.
- `docs/reference/architecture/object-model.md` — `external` and `operator`
  lifecycle classes and their relationship to ExternalParticipant ownership.
- `docs/reference/architecture/policy-risk-approval-error-model.md` — rationale
  for the `implementation-unverified` Risk being non-approvable.
