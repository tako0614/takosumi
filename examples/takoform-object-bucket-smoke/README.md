# Takoform Object Bucket Smoke Fixture

This is the smallest public Git Source fixture for a Takosumi Capsule backed by
an existing Takoform ProviderConnection. It deliberately has no `provider`
block: the Takosumi runner injects the selected connection's
`TAKOFORM_ENDPOINT`, `TAKOFORM_SPACE`, and `TAKOFORM_TOKEN` values for the
plan/apply/destroy phases.

The `bucket_name` variable must be unique for the target Takoform host. The
fixture exposes only `object_bucket_id`, the provider's canonical resource id;
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
