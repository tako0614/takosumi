# Spec Maintenance Map {#public-spec-source-map}

This is a maintainer map, not a reader path. It lists repository source files
that must move together when Takosumi public contracts or adjacent reference
surfaces change.

Wire surface を変えるときは、実装 source、test、docs を同じ変更で更新します。

## Takosumi Core Spec Map

| Spec key           | Public surface                                 | Owner                       | Normative spec                       | Executable conformance targets                                                                                                     |
| ------------------ | ---------------------------------------------- | --------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `core-spec-v1`     | manifest / Installation / Deployment model     | takosumi contract           | [Core Specification](./core-spec.md) | `src/contract/app-spec.ts`, `src/contract/installer-api.ts`                                                                        |
| `appspec-v1`       | `.takosumi.yml` envelope / validation          | takosumi contract           | [manifest](./manifest.md)            | `src/contract/app-spec.ts`, `src/installer/yaml-parser.ts`                                                                         |
| `installer-api-v1` | Installation / Deployment / rollback endpoints | takosumi kernel + installer | [Installer API](./installer-api.md)  | `src/kernel/api/installer_public_routes.ts`, `src/contract/installer-api.ts`, `src/kernel/api/installer_public_routes_e2e_test.ts` |

`src/installer/yaml-parser.ts` is the reference implementation
conformance target for manifest parsing. The spec above is authoritative when
implementation parser behavior is being updated.

## Public contract exports

Published examples use the npm subpath export `@takosjp/takosumi/contract`.
Workspace-local import aliases such as `takosumi-contract/...` are internal
build conveniences and do not appear in public snippets.

| Export key                  | Status                        | Repository source               |
| --------------------------- | ----------------------------- | ------------------------------- |
| `contract-root`             | public convenience entry      | `src/contract/index.ts`         |
| `contract-appspec-v1`       | public manifest type contract | `src/contract/app-spec.ts`      |
| `contract-installer-api-v1` | public Installer API contract | `src/contract/installer-api.ts` |
| `contract-catalog-v1`       | public catalog helper types   | `src/contract/catalog.ts`       |

## Reference/helper/internal subpaths

These subpaths support the reference Takosumi implementation and maintenance
tooling. manifest authoring starts from `.takosumi.yml`, kind schemas, and the
Installer API.

| Export key                    | Status                           | Repository source                             |
| ----------------------------- | -------------------------------- | --------------------------------------------- |
| `contract-reference-plugin`   | reference implementation helpers | `src/contract/plugin*.ts`                     |
| `contract-reference-runtime`  | reference runtime-agent shape    | `src/contract/runtime-agent*.ts`              |
| `contract-reference-metadata` | reference metadata helpers       | `src/contract/{error-category,shape}.ts`      |
| `contract-internal-exports`   | reference internal RPC/API       | `src/contract/{internal-api,internal-rpc}.ts` |

### Compatibility debt

These exports support older reference-kernel internals and maintenance tooling.
Current public docs and examples use `app-spec`, `installer-api`, or a narrow
`reference/*` / `internal/*` subpath.

| Export key                      | Status                   | Repository source                  |
| ------------------------------- | ------------------------ | ---------------------------------- |
| `contract-reference-dto-compat` | compatibility DTO export | `src/contract/types.ts`            |
| `contract-legacy-compat`        | compatibility export     | `src/contract/reference-compat.ts` |

## Official Catalog Spec Map

The Takosumi official catalog covers vocabulary hosted at `takosumi.com`.
Operators can adopt its descriptors and material kinds. Every descriptor — base
kinds and the descriptors that extend them via `portableBase` — lives in one
catalog at `takosumi/docs/kinds/v1/`; there is no "native" vs "portable"
category. The sibling `takosumi-plugins/` repository ships only reference
implementation bindings (it holds no descriptor source). Operator
implementations and reference runtime helpers live in the reference/operator
sections. Published catalog documents live under `/kinds/v1/*` and
`/contexts/v1.jsonld`. Provider-selection descriptors under kernel implementation
paths are reference internal metadata.

| Key                              | Surface                                                                | Owner                                             | Normative spec                                                                          | Repository source                                                                                                             | Published reference                                                      |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `takosumi-official-catalog-v1`   | kind schemas (base + extending) / material kinds / projection examples | Takosumi official catalog, hosted at takosumi.com | [Takosumi Official Catalog](./catalog.md)                                               | `docs/kinds/v1/*.jsonld` (single catalog: base + extending descriptors); `spec/contexts/v1.jsonld`; `src/contract/catalog.ts` | `/kinds/v1/<name>`, `/kinds/v1/<name>.jsonld`, and `/contexts/v1.jsonld` |
| `reference-native-kind-bindings` | backend-specific reference plugin factories and runtime bindings       | `takosumi-plugins` native kind packages           | [Kind Packages](./kind-packages.md); [Kind Binding Implementations](./kind-bindings.md) | sibling `../takosumi-plugins/packages/kind-*/mod.ts`; sibling `../takosumi-plugins/packages/runtime-agent-connectors/`        | implementation packages adopted by operator distributions                |

`takosumi/docs/kinds/v1/*.jsonld` is the repository storage path for the **single
official kind catalog** — every descriptor, both the base kinds (`worker`,
`postgres`, …) and the descriptors that extend them via `portableBase`
(`cloudflare-worker`, `aws-rds-postgres`, …). They are published spec, not
framework or plugin source: the kernel imports none of them, and
`takosumi-plugins` packages are pure implementations that consume them.
`spec/contexts/v1.jsonld` is the repository storage path for
`https://takosumi.com/contexts/v1.jsonld`.
`src/contract/catalog.ts` mirrors the official material kind, injection
mode, access mode, sensitivity class, and material helper vocabulary for
TypeScript callers. The public catalog surface is the published
`https://takosumi.com/kinds/v1/*` and `https://takosumi.com/contexts/v1.jsonld`
documents plus the catalog docs and helper types. Reference plugin factories and
connector implementations are implementation packages; they are not part of the
AppSpec core contract.

## Operator Profile Spec Map

These specs are maintained by operator distributions that compose the Takosumi
core contract and adopted catalog vocabulary.

| Key                      | Surface                                                                           | Owner                       | Reader entry                          | Repository source                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- | --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `takosumi-cloud-spec-v1` | Cloud workload platform service paths, account-management APIs, and deploy facade | Takosumi Cloud distribution | [Takosumi Cloud](./takosumi-cloud.md) | sibling checkout `../takosumi-cloud/docs/ja/spec.md`, `../takosumi-cloud/docs/en/spec.md`, `operator-account-plane-profile.md`, `workload-platform-services.md`, `account-plane-projections.md`, and `deploy-facade.md` |

## Adjacent operator references

The following surfaces help operators run or extend the reference kernel and
kind packages and reference adapters.

| Key                            | Surface                                 | Owner                                                              | Reference                                                                                                                      |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `build-service-input`          | optional build-service profile input    | build service distribution                                         | [Operator build-service profile example](../operator/build-service-profile.md); parser/service are operator distribution scope |
| `kernel-route-inventory`       | internal / runtime-agent HTTP boundary  | reference kernel implementation                                    | [Reference Kernel Route Inventory](./kernel-http-api.md)                                                                       |
| `runtime-agent-envelope`       | lifecycle RPC envelope                  | operator runtime topology                                          | [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)                                                            |
| `reference-kind-binding-guide` | kind package and binding guide          | takosumi portable kind packages + takosumi-plugins native packages | [Kind Binding Implementations](./kind-bindings.md); [Kind Packages](./kind-packages.md)                                        |
| `takosumi-npm-package`         | npm subpath exports and dependency pins | package owners                                                     | `package.json`, `tsconfig.json`, `src/all/*.ts`, `scripts/build-npm.ts`, `https://www.npmjs.com/package/@takosjp/takosumi`     |

## Placement rules

- manifest source is `.takosumi.yml`; build-service input, when used, belongs to
  operator build service scope and is not a Takosumi core manifest.
- Component kind schema documents such as `https://takosumi.com/kinds/v1/*` can
  be referenced by operator alias and visibility policy. Implementation binding
  is configured separately by the operator or reference kernel.
- Installer clients submit source / expected guards to the installer endpoints.
- Build services submit prepared source archives with `source.kind: "prepared"`;
  build recipes stay in build service scope.
- asset upload / discovery docs describe an operator extension with separate
  credentials.
- Kernel route inventory and runtime-agent envelope pages describe the current
  reference implementation topology. They are not public conformance targets for
  compatible Takosumi installers.
- Workflow runner, scheduler, webhook, and CI automation may choose source refs
  or prepared source and submit them to the Installer API.
- Account layer, billing, OIDC issuer, and deploy facades are operator surfaces
  around ownership, grants, workload platform services, approval, ledgers, and
  admin automation.
- npm subpath export checks use each package's `package.json` and the npm build
  manifest, plus `tsconfig.json` for workspace-local source aliases. A package
  that imports a contract subpath declares that subpath in package metadata or a
  local compiler path.

## Installer API evidence

The public Installer API surface is represented by contract DTOs, the installer
public route table, and route coverage in
`src/kernel/api/installer_public_routes_e2e_test.ts`. The test covers
the five Installer API endpoints listed in [Installer API](./installer-api.md).
`/openapi.json` is a mounted process inventory; a distribution that needs a
public-only OpenAPI artifact publishes it separately from that inventory.

## Drift check

- `bun run check`
- `bun run lint:json-ld`
- `bun run test:scripts`

## 関連ページ

- [manifest](./manifest.md)
- [Build service handoff](./build-spec.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Installer API](./installer-api.md)
- [Workflow Placement Rationale](./architecture/workflow-extension-design.md)
