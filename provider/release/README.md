# Takosumi legacy/admin provider release lane

This directory is the independent release authority for the Takosumi-owned
legacy/admin provider. It does not inherit the Takosumi JavaScript package
version.

- `version.json` is the exact candidate version, tag, address, platform, and
  hermetic toolchain/runtime contract. Its SHA-256 sidecar is required.
  `1.1.0` is a candidate only; it has not been published.
- `registry.json` plus its sidecar is the only normal mirror-admission
  authority. It retains all known versions. Direct candidate-manifest
  materialization is restricted to the explicit test-only seam.
- `quarantine/1.0.0.json` records every immutable public `1.0.0` version
  document and archive byte sequence. Its `indexObservation` is evidence of
  the mutable aggregate catalog seen at the same time, not a frozen `1.0.0`
  asset. The served binary reports `dev` and dirty provenance, so `1.0.0` is
  retained for compatibility but is never reproducible release evidence.
- `compatibility/1.0.0-state-identity.json` pins the non-secret structural
  schema identity read from those exact public bytes. The adjacent `1.1.0`
  delta policy classifies four new resources and eight optional attributes,
  rejects their inclusion in the `1.0.1` patch lane, and keeps them together
  only in the unpublished minor candidate.
- Release builds are explicit: a clean `provider/v<version>` tag and its exact
  commit are required. Production also requires an annotated signature from a
  reviewed signer fingerprint. No signer fingerprint is configured yet, so
  this is a candidate-only lane and production publication remains blocked.
  The builder writes only to a new directory outside the tracked mirror and
  builds twice before accepting any byte. Git and gpgv use pinned absolute
  paths, versions, executable digests, an isolated config/home, and a
  digest-pinned keyring; Go additionally pins its whole distribution and the
  dynamic runtime files used by release tools. Dependency resolution is
  offline and the pre-populated Go module cache must pass `go mod verify`.
- Dashboard and Worker builds are mirror consumers. They materialize immutable
  version/archive bytes into generated `dashboard/dist`, then derive the
  aggregate index by deterministically merging reviewed versions. They never
  rebuild an old provider version.

The current mixed provider keeps the supported `takosumi_*` form state and
`takosumi_target_pool` ownership. Future portable Service Form resources move
only after the independent provider identity and state-migration gates pass.

Run `bun run provider:compatibility:check` for the hermetic current-schema
comparison and prerequisite matrix. Run
`bun run provider:compatibility:state-proof` separately for the connected
old-state proof. `provider:compatibility:release-check` is intentionally red
while the explicit OpenTofu/Terraform install, schema, state, and FQN matrix
remains unproven. The feature-bearing patch lane is already rejected in favor
of the `1.1.0` minor candidate; CLI discovery alone never claims the matrix.

See [provider-release-and-mirror.md](../../docs/operations/provider-release-and-mirror.md)
for commands and incident handling.
