# Discontinued Takosumi provider custody

There is no Takosumi provider release operation. The `provider/v1.1.4`
publication was cancelled, the GitHub publication workflow is removed, no new
version is allowed, and the dashboard/platform no longer materializes this
provider into its default mirror.

Keep the retained source and evidence because existing state removal is gated
by the published 365-day compatibility policy. Do not delete, rewrite, publish,
or mirror the quarantined `1.0.0` bytes. Do not reuse the failed 1.1.0-1.1.3
tags or the cancelled 1.1.4 version.

Repository custody check:

```bash
bun run provider:custody:check
```

Optional migration evidence, on an operator machine with the retained 1.0.0
filesystem mirror and disposable state only:

```bash
TAKOSUMI_PROVIDER_QUARANTINE_ROOT=/operator/evidence/provider-1.0.0-mirror \
  bun run provider:custody:state-proof
```

This evidence is for existing-state migration and rollback only. It is not a
Takosumi GA gate and never permits publication.

For new work, use Takoform for portable Service Forms and their Resource
Interface descriptors, service-side InstallConfig blueprints for Capsule
Interfaces, Takosumi API/CLI/dashboard for operator administration, and
ordinary providers through the plain Stack +
ProviderConnection/CredentialRecipe/ProviderBinding flow for infrastructure.
