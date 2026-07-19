# Takosumi legacy/admin provider release lane

This directory is the independent release authority for the Takosumi-owned
legacy/admin provider. It does not inherit the Takosumi JavaScript package
version.

- `version.json` is the exact candidate version, tag, address, platform, and
  hermetic toolchain/runtime contract. Its SHA-256 sidecar is required.
  `1.1.1` is the current candidate and has not been published. The signed
  `1.1.0` tag is retained immutably under `failures/` after its hosted-runner
  pre-artifact failure; it is never moved, deleted, or reused.
- `registry.json` plus its sidecar is the only normal mirror-admission
  authority. It retains all known versions, but only an externally verified
  `approved` entry is publishable. Quarantine entries are validated evidence,
  never mirror inputs. Direct candidate-manifest materialization is restricted
  to the explicit test-only seam.
- `quarantine/1.0.0.json` records every immutable public `1.0.0` version
  document and archive byte sequence. Its `indexObservation` is evidence of
  the mutable aggregate catalog seen at the same time, not a frozen `1.0.0`
  asset. The served binary reports `dev` and dirty provenance, so `1.0.0` is
  retained for compatibility but is never reproducible release evidence.
- `compatibility/1.0.0-state-identity.json` pins the non-secret structural
  schema identity read from those exact public bytes. The adjacent `1.1.1`
  delta policy classifies five new resources and nine optional attributes,
  rejects their inclusion in the `1.0.1` patch lane, and keeps them together
  only in the unpublished minor candidate.
- Release builds are explicit: a clean `provider/v<version>` tag and its exact
  commit are required. Production also requires an annotated signature from a
  reviewed signer fingerprint. The admin-provider-only signer, public key,
  digest-pinned keyring, expiry, and repo-external custody policy are recorded
  under `keys/`; private material is never committed or reused for Takoform.
  This remains a candidate-only lane until the signed tag, artifact signature,
  transparency evidence, and immutable public mirror activation all pass.
  The builder writes only to a new directory outside the tracked mirror and
  builds twice before accepting any byte. Git and gpgv use pinned absolute
  paths, versions, executable digests, an isolated config/home, and a
  digest-pinned keyring; Go additionally pins its whole distribution and the
  dynamic runtime files used by release tools. Go module-cache normalization is
  limited to the exact 20-path allowlist in `version.json`; only zero or all 20
  paths are accepted before the normalized entry count and content tree are
  verified. Dependency resolution is offline and the pre-populated Go module
  cache must pass `go mod verify`.
- Dashboard and Worker builds are mirror consumers. They materialize immutable
  version/archive bytes for approved releases into generated `dashboard/dist`,
  then derive the aggregate index by deterministically merging those releases.
  With no approved release they emit an empty index and no provider artifacts.
  They never rebuild or republish a quarantined provider version.

The current mixed provider keeps the supported `takosumi_*` form state and
`takosumi_target_pool` ownership. Future portable Service Form resources move
only after the independent provider identity and state-migration gates pass.

Run `bun run provider:compatibility:check` for the hermetic current-schema
comparison and prerequisite matrix. Run
`bun run provider:compatibility:state-proof` separately for the connected
old-state proof. That command writes ignored, digest-bound, credential-free
evidence to `tmp/provider-compatibility/1.1.1-state-proof.json` plus its SHA-256
sidecar. `provider:compatibility:release-check` is red until that evidence proves
the explicit OpenTofu/Terraform schema, state, and FQN matrix; CLI discovery
alone never claims the matrix. Passing this compatibility gate does not clear
the independent signer, signature, transparency, public-path, or mirror
activation blockers. The feature-bearing patch lane is already rejected in
favor of the `1.1.1` minor candidate.

See [provider-release-and-mirror.md](../../docs/operations/provider-release-and-mirror.md)
for commands and incident handling.
