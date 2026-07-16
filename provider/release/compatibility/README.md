# Legacy provider compatibility authority

This directory contains data-only, non-secret evidence for the immutable
Takosumi legacy/admin provider transition. It does not contain Terraform state,
provider credentials, runtime values, or release signing material.

- `1.0.0-state-identity.json` records the structural provider/resource schema
  identity loaded from the exact quarantined public `1.0.0` linux/amd64 archive.
  Descriptions, validators, ordering, and all state values are excluded. The
  quarantine manifest and archive digests bind the observation to the retained
  public bytes. Structural hashes are SHA-256 over compact JSON after recursively
  sorting object keys and removing `description`, `description_kind`, and
  `validators`; boolean/type/nesting/state semantics remain included.
- `1.0.1-delta-policy.json` classifies the current candidate delta. The four new
  resource types and eight optional field additions are additive schema changes,
  but their inclusion in a patch correction is **not approved**. Publication
  stays blocked until the release owner chooses a correction-only patch, moves
  the features to a minor release, or explicitly approves that additive patch
  before pinning the signing trust root.

`bun run provider:compatibility:check` builds the current candidate outside the
repository, asks OpenTofu for its machine schema, removes only the declared
additive paths, and requires the remaining schema to match this exact historical
identity. It also reports the OpenTofu/Terraform address and CLI prerequisite
matrix. A missing Terraform CLI is recorded as a release-blocking prerequisite,
never as a skipped test.

`bun run provider:compatibility:state-proof` is the connected proof. It installs
the exact quarantined provider from the public mirror, creates only disposable
non-secret fixture state against a local fake Takosumi endpoint, switches to the
current candidate, checks refresh-free no-op planning and observe behavior, and
then attempts rollback to the exact old provider. It never writes operator state
or credentials to this repository.

The connected proof covers all seven historical resource types across old
apply, current refresh-free no-op, current read-only observe/refresh,
old-provider rollback no-op, and destroy. It detected and drove removal of the
ObjectBucket plan-time schema default that had forced old state to update;
wire/state refresh still canonicalizes omission to `standard`. Publication
remains blocked by the separate feature-in-patch and FQN/tool prerequisites.
