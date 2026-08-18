# Takoform Object Bucket Smoke Fixture

This is the smallest public Git Source fixture for a Takosumi Capsule backed by
an existing Takoform ProviderConnection. It deliberately has no `provider`
block: the Takosumi runner injects the selected connection's
`TAKOFORM_ENDPOINT`, `TAKOFORM_SPACE`, and `TAKOFORM_TOKEN` values for the
plan/apply/destroy phases.

The required provider source is the canonical Terraform Registry address
`registry.terraform.io/tako0614/takoform`, pinned here to `2.1.1`; provider
credentials remain a generic-env connection concern rather than Capsule source
state.

The fixture uses the released provider's current Edge Platform ObjectBucket
resource (`takoform_edge_object_bucket`) and therefore negotiates the Host API
v1beta1 lane. The `bucket_name` variable must be unique for the target Takoform
host. The fixture exposes only `object_bucket_id`, the host-issued immutable UID;
it does not expose endpoint, space, token, or any other credential material.

Example smoke source settings:

```text
source-git-url = https://github.com/tako0614/takosumi.git
source-path    = .
module-path    = examples/takoform-object-bucket-smoke
```

`source-path` selects the archived subtree of the Git source, while
`module-path` is resolved inside that archive. Keeping the repository root in
the snapshot also keeps the repository-owned `takosumi.json` install metadata
available during Capsule installation.

Set `--provider-connection-id` (or
`TAKOSUMI_SMOKE_PROVIDER_CONNECTION_ID`) to an operator-provided Takoform
ProviderConnection and pass a unique `bucket_name` through the Capsule vars.
