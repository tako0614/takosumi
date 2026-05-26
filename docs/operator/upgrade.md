# バージョン整合 {#version-alignment}

::: info
Exact production upgrade commands belong in release-specific operator runbooks. This page records package alignment rules.
:::

Takosumi packages are versioned per package. The public conformance surface is manifest / Installation / Deployment and the Installer API. Kind packages are separately installable because operators enable only the kinds they support.

## Publish order

1. `@takos/takosumi-contract`
2. `@takos/takosumi-installer`
3. `@takos/takosumi-runtime-agent`
4. portable `@takos/takosumi-kind-*` packages from `takosumi/`
5. `@takos/takosumi-kernel`
6. `@takos/takosumi-cli`
7. `@takos/takosumi` umbrella
8. native `@takos/takosumi-kind-*` packages from `takosumi-plugins/`

All packages are still pre-1.0. A minor bump can include breaking changes until the release notes say otherwise.

## Kind package alignment

Operator distributions should keep enabled kind packages, the kernel, and runtime-agent on the same tested release bundle. A distribution may pin fewer packages by enabling fewer kinds.

The core/portable package list is generated from `takosumi/scripts/jsr-publish-dry-run.ts`; native package checks live in `takosumi-plugins/`.

## Upgrade checks

| check              | source                                                   |
| ------------------ | -------------------------------------------------------- |
| package versions   | `scripts/jsr-publish-dry-run.ts` and package `deno.json` |
| public API smoke   | `takosumi install dry-run --source . --remote ...`       |
| schema ledger      | release-specific operator evidence                       |
| enabled kind smoke | operator-specific live provisioning evidence             |

## Related pages

- [Operator Bootstrap](./bootstrap.md)
- [Kind Packages](../reference/kind-packages.md)
- [Operator-managed 運用](./operator-managed.md)
