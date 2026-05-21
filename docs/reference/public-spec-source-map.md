# Public Spec ソースマップ {#public-spec-source-map}

public surface ごとの source of truth と reference の対応表です。wire / package
surface を変えるときは、実装 source、test、docs を同じ変更で更新します。

## Map

| Spec key | Public surface | Owner | Source of truth | Published reference |
| --- | --- | --- | --- | --- |
| `appspec-v1` | `.takosumi.yml` envelope / validation | takosumi installer + contract | `packages/installer/src/yaml-parser.ts`, `packages/contract/` | [AppSpec](./app-spec.md) |
| `installer-api-v1` | Installation / Deployment / rollback 5 endpoint | takosumi kernel + installer | `packages/kernel/src/api/installer_public_routes.ts`, `packages/contract/src/installer-api.ts` | [Installer API](./installer-api.md) |
| `kernel-http-api-v1` | public / internal / runtime-agent HTTP boundary | takosumi kernel | `packages/kernel/src/api/` | [Kernel HTTP API](./kernel-http-api.md) |
| `runtime-agent-api-v1` | lifecycle RPC envelope | takosumi runtime-agent | `packages/runtime-agent/`, `packages/contract/` | [Runtime-Agent API](./runtime-agent-api.md) |
| `kind-catalog-v1` | component kind and artifact kind docs | takosumi plugins | `packages/plugins/src/kinds/` | [Kind Catalog](./kind-catalog.md) |
| `provider-plugins-v1` | provider plugin contract and matrix | takosumi provider packages | `packages/*-providers/`, `packages/plugins/` | [Provider Plugins](./providers.md) |
| `takosumi-jsr-packages` | JSR package exports and dependency pins | package owners | `packages/*/deno.json`, `packages/*/mod.ts` | `https://jsr.io/@takos/takosumi` |

## Boundary rules

- AppSpec source is `.takosumi.yml`; Takosumi does not discover `.takosumi/`
  workflow files.
- Installer clients submit source / expected pin to the installer endpoints.
- Workflow runner, scheduler, webhook, account-plane, billing, and OIDC issuer
  are outside the kernel public surface.
- Public JSR package checks use each package's `deno.json`, not only the root
  workspace import map.

## 関連ページ

- [AppSpec](./app-spec.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Installer API](./installer-api.md)
- [Workflow Placement Rationale](./architecture/workflow-extension-design.md)
