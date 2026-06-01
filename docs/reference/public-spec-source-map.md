# Spec Maintenance Map {#public-spec-source-map}

This is a maintainer map, not a reader path. It lists repository source files
that must move together when Takosumi public contracts or adjacent reference
surfaces change.

Wire surface を変えるときは、実装 source、test、docs を同じ変更で更新します。

## Takosumi Core Spec Map

| Spec key | Public surface | Owner | Normative spec | Executable conformance targets |
| --- | --- | --- | --- | --- |
| `core-spec-v1` | Source / Installation / Deployment / PlatformService model | takosumi contract | [Core Specification](./core-spec.md) | `src/contract/installer-api.ts`, `src/kernel/domains/installer/` |
| `installer-api-v1` | Installation / Deployment / rollback endpoints | takosumi kernel + installer | [Installer API](./installer-api.md) | `src/kernel/api/installer_public_routes.ts`, `src/contract/installer-api.ts`, `src/kernel/api/installer_public_routes_e2e_test.ts` |
| `source-contract-v1` | git / prepared / local source input and identity guards | takosumi installer | [Core Specification](./core-spec.md) | `src/installer/`, `src/kernel/adapters/source/immutable_source.ts` |
| `platform-service-v1` | operator inventory binding snapshot | takosumi contract + operator distribution | [Platform Services](./platform-services.md) | `src/contract/installer-api.ts`, `src/kernel/domains/installer/platform_services_test.ts` |

Takosumi v1 has no source DSL conformance target. Historical source-file
authoring docs remain only on retired or RFC pages and are not part of this
current spec map.

## Public Contract Exports

Published examples use the npm subpath export `@takosjp/takosumi/contract`.
Workspace-local import aliases such as `takosumi-contract/...` are internal
build conveniences and do not appear in public snippets.

| Export key | Status | Repository source |
| --- | --- | --- |
| `contract-root` | public convenience entry | `src/contract/index.ts` |
| `contract-installer-api-v1` | public Installer API contract | `src/contract/installer-api.ts` |

## Reference / Helper / Internal Subpaths

These subpaths support the reference Takosumi implementation and maintenance
tooling. They are not Source authoring vocabulary.

| Export key | Status | Repository source |
| --- | --- | --- |
| `contract-reference-plugin` | reference implementation helpers | `src/contract/plugin*.ts` |
| `contract-reference-runtime` | reference runtime-agent shape | `src/contract/runtime-agent*.ts` |
| `contract-reference-catalog` | reference adapter metadata helpers | `src/contract/catalog.ts` |
| `contract-reference-metadata` | reference metadata helpers | `src/contract/{error-category,shape}.ts` |
| `contract-internal-exports` | reference internal RPC/API | `src/contract/{internal-api,internal-rpc}.ts` |

### Compatibility Debt

These exports support older reference-kernel internals and maintenance tooling.
Current public docs and examples use `installer-api` or a narrow `reference/*` /
`internal/*` subpath.

| Export key | Status | Repository source |
| --- | --- | --- |
| `contract-reference-dto-compat` | compatibility DTO export | `src/contract/types.ts` |
| `contract-legacy-compat` | compatibility export | `src/contract/reference-compat.ts` |

## Adapter Metadata Map

Reference adapter metadata lives in `takosumi/docs/kinds/v1/` and is consumed by
`takosumi-plugins/` generation and validation. It is compatibility metadata for
operator-selected adapters, not a Takosumi source authoring contract.

| Key | Surface | Owner | Normative reference | Repository source | Published reference |
| --- | --- | --- | --- | --- | --- |
| `reference-adapter-metadata-v1` | adapter metadata / material helper vocabulary | reference implementation maintainers | [Reference Backend Binding](./kind-bindings.md) | `docs/kinds/v1/*.jsonld`, `spec/contexts/v1.jsonld`, `src/contract/catalog.ts` | `/kinds/v1/<name>.jsonld`, `/contexts/v1.jsonld` |
| `reference-adapter-guide` | backend adapter and connector guide | `takosumi-plugins` implementation subpaths | [Reference Backend Packages](./kind-packages.md); [Reference Backend Binding](./kind-bindings.md) | sibling `../takosumi-plugins/packages/kind-*/mod.ts`, sibling `../takosumi-plugins/packages/runtime-agent-connectors/` | implementation subpaths adopted by operator distributions |

## Operator Profile Spec Map

These specs are maintained by operator distributions that compose the Takosumi
core contract.

| Key | Surface | Owner | Reader entry | Repository source |
| --- | --- | --- | --- | --- |
| `takosumi-spec-v1` | Takosumi Accounts workload PlatformService paths, account-management APIs, and deploy facade | Takosumi distribution | [Takosumi](./accounts.md) | sibling checkout `../takosumi/docs/accounts/ja/spec.md`, `../takosumi/docs/accounts/en/spec.md`, `operator-account-plane-profile.md`, `workload-platform-services.md`, `account-plane-projections.md`, and `deploy-facade.md` |

## Adjacent Operator References

| Key | Surface | Owner | Reference |
| --- | --- | --- | --- |
| `build-service-input` | optional build-service prepared source input | build service distribution | [Operator build-service profile example](../operator/build-service-profile.md) |
| `kernel-route-inventory` | internal / runtime-agent HTTP boundary | reference kernel implementation | [Reference Kernel Route Inventory](./kernel-http-api.md) |
| `runtime-agent-envelope` | lifecycle RPC envelope | operator runtime topology | [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md) |
| `takosumi-npm-package` | npm subpath exports and dependency pins | package owners | `package.json`, `tsconfig.json`, `src/all/*.ts`, `scripts/build-npm-bun.ts`, `https://www.npmjs.com/package/@takosjp/takosumi` |

## Placement Rules

- Source identity comes from git / prepared / local Source input.
- Build-service input, when used, belongs to operator build service scope and is
  not Takosumi core source metadata.
- Backend adapter docs can be referenced by operator profile and visibility
  policy. Implementation binding is configured separately by the operator or
  reference kernel.
- Installer clients submit Source / expected guards to the installer endpoints.
- Build services submit prepared source archives with `source.kind:
  "prepared"`.
- Kernel route inventory and runtime-agent envelope pages describe the current
  reference implementation topology. They are not public conformance targets for
  compatible Takosumi installers.
- Account layer, billing, OIDC issuer, deploy facades, and PlatformService
  inventory are operator surfaces around ownership, grants, workload platform
  services, approval, ledgers, and admin automation.

## Installer API Evidence

The public Installer API surface is represented by contract DTOs, the installer
public route table, and route coverage in
`src/kernel/api/installer_public_routes_e2e_test.ts`. The test covers the five
Installer API endpoints listed in [Installer API](./installer-api.md).

## Drift Check

- `bun run check`
- `bun run lint:json-ld`
- `bun run test:scripts`

## Related Pages

- [Core Specification](./core-spec.md)
- [Build service handoff](./build-spec.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
