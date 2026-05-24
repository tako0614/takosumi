# Public Spec ソースマップ {#public-spec-source-map}

Takosumi public spec の source of truth と reference の対応表です。public spec
concept は AppSpec / Installation / Deployment と installer endpoint
に閉じます。wire surface を変えるときは、実装 source、test、docs を同じ変更で
更新します。

## Public spec map

| Spec key           | Public surface                                  | Owner                         | Source of truth                                                                                                                      | Published reference                 |
| ------------------ | ----------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `appspec-v1`       | `.takosumi.yml` envelope / validation           | takosumi installer + contract | `packages/installer/src/yaml-parser.ts`, `packages/contract/`                                                                        | [AppSpec](./app-spec.md)            |
| `installer-api-v1` | Installation / Deployment / rollback 5 endpoint | takosumi kernel + installer   | `packages/kernel/src/api/installer_public_routes.ts`, `packages/contract/src/installer-api.ts`, `packages/kernel/src/api/openapi.ts` | [Installer API](./installer-api.md) |

## Adjacent operator references

The following surfaces help operators run or extend the takosumi.com reference
distribution.

| Key                          | Surface                                          | Owner                               | Source / reference                                                                                            |
| ---------------------------- | ------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `build-service-input-v1`     | `.takosumi.build.yml` build service input        | build service distribution          | [Build service handoff](./build-spec.md); parser/service are operator distribution scope                      |
| `kernel-http-api-v1`         | internal / runtime-agent HTTP boundary           | takosumi kernel                     | [Reference Kernel Route Inventory](./kernel-http-api.md)                                                      |
| `runtime-agent-api-v1`       | lifecycle RPC envelope                           | takosumi runtime-agent              | [Runtime-Agent API](./runtime-agent-api.md)                                                                   |
| `reference-kind-examples-v1` | non-normative reference kind descriptor examples | takosumi.com reference distribution | `packages/plugins/spec/kinds/`, `packages/plugins/src/kinds/`, [Kind Descriptor Examples](./kind-registry.md) |
| `reference-providers-v1`     | provider binding guide and matrix                | takosumi provider packages          | [Provider Implementations](./providers.md)                                                                    |
| `takosumi-jsr-packages`      | JSR package exports and dependency pins          | package owners                      | `packages/*/deno.json`, `packages/*/mod.ts`, `https://jsr.io/@takos/takosumi`                                 |

## Placement rules

- AppSpec source is `.takosumi.yml`; build input, when used, is
  `.takosumi.build.yml` and belongs to operator build service scope.
- Component kind descriptor examples under `packages/plugins/spec/kinds/` and
  `https://takosumi.com/kinds/v1/*` feed operator alias / binding config.
- Installer clients submit source / expected digest guards to the installer
  endpoints.
- Build services submit prepared source snapshots with `source.kind=prepared`;
  build recipes stay in `.takosumi.build.yml` / build service scope.
- DataAsset upload / discovery docs describe an operator extension with separate
  credentials.
- Workflow runner, scheduler, webhook, account-plane, billing, and OIDC issuer
  are operator / account-plane surfaces that submit source to the Installer API.
- Public JSR package checks use each package's `deno.json`, not only the root
  workspace import map.

## Installer API symbols

The installer HTTP surface is represented by OpenAPI output from
`packages/kernel/src/api/openapi.ts` and by these route constants in
`packages/kernel/src/api/installer_public_routes.ts`:

- `INSTALLER_INSTALLATIONS_DRY_RUN_PATH`
- `INSTALLER_INSTALLATIONS_PATH`
- `INSTALLER_INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH`
- `INSTALLER_INSTALLATION_DEPLOYMENTS_PATH`
- `INSTALLER_INSTALLATION_ROLLBACK_PATH`

The dry-run handler remains `dryRunInstallation`; route behavior is covered by
`packages/kernel/src/api/installer_public_routes_e2e_test.ts`.

## Drift check

- `deno task check`
- `deno task lint:json-ld`
- `deno task spec:check-drift`
- `deno test --allow-all scripts/public-spec-source-map_test.ts`

## 関連ページ

- [AppSpec](./app-spec.md)
- [Build service handoff](./build-spec.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Installer API](./installer-api.md)
- [Workflow Placement Rationale](./architecture/workflow-extension-design.md)
