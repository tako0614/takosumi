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
- `1.1.0-delta-policy.json` classifies the current candidate delta. The four new
  resource types and nine optional field additions are additive schema changes,
  so the feature-bearing `1.0.1` patch lane is rejected. They remain together
  only in the unpublished `1.1.0` minor candidate. Publication stays blocked by
  the independent compatibility and external release gates.
- `service-form-removal-policy.json` keeps the Resource Shape/API/provider/state
  aliases supported through v1 and announces a non-retroactive minimum 365-day
  window before any v2+ removal can become eligible. A current 90-day external
  zero-legacy-usage observation remains required.
- `service-form-migration-fixture-authority.json` pins the independent Takoform
  `v0.1.0-rc.3` structural remove/import/no-op/rollback fixtures by exact commit
  and digest. Takosumi consumes that migration authority without copying the
  portable provider's state fixtures into this repository.

`bun run provider:compatibility:check` builds the current candidate outside the
repository, asks OpenTofu for its machine schema, removes only the declared
additive paths, and requires the remaining schema to match this exact historical
identity. The complete machine schema of every declared new resource and field
is separately pinned, including required/sensitive/type/nesting flags. Exact
provider implementation source pins make default and validator drift fail
closed even though OpenTofu does not expose those semantics in schema JSON. The
check also reports the OpenTofu/Terraform address and CLI prerequisites. A
missing Terraform CLI is recorded as a release-blocking prerequisite, never as
a skipped test; finding the CLI clears only that prerequisite. The separate
state-proof command must still run the explicit Terraform schema/state/FQN
matrix.

`bun run provider:compatibility:state-proof` is the connected proof. It requires
`TAKOSUMI_PROVIDER_QUARANTINE_ROOT` to point to an operator-retained local
filesystem mirror, verifies every retained version/archive byte against the
quarantine authority, installs the exact quarantined provider without a network
or direct fallback, and creates only disposable
non-secret fixture state against a local fake Takosumi endpoint, switches to the
current candidate, checks refresh-free no-op planning and observe behavior, and
then attempts rollback to the exact old provider. It never writes operator state
or credentials to this repository. With reviewed Terraform `1.15.8` on `PATH`,
it writes a deterministic, value-free evidence document and digest sidecar to
the ignored `tmp/provider-compatibility/` directory. The document records only
authority/source/toolchain digests, CLI version/platform, explicit provider
FQNs, and bounded success flags; timestamps, executable paths, environment
values, state values, and credentials are excluded. A changed authority,
candidate descriptor, provider source, or proof implementation makes the
evidence stale and keeps the release check closed.

The connected proof covers all seven historical resource types across old
apply, current refresh-free no-op, current read-only observe/refresh,
old-provider rollback no-op, and destroy. It detected and drove removal of the
ObjectBucket plan-time schema default that had forced old state to update;
wire/state refresh still canonicalizes omission to `standard`.

Every proof subprocess receives an explicit environment allowlist rooted in a
temporary HOME. Provider tokens, cloud credentials, secret/password variables,
and credential-bearing proxies are not forwarded; `credentialsUsed` is derived
from the retained-key scan. Phase evidence requires exact per-resource request
deltas for historical apply, current refresh-free no-op, current observe,
TargetPool read/write, and historical rollback. A second real current-provider
`tofu apply` proves an omitted ObjectBucket `storage_class` persists as known
`standard` without regressing the old-state no-op.

After the connected proof, `bun run provider:compatibility:release-check`
validates the evidence sidecar and exact bindings before clearing only the
Terraform/address compatibility blocker. Provider signing, transparency,
immutable public-path verification, and publication remain external release
gates.

`bun run service-form:compat-removal:check` validates the repository policy and
fixture authority while deliberately reporting removal ineligible. The
operator-only `service-form:compat-removal:eligible` command additionally
requires complete authorized-state inventories, elapsed support/usage windows,
the current Takosumi provider proof, complete Takoform live migration phases,
and a digest-only rollback artifact/restore-drill manifest. See
[`docs/operations/service-form-compatibility-inventory.md`](../../../docs/operations/service-form-compatibility-inventory.md).
