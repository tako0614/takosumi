# Takosumi Provider Assets

This directory is copied into the Takosumi platform Worker's `ASSETS` binding.

The `takosumi/takosumi` OpenTofu provider mirror is generated here by:

```bash
bun run provider:assets
```

By default the script uses the package version and builds
`linux_amd64,linux_arm64,darwin_amd64,darwin_arm64`. Override with
`TAKOSUMI_PROVIDER_VERSION` or `TAKOSUMI_PROVIDER_PLATFORMS` when cutting a
specific provider release.

The generated mirror root is:

```text
/opentofu/providers/registry.opentofu.org/takosjp/takosumi/
```

Provider archives are generated artifacts and should not be hand-edited.
