# Provider Plugins

`takosumi` は curated [Shape](/reference/shapes) を実装する **21 個の provider
plugin (default-on 20 + opt-in 1)** を bundle しています。各 provider は
`ProviderPlugin<Spec, Outputs>` を返す factory として
`packages/plugins/src/shape-providers/<shape>/<provider-id>.ts` に実装され、
`createTakosumiProductionProviders(opts)` 経由で operator が wire-in します
([Operator Bootstrap](/operator/bootstrap))。

## Provider plugin の構造

```ts
interface ProviderPlugin<Spec, Outputs> {
  readonly id: string; // e.g. "@takos/aws-s3"
  readonly version: string; // semver
  readonly implements: { id: string; version: string }; // shape ref
  readonly capabilities: readonly string[]; // declared capability set
  validate?(spec: Spec, issues: ProviderValidationIssue[]): void;
  apply(spec: Spec, ctx: PlatformContext): Promise<ApplyResult<Outputs>>;
  destroy(handle: ResourceHandle, ctx: PlatformContext): Promise<void>;
  status(
    handle: ResourceHandle,
    ctx: PlatformContext,
  ): Promise<ResourceStatus<Outputs>>;
}
```

各 provider は **lifecycle client** (`<Provider>LifecycleClient`) を inject
されます。テストでは `InMemory<Provider>Lifecycle`、production では
`factories.ts` 内の **gateway adapter** が wire されます (operator gateway を
HTTP で叩く)。lifecycle adapter が credential を直接保持することはありません。

source 一覧:
[`packages/plugins/src/shape-providers/`](https://github.com/takos-jp/takosumi/tree/main/packages/plugins/src/shape-providers)

## AWS (4 providers)

| provider id           | shape               | declared capabilities                                                                                                                   |
| --------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@takos/aws-s3`       | `object-store@v1`   | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/aws-fargate`  | `web-service@v1`    | `always-on`, `websocket`, `long-request`, `sticky-session`, `private-networking`                                                        |
| `@takos/aws-rds`      | `database-postgres@v1` | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions`                                                |
| `@takos/aws-route53`  | `custom-domain@v1`  | `wildcard`, `auto-tls`, `sni`, `alpn-acme`                                                                                              |

## GCP (4 providers)

| provider id              | shape                  | declared capabilities                                                                 |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------- |
| `@takos/gcp-gcs`         | `object-store@v1`      | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `event-notifications`, `lifecycle-rules`, `multipart-upload` |
| `@takos/gcp-cloud-run`   | `web-service@v1`       | `always-on`, `scale-to-zero`, `websocket`, `long-request`                             |
| `@takos/gcp-cloud-sql`   | `database-postgres@v1` | `pitr`, `read-replicas`, `high-availability`, `backups`, `ssl-required`, `extensions` |
| `@takos/gcp-cloud-dns`   | `custom-domain@v1`     | `wildcard`, `auto-tls`, `sni`                                                         |

## Cloudflare (4 providers)

| provider id                  | shape              | declared capabilities                                          |
| ---------------------------- | ------------------ | -------------------------------------------------------------- |
| `@takos/cloudflare-r2`       | `object-store@v1`  | `presigned-urls`, `public-access`, `multipart-upload`          |
| `@takos/cloudflare-container`| `web-service@v1`   | `scale-to-zero`, `geo-routing`                                 |
| `@takos/cloudflare-workers`  | `worker@v1`        | `scale-to-zero`, `websocket`, `long-request`, `geo-routing`, `crons` |
| `@takos/cloudflare-dns`      | `custom-domain@v1` | `wildcard`, `auto-tls`, `sni`, `http3`                         |

## Azure (1 provider)

| provider id                   | shape            | declared capabilities                                     |
| ----------------------------- | ---------------- | --------------------------------------------------------- |
| `@takos/azure-container-apps` | `web-service@v1` | `always-on`, `scale-to-zero`, `websocket`, `long-request` |

## Kubernetes (1 provider)

| provider id                   | shape            | declared capabilities                                          |
| ----------------------------- | ---------------- | -------------------------------------------------------------- |
| `@takos/kubernetes-deployment`| `web-service@v1` | `always-on`, `websocket`, `long-request`, `private-networking` |

## Deno Deploy (1 provider, opt-in)

`@takos/deno-deploy` は default では **無効** で、`enableDenoDeploy: true` を
`TakosumiProductionProviderOptions` に渡したときだけ wire されます。runtime-agent
側で Deno Deploy connector が登録済みである必要があります。

| provider id          | shape       | declared capabilities                          |
| -------------------- | ----------- | ---------------------------------------------- |
| `@takos/deno-deploy` | `worker@v1` | `scale-to-zero`, `long-request`, `geo-routing` |

## Selfhost (6 providers)

| provider id                    | shape                  | declared capabilities                                                                                            |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@takos/selfhost-filesystem`   | `object-store@v1`      | `presigned-urls`                                                                                                 |
| `@takos/selfhost-minio`        | `object-store@v1`      | `versioning`, `presigned-urls`, `server-side-encryption`, `public-access`, `lifecycle-rules`, `multipart-upload` |
| `@takos/selfhost-docker-compose` | `web-service@v1`     | `always-on`, `websocket`, `long-request`, `sticky-session`                                                       |
| `@takos/selfhost-systemd`      | `web-service@v1`       | `always-on`, `long-request`                                                                                      |
| `@takos/selfhost-postgres`     | `database-postgres@v1` | `ssl-required`, `extensions`                                                                                     |
| `@takos/selfhost-coredns`      | `custom-domain@v1`     | `wildcard`                                                                                                       |

## Provider selection と `requires:`

manifest の `resources[].requires` は **このリソースが必要とする capability** を
declarative に書きます。kernel は `requires` を満たさない provider を
選択しません。例:

```yaml
resources:
  - shape: object-store@v1
    name: assets
    provider: "@takos/cloudflare-r2"
    requires: [presigned-urls, multipart-upload] # OK
    spec: { name: app-assets }
```

`@takos/cloudflare-r2` は `presigned-urls`/`multipart-upload` を declare
しているため selection を通過します。`versioning` を `requires` に書くと
selection は失敗し、manifest validation で reject されます (cf.
[Manifest § capability requires](/manifest#capability-requires))。

## Real client / lifecycle adapter {#real-client--lifecycle-adapter}

production 用の lifecycle adapter は
[`packages/plugins/src/shape-providers/factories.ts`](https://github.com/takos-jp/takosumi/blob/main/packages/plugins/src/shape-providers/factories.ts)
に集約されています。

- AWS / GCP / Cloudflare / Azure / Kubernetes / Deno Deploy: すべての provider
  は paper-thin な HTTP wrapper として **runtime-agent** に lifecycle envelope
  (apply / destroy / describe) を POST します。credential と SDK code は
  runtime-agent 側に集約されており、kernel と plugin は cloud API を直接
  叩きません。
- Selfhost: 同じく runtime-agent 経由で `Deno.Command` / `fetch` / file IO の
  local connector を呼びます。

> Cloudflare Containers は **on-demand materialization** であり、always-on
> process host ではありません (Takosumi Core overview § Boundary を参照)。
> 長時間 process が必要な workload は `@takos/aws-fargate` /
> `@takos/kubernetes-deployment` / `@takos/gcp-cloud-run` /
> `@takos/selfhost-docker-compose` / `@takos/selfhost-systemd` を選択して
> ください。

## 関連ページ

- [Shape Catalog](/reference/shapes) — 各 Shape の spec / outputs /
  capabilities
- [Operator Bootstrap](/operator/bootstrap) — 21 provider を一括 wire する
  factory
- [Extending](/extending) — 新 provider の追加手順
- [Manifest](/manifest) — `resources[]` で provider を指定する書き方
