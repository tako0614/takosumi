# Digest Computation

> Stability: stable Audience: kernel-implementer, integrator See also:
> [Resource IDs](/reference/resource-ids),
> [Provider Implementation Contract](/reference/provider-implementation-contract),
> [WAL Stages](/reference/wal-stages),
> [Catalog Release Trust](/reference/catalog-release-trust),
> [Storage Schema](/reference/storage-schema)

This page is the formal specification of how Takosumi v1 computes the digests
that bind snapshots, plans, approvals, and predicted effects together. The same
algorithm is used everywhere a digest is persisted, including resource IDs whose
suffix is content-addressed.

The specification is normative: a kernel that produces digests differing from
this page is non-conformant, even if it follows the same broad recipe.
Cross-instance interoperability (replay, restore, catalog adoption) depends on
byte-exact digest agreement.

## Where digests are used

Five v1 digests fall under this specification:

| Digest                         | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `desiredSnapshotDigest`        | Identity of a `desired:sha256:...` snapshot.                   |
| `resolutionSnapshotDigest`     | Identity of a `resolution:sha256:...` snapshot.                |
| `operationPlanDigest`          | Identity of an OperationPlan; binds the WAL idempotency tuple. |
| `effectDetailsDigest`          | Identity of an `actualEffects` or `approvedEffects` view.      |
| `predictedActualEffectsDigest` | Identity of the dry-materialization prediction.                |

Other content-addressed IDs in [Resource IDs](/reference/resource-ids)
(`export-snapshot:`, `catalog-release:`, `policy:`) follow the same algorithm;
their specific input shapes are defined in their respective references.

## Algorithm

The digest algorithm is fixed in v1:

```text
digest = "sha256:" + lowercase_hex(SHA-256(canonical_encoding(input)))
```

- The hash function is **SHA-256** from FIPS 180-4. No other hash function is
  permitted in v1.
- The digest output is always prefixed with the literal string `sha256:` and a
  lowercase hex encoding of the 32-byte hash. The `sha256:` prefix is part of
  the digest and is included in any byte- for-byte comparison.
- The input to the hash function is the canonical encoding of the source value,
  defined below.

The `sha256:` prefix exists so that a future migration to a different hash
function lands behind a `CONVENTIONS.md` §6 RFC without breaking the existing
wire shape: digests with a different prefix would coexist with `sha256:` digests
during the deprecation window.

## Canonical encoding

The canonical encoding follows
[RFC 8785 (JSON Canonicalization Scheme, JCS)](https://www.rfc-editor.org/rfc/rfc8785)
with v1-specific clarifications:

- **Object keys** are sorted lexicographically by their UTF-16 code- unit
  sequence (the JCS rule). Sorting is byte-stable across implementations.
- **Numbers** are emitted as the IEEE 754 double-precision serialization defined
  by JCS §3.2.2.3. Integers within the safe integer range are emitted without a
  decimal point or exponent; fractional values use the canonical shortest
  representation. The kernel rejects non-finite numbers (`NaN`, `+Infinity`,
  `-Infinity`) at ingest, so they never reach digest computation.
- **Strings** are normalized to Unicode Normalization Form C (NFC) before
  encoding. The encoding is UTF-8 with the JCS escaping rules (`\"`, `\\`, `\/`
  not escaped, control characters escaped as `\u00xx`).
- **Arrays** preserve declared order; canonical encoding never reorders array
  elements.
- **Whitespace** is removed; the encoded byte stream contains no insignificant
  whitespace.
- **Charset** is fixed at UTF-8. The byte stream fed to SHA-256 is the UTF-8
  representation of the canonical JSON.

Implementations should not roll their own canonicalizer for v1; using a vetted
JCS library and applying the NFC pre-pass is sufficient.

## Per-digest input scope

Each digest is computed over a precise input. Including a different field,
omitting a required field, or reordering nested arrays produces a different
digest and is non-conformant.

### `desiredSnapshotDigest`

Input includes:

- `components` — the closed-shape component list of the snapshot.
- `links` — the projected link set in declared order.
- `exposures` — the exposure set in declared order.
- `dataAssets` — the DataAsset bindings in declared order.
- `desiredGeneration` — the monotonically increasing generation counter.

Input excludes:

- `spaceId` — the snapshot is identity-portable across Spaces; the binding to a
  Space is recorded separately on the snapshot envelope.
- `createdAt` — wall-clock timestamps are not part of identity.
- Operator-only annotations (audit notes, deploy bearer identifiers).

### `operationPlanDigest`

Input includes:

- `operations` — the ordered list of operation entries with their closed-shape
  descriptors.
- `approvedEffects` bound — the effect bound the plan was authored against.
- The resolved `connector:<id>` per operation.
- The targeted `desired:sha256:...` and `resolution:sha256:...` IDs.

Input excludes:

- `idempotencyKey` — the key is **derived** from the `operationPlanDigest`, not
  an input to it.
- `journalCursor` — runtime WAL state is not part of plan identity.
- Per-attempt counters (`operationAttempt`).

### `effectDetailsDigest`

Input is the closed-enum view of an effect set. The same algorithm is applied
whether the input is `approvedEffects` (on an approval record) or
`actualEffects` (on an OperationResult). The shape is identical so that a
successful operation's result digest can be compared byte-for-byte against the
approval's effect digest under the bound rule
([Provider Implementation Contract — Effect bound rule](/reference/provider-implementation-contract#effect-bound-rule)).

Input includes the closed-shape effect descriptors in the order they appear in
the source set; the canonical encoder sorts inside each descriptor by JCS rules
but does not re-order the outer list.

### `predictedActualEffectsDigest`

Input is the predicted effect map produced during dry materialization (see
[Provider Implementation Contract — Dry materialization phase](/reference/provider-implementation-contract#dry-materialization-phase)).
The shape is the same as `effectDetailsDigest`. The digest is bound to the
OperationPlan and is the reference value the `actual-effects-overflow` Risk
compares against at `commit` / `post-commit`.

### `resolutionSnapshotDigest`

Input includes:

- `catalogReleaseId` — the closed `catalog-release:<...>` ID active at
  resolution time.
- `exportSnapshotIds` — the resolved `export-snapshot:<sha256>` IDs in declared
  order.
- `importedShares` — the `share:<ulid>` IDs the resolution depends on, with
  their resolved freshness state.
- Resolved targets — the closed-shape per-component target binding the resolver
  chose.

Input excludes:

- `spaceId` — same identity-portability rule as `desiredSnapshotDigest`.
- Wall-clock timestamps.
- Resolver internal counters or telemetry.

## Collision handling

SHA-256 is treated as collision-free for v1. The kernel relies on this
assumption operationally:

- Content-addressed IDs assume that a digest match implies content match.
- Replay assumes that a digest mismatch is always a content divergence, never a
  hash collision.

A SHA-256 collision discovered in the wild would be handled by a
`CONVENTIONS.md` §6 RFC migrating to a different hash function. The `sha256:`
prefix in every digest leaves room for that migration.

## Digest comparison

How digests are compared depends on what is being compared:

- **Equality on stored digests** uses byte-for-byte comparison. The kernel does
  not normalize the prefix or hex case at comparison time; both sides are
  already canonical.
- **Signature verification on catalog releases** uses constant-time byte
  comparison via the [Catalog Release Trust](/reference/catalog-release-trust)
  signature backend. This is the only path that requires timing-safe comparison;
  routine apply-pipeline checks do not.

The kernel never compares digests by re-decoding to JSON and walking the
structure. The whole point of digest computation is that the canonical bytes are
the identity.

## Re-computation rules

The kernel persists digests at the moment they are first computed.
Re-computation is permitted only against the original immutable input record.

- `desired:sha256:...`, `resolution:sha256:...`, `export-snapshot:sha256:...`,
  `catalog-release:sha256:...`, and `policy:sha256:...` are all backed by
  immutable records. Re- computing the digest from the record yields the same
  value forever.
- `operationPlanDigest` is computed once at OperationPlan emission and persisted
  in the WAL header. Replay re-computes it from the stored OperationPlan record
  and verifies the match before advancing.
- `effectDetailsDigest` and `predictedActualEffectsDigest` are bound to
  immutable plan / approval / result records; re-computation is used by replay
  and audit verification only.

If an input record is mutable (the kernel never persists mutable inputs to
digest computation in v1), re-computation is not valid and implementations must
use the persisted digest instead.

## Related design notes

- docs/design/snapshot-model.md
- docs/design/operation-plan-write-ahead-journal-model.md
- docs/design/policy-risk-approval-error-model.md
- docs/design/catalog-release-descriptor-model.md
- docs/design/data-asset-model.md
