# terraform-provider-takosumi (discontinued)

`terraform-provider-takosumi` is discontinued. No new version will be built,
published, admitted to the Takosumi mirror, or recommended for new
configuration. The unpublished `1.1.4` work was cancelled.

Use the maintained surfaces instead:

- portable Service Forms and their Resource Interface descriptors: Takoform
  (`registry.terraform.io/tako0614/takoform`); Capsule Interface declarations
  remain service-side InstallConfig blueprints;
- Takosumi operator administration: the Takosumi API, CLI, or dashboard;
- ordinary infrastructure: the provider that owns that infrastructure, run as
  a plain OpenTofu/Terraform Stack with ProviderConnection, CredentialRecipe,
  and ProviderBinding injection.

Takosumi continues to run arbitrary providers. This retirement removes only
the Takosumi-specific mixed form/admin client; it does not remove runner
provider installation, mirrors/caches, credentials, aliases, or ordinary
provider-native state.

## Historical source custody

The Go source remains in this directory only for existing-state inspection,
migration, no-op/rollback proofs, and security custody. The v1 compatibility
policy requires a non-retroactive minimum 365-day support window plus external
zero-usage and rollback evidence before these state aliases or sources can be
removed. That window has not started, so deleting the historical source now
would be unsafe.

The source must not gain new resources or features. For custody checks:

```bash
bun run provider:custody:check
bun run test:provider
```

The connected migration proof is operator-only and optional for GA:

```bash
TAKOSUMI_PROVIDER_QUARANTINE_ROOT=/operator/evidence/provider-1.0.0-mirror \
  bun run provider:custody:state-proof
```

It operates only on disposable fixture state and retained immutable evidence.
It is not a release gate and cannot make this provider publishable.

See [release/README.md](./release/README.md) for the retained evidence map.
