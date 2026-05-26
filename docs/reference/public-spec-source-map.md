# Spec Maintenance Map {#public-spec-source-map}

This is a maintainer map, not a reader path. It lists repository source files that must move together when Takosumi public contracts or adjacent reference surfaces change.

Wire surface を変えるときは、実装 source、test、docs を同じ変更で更新します。

## Takosumi Core Spec Map

| Spec key           | Public surface                                 | Owner                       | Normative spec                       | Executable conformance targets                                                                                                                                |
| ------------------ | ---------------------------------------------- | --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core-spec-v1`     | manifest / Installation / Deployment model     | takosumi contract           | [Core Specification](./core-spec.md) | `packages/contract/src/app-spec.ts`, `packages/contract/src/installer-api.ts`                                                                                 |
| `appspec-v1`       | `.takosumi.yml` envelope / validation          | takosumi contract           | [manifest](./manifest.md)            | `packages/contract/src/app-spec.ts`, `packages/installer/src/yaml-parser.ts`                                                                                  |
| `installer-api-v1` | Installation / Deployment / rollback endpoints | takosumi kernel + installer | [Installer API](./installer-api.md)  | `packages/kernel/src/api/installer_public_routes.ts`, `packages/contract/src/installer-api.ts`, `packages/kernel/src/api/installer_public_routes_e2e_test.ts` |

`packages/installer/src/yaml-parser.ts` is the reference implementation conformance target for manifest parsing. The spec above is authoritative when implementation parser behavior is being updated.

## Public contract exports

Published examples use the scoped package name `@takos/takosumi-contract/...`. Workspace-local import aliases such as `takosumi-contract/...` are internal build conveniences and do not appear in public snippets.

| Export key                  | Status                        | Repository source                        |
| --------------------------- | ----------------------------- | ---------------------------------------- |
| `contract-root`             | public convenience entry      | `packages/contract/src/index.ts`         |
| `contract-appspec-v1`       | public manifest type contract | `packages/contract/src/app-spec.ts`      |
| `contract-installer-api-v1` | public Installer API contract | `packages/contract/src/installer-api.ts` |
| `contract-type-catalog-v1`  | public catalog helper types   | `packages/contract/src/type-catalog.ts`  |

## Reference/helper/internal subpaths

These subpaths support the reference Takosumi implementation and compatibility tooling. manifest authoring starts from `.takosumi.yml`, kind schemas, and the Installer API.

| Export key                    | Status                           | Repository source                                                       |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `contract-reference-plugin`   | reference implementation helpers | `packages/contract/src/plugin*.ts`, `provider-plugin.ts`                |
| `contract-reference-runtime`  | reference runtime-agent shape    | `packages/contract/src/runtime-agent*.ts`                               |
| `contract-reference-metadata` | reference metadata helpers       | `packages/contract/src/{error-category,shape,kernel-plugin-adapter}.ts` |
| `contract-internal-exports`   | reference internal RPC/API       | `packages/contract/src/{internal-api,internal-rpc}.ts`                  |

### Compatibility debt

These exports support old reference DTO imports and maintenance tooling. Current public docs and examples use `app-spec`, `installer-api`, or a narrow `reference/*` / `internal/*` subpath.

| Export key                      | Status                   | Repository source                           |
| ------------------------------- | ------------------------ | ------------------------------------------- |
| `contract-reference-dto-compat` | compatibility DTO export | `packages/contract/src/types.ts`            |
| `contract-legacy-compat`        | compatibility export     | `packages/contract/src/reference-compat.ts` |

## Kind Catalog Spec Map

The Takosumi Kind Catalog specification covers vocabulary published from `takosumi.com`. Operators can adopt its descriptors and output types. Operator implementations and reference runtime helpers live in the reference/operator sections. Published catalog documents live under `/kinds/v1/*` and `/contexts/v1.jsonld`. Provider-selection descriptors under kernel implementation paths are reference internal metadata.

| Key                                 | Surface                                           | Owner                                                  | Normative spec                                           | Repository source                                                                                                                                                                                                    | Published reference                                                      |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `takosumi-official-type-catalog-v1` | kind schemas / output types / projection examples | Takosumi official catalog, published from takosumi.com | [Takosumi Kind Catalog Specification](./type-catalog.md) | `packages/kind-*/spec/kind.jsonld` for portable kinds; sibling `../takosumi-plugins/packages/kind-*/spec/kind.jsonld` for native reference kinds; `spec/contexts/v1.jsonld`; `packages/contract/src/type-catalog.ts` | `/kinds/v1/<name>`, `/kinds/v1/<name>.jsonld`, and `/contexts/v1.jsonld` |

`takosumi/packages/kind-*/spec/kind.jsonld` is the repository storage path for portable package-owned kind schema source files. `takosumi-plugins/packages/kind-*/spec/kind.jsonld` stores backend-specific native reference descriptors. `spec/contexts/v1.jsonld` is the repository storage path for `https://takosumi.com/contexts/v1.jsonld`. `packages/contract/src/type-catalog.ts` mirrors the official output type, injection mode, access mode, sensitivity class, and material helper vocabulary for TypeScript callers. The public catalog surface is the published `https://takosumi.com/kinds/v1/*` and `https://takosumi.com/contexts/v1.jsonld` documents plus the catalog docs and helper types.

## Operator Profile Spec Map

These specs are maintained by operator profiles that compose the Takosumi core contract and adopted catalog vocabulary.

| Key                      | Surface                                            | Owner                       | Reader entry                          | Repository source                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------- | --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `takosumi-cloud-spec-v1` | concrete account layer publications and Cloud APIs | Takosumi Cloud distribution | [Takosumi Cloud](./takosumi-cloud.md) | sibling checkout `../takosumi-cloud/docs/ja/spec.md`, `../takosumi-cloud/docs/en/spec.md`, `operator-account-plane-profile.md`, `workload-publications.md`, `account-plane-projections.md`, and `deploy-facade.md` |

## Adjacent operator references

The following surfaces help operators run or extend the reference kernel and kind packages and reference adapters.

| Key                            | Surface                                 | Owner                                                              | Reference                                                                                                                 |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `build-service-input`          | optional build-service profile input    | build service distribution                                         | [Operator build-service profile example](../operator/build-service-profile.md); parser/service are operator profile scope |
| `kernel-route-inventory`       | internal / runtime-agent HTTP boundary  | reference kernel implementation                                    | [Reference Kernel Route Inventory](./kernel-http-api.md)                                                                  |
| `runtime-agent-envelope`       | lifecycle RPC envelope                  | operator runtime topology                                          | [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)                                                       |
| `reference-kind-binding-guide` | kind package and binding guide          | takosumi portable kind packages + takosumi-plugins native packages | [Kind Binding Implementations](./kind-bindings.md); [Kind Packages](./kind-packages.md)                                   |
| `takosumi-jsr-packages`        | JSR package exports and dependency pins | package owners                                                     | `packages/*/deno.json`, `packages/*/mod.ts`, `https://jsr.io/@takos/takosumi`                                             |

## Placement rules

- manifest source is `.takosumi.yml`; build-service input, when used, belongs to operator build service scope and is not a Takosumi core manifest.
- Component kind schema documents such as `https://takosumi.com/kinds/v1/*` can be referenced by operator alias and visibility policy. Implementation binding is configured separately by the operator or reference kernel.
- Installer clients submit source / expected guards to the installer endpoints.
- Build services submit prepared source archives with `source.kind: "prepared"`; build recipes stay in build service scope.
- asset upload / discovery docs describe an operator extension with separate credentials.
- Kernel route inventory and runtime-agent envelope pages describe the current reference implementation topology. They are not public conformance targets for compatible Takosumi installers.
- Workflow runner, scheduler, webhook, and CI automation may choose source refs or prepared source and submit them to the Installer API.
- Account layer, billing, OIDC issuer, and deploy facades are operator surfaces around ownership, grants, workload platform services, approval, ledgers, and admin automation.
- Public JSR package checks use each package's `deno.json`, not only the root workspace import map. A package that imports a contract subpath declares that subpath in its own import map or dependency metadata.

## Installer API evidence

The public Installer API surface is represented by contract DTOs, the installer public route table, and route coverage in `packages/kernel/src/api/installer_public_routes_e2e_test.ts`. The test covers the five Installer API endpoints listed in [Installer API](./installer-api.md). `/openapi.json` is a mounted process inventory; a distribution that needs a public-only OpenAPI artifact publishes it separately from that inventory.

## Drift check

- `deno task check`
- `deno task lint:json-ld`
- `deno task spec:check-drift`
- `deno test --allow-all scripts/public-spec-source-map_test.ts`

## 関連ページ

- [manifest](./manifest.md)
- [Build service handoff](./build-spec.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Installer API](./installer-api.md)
- [Workflow Placement Rationale](./architecture/workflow-extension-design.md)
