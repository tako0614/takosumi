# Provider Plugins

> このページでわかること: bundled provider plugin の一覧と対応 shape。

**provider plugin** は v1 単位で [Shape](/reference/shapes) を具体的な cloud / local backend 上に materialize する。 各 plugin は実装する shape、サポートする capability vocabulary、 kernel が OperationPlan 実行中に呼ぶ apply / destroy / status lifecycle を宣言する。

Takosumi は out of the box で **21 個の provider plugin** を ship する。 20 は default で配線され、1 個 (`@takos/deno-deploy`) は opt-in。 plugin は paper-thin な lifecycle client であり、 credential、cloud SDK code、副作用はすべて **runtime-agent** の背後に住む。 manifest 層では `connector:<id>` として識別する。 operator が agent 上で connector を install / control するため、 ある deployment から到達可能な provider は operator が所有する (operator-installed / operator-controlled は意図的)。

Source roots:

- `packages/contract/src/provider-plugin.ts` — public `ProviderPlugin` contract と `registerProvider` registry。
- `packages/plugins/src/shape-providers/<shape>/<provider>.ts` — 個別 plugin。
- `packages/plugins/src/shape-providers/factories.ts` — production wiring、 `createTakosumiProductionProviders(opts)` として exposed。

## Capability vocabulary: open string + reserved prefix

capability は **open string**。 provider は `capabilities` 配列に任意の kebab-case 識別子を宣言でき、 manifest は任意の識別子を `requires` で参照できる。 selection は subset 所属だけをチェックする: provider が selectable なのは `requires ⊆ capabilities` の場合に限る。

global vocabulary を一貫させるため、3 prefix が **reserved**。

| Prefix       | Owner                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `takos.*`    | consumer-application reserved namespace (e.g. Takos product surface); kernel assumes no Takos-specific semantics |
| `system.*`   | Takosumi kernel / runtime-agent / observation tier                                                               |
| `operator.*` | Operator-defined deployment-local capabilities                                                                   |

bare identifier (no `.`) は任意 provider が宣言できる **general capability**。 新 reserved prefix の追加は `CONVENTIONS.md` §6 RFC で governed され、 kernel coordination を要する。 既存 reserved prefix 内では、 `takos.*` / `system.*` 下の識別子追加も §6 RFC を通る。 `operator.*` は自 deployment 内で operator が自由に定義できる。

## Bundled provider catalog

同梱されている 21 個の provider をクラウド別にグルーピング。 すべて `@takos/<cloud>-*` 形式の id を持つ。 shape と capability 集合は `packages/plugins/src/shape-providers/factories.ts` と完全に一致する。 **extension policy** 列は、サードパーティが標準の provider PR フローで capability を追加してよいか (extensible)、 あるいは in-tree provider 内で capability 集合が閉じているか (closed-within-provider) を示す。

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

manifest resource ごとに、kernel は `id` が `provider:` に一致 (set されているとき) し、 かつ `capabilities` が `requires` の superset である plugin を選ぶ。 宣言集合が `requires` を満たさない provider を指名する request は、 apply lifecycle が走る前の validation 時点で reject される。

## Deno Deploy opt-in flow

`@takos/deno-deploy` は default factory output から除外されている。 online 化は 2 ステップ。

1. **runtime-agent に connector を register**。 agent host で `TAKOSUMI_AGENT_DENO_DEPLOY_TOKEN` (および optional `TAKOSUMI_AGENT_DENO_DEPLOY_ORG`、`TAKOSUMI_AGENT_DENO_DEPLOY_PROJECT`) を set して、 agent の `ConnectorBootOptions` が起動時に Deno Deploy connector を resolve するようにする。 credential は agent だけが保持し、kernel は token を見ない。
2. **kernel 側 wrapper を有効化**。 `createTakosumiProductionProviders(opts)` に `enableDenoDeploy: true` を渡す。 wrapper plugin は `worker@v1` に対して register され、 manifest から selectable になる。

検証は `provider: "@takos/deno-deploy"` の `worker@v1` apply を発行する。 kernel は apply lifecycle envelope を記録し、 agent は inject された token を使って Deno Deploy API に forward し、 返ってきた `WorkerOutputs` (`url`、`scriptName`、optional `version`) が apply result を通って戻る。

## Public API surface

`registerProvider` エントリポイント (source は `packages/contract/src/provider-plugin.ts`) は、 in-process registry に plugin を install する v1 の方法。

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

Required fields: `id`、`version`、`implements`、`capabilities`、`apply`、`destroy`、`status`。 `validate` は optional。 `registerProvider` は同じ `id` が置き換えられた場合に直前の登録を返す。 `{ allowOverride: true }` を渡すと collision warning が抑制される。 `PlatformContext` は tenant-scoped secret store、KMS port、object storage port、observability sink、 `${ref:...}` resolution で使われる resolved-output map を運ぶ。

## Cross-references

- [Access Modes](/reference/access-modes) — provider 管理 object が consumer に自身を expose する仕方を支配する closed v1 access mode enum (`read` / `read-write` / `admin` / `invoke-only` / `observe-only`)。
- [Artifact Kinds](/reference/artifact-kinds) — bundled DataAsset kinds (`oci-image` / `js-bundle` / `lambda-zip` / `static-bundle` / `wasm`) と provider が apply 時に受け取る registry。
- [Connector Contract](/reference/connector-contract) — operator-installed connector identity (`connector:<id>`)、accepted-kind vector、Space visibility、signing expectations、provider が consume する envelope versioning。
- [Closed Enums](/reference/closed-enums) — object lifecycle class と provider が output 発行時に尊重すべき closed enum。
- `CONVENTIONS.md` §6 RFC (takosumi repo root) — 新 reserved capability prefix の提案プロセス、 shape-level capability union への変更プロセス。

## 関連ページ

- [Shape Catalog](/reference/shapes)
- [Connector Contract](/reference/connector-contract)
- [Access Modes](/reference/access-modes)
