# Provider Plugins

> このページでわかること: bundled provider plugin の一覧と対応 shape。

A **provider plugin** is the v1 unit that materializes a
[Shape](/reference/shapes) on a concrete cloud or local backend. Each plugin
declares the shape it implements, the capability vocabulary it supports, and the
apply / destroy / status lifecycle that the kernel calls during an OperationPlan
execution.

Takosumi ships **21 provider plugins** out of the box: 20 are wired by default
and 1 (`@takos/deno-deploy`) is opt-in. Plugins are paper-thin lifecycle
clients; all credentials, cloud SDK code, and side effects live behind the
**runtime-agent**, identified at the manifest layer as `connector:<id>`.
Operators install and control connectors on the agent, so they own which
provider is reachable from a given deployment (operator-installed /
operator-controlled intentionally).

Source roots:

- `packages/contract/src/provider-plugin.ts` — the public `ProviderPlugin`
  contract and the `registerProvider` registry.
- `packages/plugins/src/shape-providers/<shape>/<provider>.ts` — individual
  plugins.
- `packages/plugins/src/shape-providers/factories.ts` — production wiring,
  exposed as `createTakosumiProductionProviders(opts)`.

## Capability vocabulary: open string + reserved prefix

capability は **open string** である。provider は `capabilities` 配列に任意の
kebab-case 識別子を宣言でき、manifest は任意の識別子を `requires` で参照できる。
選択は subset の所属だけをチェックする: provider が選択可能なのは
`requires ⊆ capabilities` の場合に限る。

To keep the global vocabulary coherent, three prefixes are **reserved**:

| Prefix       | Owner                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `takos.*`    | consumer-application reserved namespace (e.g. Takos product surface); kernel assumes no Takos-specific semantics |
| `system.*`   | Takosumi kernel / runtime-agent / observation tier                                                               |
| `operator.*` | Operator-defined deployment-local capabilities                                                                   |

A bare identifier (no `.`) is a **general capability** that any provider may
declare. Adding a new reserved prefix is governed by `CONVENTIONS.md` §6 RFC and
requires kernel coordination. Within the existing reserved prefixes, adding a
new identifier under `takos.*` or `system.*` also goes through the §6 RFC;
`operator.*` is free for the operator to define within their own deployment.

## Bundled provider catalog

同梱されている 21 個の provider をクラウド別にグルーピング。Shape と capability
集合は `packages/plugins/src/shape-providers/factories.ts` と完全に一致する。
**extension policy** 列は、サードパーティが標準の provider PR フローで
capability を追加してよいか (extensible)、あるいは in-tree provider 内で
capability 集合が 閉じているか (closed-within-provider) を示す。

### AWS

| provider id          | shape                  | declared capabilities                                                                                                                   | extension policy |
| -------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@takos/aws-s3`      | `object-store@v1`      | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` | extensible       |
| `@takos/aws-fargate` | `web-service@v1`       | `always-on`, `websocket`, `long-request`, `sticky-session`, `private-networking`                                                        | extensible       |
| `@takos/aws-rds`     | `database-postgres@v1` | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   | extensible       |
| `@takos/aws-route53` | `custom-domain@v1`     | `wildcard`, `auto-tls`, `sni`, `alpn-acme`                                                                                              | extensible       |

### GCP

| provider id            | shape                  | declared capabilities                                                                                                                   | extension policy |
| ---------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@takos/gcp-gcs`       | `object-store@v1`      | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` | extensible       |
| `@takos/gcp-cloud-run` | `web-service@v1`       | `always-on`, `scale-to-zero`, `websocket`, `long-request`                                                                               | extensible       |
| `@takos/gcp-cloud-sql` | `database-postgres@v1` | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                   | extensible       |
| `@takos/gcp-cloud-dns` | `custom-domain@v1`     | `wildcard`, `auto-tls`, `sni`                                                                                                           | extensible       |

### Cloudflare

| provider id                   | shape              | declared capabilities                                       | extension policy |
| ----------------------------- | ------------------ | ----------------------------------------------------------- | ---------------- |
| `@takos/cloudflare-r2`        | `object-store@v1`  | `presigned-urls`, `public-access`, `multipart-upload`       | extensible       |
| `@takos/cloudflare-container` | `web-service@v1`   | `scale-to-zero`, `geo-routing`                              | extensible       |
| `@takos/cloudflare-workers`   | `worker@v1`        | `scale-to-zero`, `websocket`, `long-request`, `geo-routing` | extensible       |
| `@takos/cloudflare-dns`       | `custom-domain@v1` | `wildcard`, `auto-tls`, `sni`, `http3`                      | extensible       |

### Azure

| provider id                   | shape            | declared capabilities                                     | extension policy |
| ----------------------------- | ---------------- | --------------------------------------------------------- | ---------------- |
| `@takos/azure-container-apps` | `web-service@v1` | `always-on`, `scale-to-zero`, `websocket`, `long-request` | extensible       |

### Kubernetes

| provider id                    | shape            | declared capabilities                                          | extension policy |
| ------------------------------ | ---------------- | -------------------------------------------------------------- | ---------------- |
| `@takos/kubernetes-deployment` | `web-service@v1` | `always-on`, `websocket`, `long-request`, `private-networking` | extensible       |

### Deno Deploy (opt-in)

| provider id          | shape       | declared capabilities                          | extension policy |
| -------------------- | ----------- | ---------------------------------------------- | ---------------- |
| `@takos/deno-deploy` | `worker@v1` | `scale-to-zero`, `long-request`, `geo-routing` | extensible       |

### Selfhost

| provider id                      | shape                  | declared capabilities                                                                                            | extension policy       |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@takos/selfhost-filesystem`     | `object-store@v1`      | `presigned-urls`                                                                                                 | closed-within-provider |
| `@takos/selfhost-minio`          | `object-store@v1`      | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `lifecycle-rules`, `multipart-upload` | extensible             |
| `@takos/selfhost-docker-compose` | `web-service@v1`       | `always-on`, `websocket`, `long-request`, `sticky-session`                                                       | extensible             |
| `@takos/selfhost-systemd`        | `web-service@v1`       | `always-on`, `long-request`                                                                                      | closed-within-provider |
| `@takos/selfhost-postgres`       | `database-postgres@v1` | `ssl-required`, `extensions`                                                                                     | closed-within-provider |
| `@takos/selfhost-coredns`        | `custom-domain@v1`     | `wildcard`                                                                                                       | closed-within-provider |

## Selection rule

For each manifest resource, the kernel picks the plugin whose `id` matches
`provider:` (when set) and whose `capabilities` is a superset of `requires`. A
request that names a provider whose declared set does not satisfy `requires` is
rejected at validation time, before any apply lifecycle runs.

## Deno Deploy opt-in flow

`@takos/deno-deploy` is excluded from the default factory output. Bringing it
online is a two-step opt-in.

1. **Register the connector on the runtime-agent.** On the agent host set
   `TAKOSUMI_AGENT_DENO_DEPLOY_TOKEN` (and optional
   `TAKOSUMI_AGENT_DENO_DEPLOY_ORG`, `TAKOSUMI_AGENT_DENO_DEPLOY_PROJECT`) so
   the agent's `ConnectorBootOptions` resolves a Deno Deploy connector at
   startup. The credential is held by the agent only; the kernel never sees the
   token.
2. **Enable the kernel-side wrapper.** Pass `enableDenoDeploy: true` to
   `createTakosumiProductionProviders(opts)`. The wrapper plugin is then
   registered against `worker@v1` and selectable from manifests.

Verify the chain by issuing a `worker@v1` apply with
`provider:
"@takos/deno-deploy"`. The kernel records the apply lifecycle
envelope, the agent forwards to the Deno Deploy API using the injected token,
and the returned `WorkerOutputs` (`url`, `scriptName`, optional `version`) flow
back through the apply result.

## Public API surface

`registerProvider` エントリポイント (source は
`packages/contract/src/provider-plugin.ts`) は、in-process registry に plugin を
インストールする v1 の方法である。

```ts
function registerProvider(
  provider: ProviderPlugin,
  options?: RegisterProviderOptions,
): ProviderPlugin | undefined;
```

`ProviderPlugin` の形:

```ts
interface ProviderPlugin<Spec, Outputs, Capability extends string = string> {
  readonly id: string; // e.g. "@takos/aws-s3"
  readonly version: string; // semver
  readonly implements: ShapeRef; // { id, version }
  readonly capabilities: readonly Capability[];
  validate?(spec: Spec, issues: ProviderValidationIssue[]): void;
  apply(spec: Spec, ctx: PlatformContext): Promise<ApplyResult<Outputs>>;
  destroy(handle: ResourceHandle, ctx: PlatformContext): Promise<void>;
  status(
    handle: ResourceHandle,
    ctx: PlatformContext,
  ): Promise<ResourceStatus<Outputs>>;
}
```

Required fields: `id`, `version`, `implements`, `capabilities`, `apply`,
`destroy`, `status`. `validate` is optional. `registerProvider` returns the
prior registration when the same `id` is replaced; passing
`{ allowOverride: true }` suppresses the collision warning. The
`PlatformContext` carries the tenant-scoped secret store, KMS port, object
storage port, observability sink, and the resolved-output map used by
`${ref:...}` resolution.

## Cross-references

- [Access Modes](/reference/access-modes) — closed v1 access mode enum (`read` /
  `read-write` / `admin` / `invoke-only` / `observe-only`) governing how
  provider-managed objects expose themselves to consumers.
- [Artifact Kinds](/reference/artifact-kinds) — bundled DataAsset kinds
  (`oci-image` / `js-bundle` / `lambda-zip` / `static-bundle` / `wasm`) and the
  registry that providers receive at apply time.
- [Connector Contract](/reference/connector-contract) — operator-installed
  connector identity (`connector:<id>`), accepted-kind vector, Space visibility,
  signing expectations, and envelope versioning that providers consume.
- [Closed Enums](/reference/closed-enums) — object lifecycle classes and the
  closed enums providers must respect when emitting outputs.
- `CONVENTIONS.md` §6 RFC (at the takosumi repo root) — process for proposing
  new reserved capability prefixes and for changes to the shape-level capability
  union.

## 関連ページ

- [Shape Catalog](/reference/shapes)
- [Connector Contract](/reference/connector-contract)
- [Access Modes](/reference/access-modes)
