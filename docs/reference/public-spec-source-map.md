# Public Spec Source Map

> このページでわかること: public surface ごとの source of truth / 公開 reference
> / drift check の対応表。

public shape が変わったら、 所有 source と下記行を同じ変更で更新します。 wire /
package surface ではドキュメントのみの更新では不十分です。

## Map

| Spec key                | Public surface                                                                                 | Owner                       | Source of truth                                                                                                                                                                                                                                                                                                                                                        | Published reference                                                                                                                                                                                                                                  | Drift check                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest-v1`           | Takosumi v1 manifest envelope and validation                                                   | takosumi kernel             | `packages/kernel/src/domains/deploy/_internal_manifest_types.ts`; `packages/kernel/src/domains/deploy/manifest_v1.ts`                                                                                                                                                                                                                                                  | `https://docs.takosumi.com/manifest`; `https://docs.takosumi.com/reference/manifest-validation`                                                                                                                                                      | `packages/kernel/src/domains/deploy/manifest_v1_test.ts`; `scripts/public-spec-source-map_test.ts`                                                                                                         |
| `shape-catalog-v1`      | Bundled component kinds, provider matrix, templates, artifact kinds                            | takosumi plugins            | `packages/plugins/src/kinds/`; `packages/plugins/src/shape-providers/`; `packages/plugins/src/templates/`; `packages/plugins/src/shape-providers/_artifact_kinds_bundled.ts`                                                                                                                                                                                           | `https://docs.takosumi.com/reference/component-kind-catalog`; `https://docs.takosumi.com/reference/providers`; `https://docs.takosumi.com/reference/templates`; `https://docs.takosumi.com/reference/artifact-kinds`                                 | `packages/plugins/tests/shape_registration_test.ts`; `packages/plugins/tests/shape_provider_batch_test.ts`; `packages/plugins/tests/artifact_kinds_docs_test.ts`; `scripts/public-spec-source-map_test.ts` |
| `kernel-http-api-v1`    | Public installer, artifact, internal control, runtime-agent control, health/readiness, OpenAPI | takosumi kernel             | `packages/kernel/src/api/app.ts`; `packages/kernel/src/api/public_routes.ts`; `packages/kernel/src/api/installer_public_routes.ts`; `packages/kernel/src/api/artifact_routes.ts`; `packages/kernel/src/api/internal_routes.ts`; `packages/kernel/src/api/runtime_agent_routes.ts`; `packages/kernel/src/api/readiness_routes.ts`; `packages/kernel/src/api/openapi.ts` | `https://docs.takosumi.com/reference/kernel-http-api`; `https://docs.takosumi.com/reference/runtime-agent-api`; `https://docs.takosumi.com/reference/installer-api`                                                                                  | `packages/kernel/src/api/*_test.ts`; `packages/kernel/src/api/installer_public_routes_e2e_test.ts`; `scripts/public-spec-source-map_test.ts`                                                               |
| `installer-api-v1`      | Installer 5 endpoint API: Installation dry-run/apply, Deployment dry-run/apply, rollback       | takosumi kernel + installer | `packages/kernel/src/api/installer_public_routes.ts` (`INSTALLER_INSTALLATIONS_PATH`); `packages/kernel/src/api/openapi.ts` (`dryRunInstallation`); `packages/contract/src/installer-api.ts`; `packages/kernel/src/domains/installer/mod.ts`; `packages/installer/src/yaml-parser.ts`                                                                                  | `https://docs.takosumi.com/reference/kernel-http-api`; `https://docs.takosumi.com/reference/installer-api`; `https://jsr.io/@takos/takosumi-contract`                                                                                                | `scripts/public-spec-source-map_test.ts`; `packages/kernel/src/api/installer_public_routes_test.ts`; `packages/kernel/src/api/installer_public_routes_e2e_test.ts`                                         |
| `takosumi-jsr-packages` | JSR package exports and dependency pins                                                        | takosumi package owners     | `packages/*/deno.json`; package entrypoints under `packages/*/src/` or `packages/all/*.ts`                                                                                                                                                                                                                                                                             | `https://jsr.io/@takos/takosumi`; `https://jsr.io/@takos/takosumi-kernel`; `https://jsr.io/@takos/takosumi-plugins`; `https://jsr.io/@takos/takosumi-cli`; `https://jsr.io/@takos/takosumi-runtime-agent`; `https://jsr.io/@takos/takosumi-contract` | `deno task publish:dry-run`; `scripts/jsr-publish-dry-run_test.ts`                                                                                                                                         |

## Boundary Rules

- kernel は manifest を明示的 path または HTTP body でのみ受け取り、
  `.takosumi/` を discover せず、 workflow file を読まず、 build を実行せず、
  `workflowRef` を受け付けず、 workflow trigger route を公開しません。
- upstream client は installer 5 endpoint に AppSpec source / expected pin を
  渡します。 kernel は dry-run response と Installation / Deployment record を
  返しますが、 provenance が kernel 所有の workflow / git 語彙を作ることはあり
  ません。
- `workflowRef` / `.takosumi/workflows/*` / `${artifacts.*}` は current AppSpec
  には存在しません。 artifact build は `component.build` の最小 recipe と
  provider output で表現します。
- public JSR package check は root workspace import map ではなく package の
  `deno.json` を使い、 古い publish 済依存 pin を捕捉します。
- 真実の source が本 repo 外にある行は、 所有 repo とそこの test location を
  名指しします。 本 repo の drift test は Takosumi 所有 path と cross-repo 所
  有レコードの存在を検証します。

## 関連ページ

- [Manifest](/manifest)
- [Kernel HTTP API](/reference/kernel-http-api)
- [Installer API](/reference/installer-api)
- [Workflow Placement Rationale](/reference/architecture/workflow-extension-design)
