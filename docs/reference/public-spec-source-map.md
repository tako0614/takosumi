# Public Spec ソースマップ {#public-spec-source-map}

public surface ごとの source of truth と reference の対応表です。wire / package
surface を変えるときは、実装 source、test、docs を同じ変更で更新します。

## Map

| Spec key                | Public surface                                  | Owner                         | Source of truth                                                                                                                      | Published reference                          |
| ----------------------- | ----------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `appspec-v1`            | `.takosumi.yml` envelope / validation           | takosumi installer + contract | `packages/installer/src/yaml-parser.ts`, `packages/contract/`                                                                        | [AppSpec](./app-spec.md)                     |
| `buildspec-v1`          | `.takosumi.build.yml` build service input       | build service distribution    | `docs/reference/build-spec.md`; parser/service are operator distribution scope                                                       | [BuildSpec](./build-spec.md)                 |
| `installer-api-v1`      | Installation / Deployment / rollback 5 endpoint | takosumi kernel + installer   | `packages/kernel/src/api/installer_public_routes.ts`, `packages/contract/src/installer-api.ts`, `packages/kernel/src/api/openapi.ts` | [Installer API](./installer-api.md)          |
| `kernel-http-api-v1`    | public / internal / runtime-agent HTTP boundary | takosumi kernel               | `packages/kernel/src/api/`, `packages/kernel/src/api/openapi.ts`                                                                     | [Kernel HTTP API](./kernel-http-api.md)      |
| `runtime-agent-api-v1`  | lifecycle RPC envelope                          | takosumi runtime-agent        | `packages/runtime-agent/`, `packages/contract/`                                                                                      | [Runtime-Agent API](./runtime-agent-api.md)  |
| `reference-kinds-v1`    | Takos reference component kind descriptors      | takosumi plugins              | `packages/plugins/spec/kinds/`, `packages/plugins/src/kinds/`                                                                        | [Reference Kind Registry](./kind-catalog.md) |
| `provider-plugins-v1`   | provider plugin contract and matrix             | takosumi provider packages    | `packages/*-providers/`, `packages/plugins/`                                                                                         | [Provider plugin](./providers.md)            |
| `takosumi-jsr-packages` | JSR package exports and dependency pins         | package owners                | `packages/*/deno.json`, `packages/*/mod.ts`                                                                                          | `https://jsr.io/@takos/takosumi`             |

## Boundary rules

- AppSpec source is `.takosumi.yml`; build input, when used, is
  `.takosumi.build.yml`.
- Component kind descriptors under `packages/plugins/spec/kinds/` are Takos
  reference registry inputs, not Takosumi AppSpec contract fields.
- Installer clients submit source / expected pin to the installer endpoints.
- Build services submit prepared source snapshots with `source.kind=prepared`;
  they do not submit overlay fields or build recipes to the Installer API.
- Workflow runner, scheduler, webhook, account-plane, billing, and OIDC issuer
  are outside the kernel public surface.
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
- [BuildSpec](./build-spec.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Installer API](./installer-api.md)
- [Workflow Placement Rationale](./architecture/workflow-extension-design.md)
