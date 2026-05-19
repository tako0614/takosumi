# Tenant Runtime {#tenant-runtime}

> このページでわかること: tenant runtime の設計と isolation モデル。

Tenant runtime は installer pipeline が AppSpec component を解決した結果を実行
環境へ materialize する execution plane です。Takosumi Account / Installation
ledger は account plane にあり、tenant runtime は所有権や billing
を直接扱いません。

Installation lifecycle は 5 endpoint installer API が所有します。tenant runtime
側には、AppSpec を apply した結果として workload / route / resource projection
が現れます。

## Runtime 入力 {#runtime-inputs}

tenant runtime が受け取る入力は Deployment に固定された component
materialization snapshot です。

- `worker`: JS bundle artifact (`build.output` or artifact source)、
  `compatibilityDate`、optional `routes`
- `postgres`: provider が materialize する stateful database
- `object-store`: S3-compatible object store
- `custom-domain`: route / endpoint output への domain projection

per-Installation OIDC client は本 kernel の `kind` には無く、 Takosumi Accounts
(= takosumi-cloud) が `operator.identity.oidc` namespace path に material を
publish する形に移動済みです (worker が `listen.operator.identity.oidc` で
受け取る)。

resource 間の依存は AppSpec の `publish` / `listen` edge で表現します。 operator
/ account plane dependency は namespace export と account API / BillingPort で
扱います。 AppSpec surface は component graph に閉じます。

## Worker Runtime {#worker-runtime}

`worker` は request-driven JS workload です。

```yaml
apiVersion: takosumi.dev/v1
kind: App

metadata:
  id: com.example.edge
  name: Edge App

components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    routes:
      - web.example.com/*
```

workflow / cron / hook は tenant runtime snapshot に含めません。必要な
automation は installer API を呼ぶ外部 CI / operator product の責務です。

## Container / Web Service Runtime {#container--web-service-runtime}

container / process runtime は `worker` component の provider materialization
として表現されます。provider は Fargate / Cloud Run / Kubernetes / local Docker
など任意ですが、AppSpec は同じ component contract を使います。

```yaml
apiVersion: takosumi.dev/v1
kind: App

metadata:
  id: com.example.api
  name: API

components:
  api:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    routes:
      - api.example.com/*
```

他 component の output は **`publish` / `listen`** edge で worker に渡します。
旧 `${ref:...}` interpolation や `use:` edge は廃止されました。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
      size: small
    publish:
      - com.example.edge.db

  edge:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/edge.mjs
    listen:
      com.example.edge.db:
        as: env
        prefix: DATABASE_
        # → DATABASE_HOST / DATABASE_CONNECTIONSTRING 等が env に注入される
```

## ディスパッチ {#dispatch}

tenant request は直接 workload に届かず、dispatch / routing layer を経由しま
す。routing layer は GroupHead が指す current Deployment の route projection を
読み、hostname / path から target resource へ振り分けます。

- `{KERNEL_DOMAIN}` → kernel API / settings
- auto hostname / custom slug / custom domain → tenant runtime target
- OIDC issuer route (`/oauth/*`) は kernel / tenant runtime の対象外で、
  Takosumi Accounts が提供する

dispatch は provider-specific route cache を持ってよいが、canonical source は
Deployment と GroupHead です。

## Runtime Snapshot {#runtime-snapshot}

runtime deployment は次の snapshot を持ちます。

- selected provider target
- artifact digest / image digest
- materialized env / secret refs
- resource output refs
- route projection
- runtime network policy

rollback は retained Deployment snapshot と resource metadata を再利用する
pointer move です。durable resource contents の巻き戻しは rollback ではなく、
新しい Deployment / resource operation として扱います。

## ローカルバックエンド {#local-backend}

local backend は provider account なしで component kind resource contract を検
証するための backend です。

- `worker`: Workers-compatible local adapter / process adapter
- stateful resource: local Postgres / object store emulator または external
  provider
- routing: local dispatch / reverse proxy

## バックエンドパリティ {#backend-parity}

Takosumi kernel は backend-neutral な tenant contract を提供します。各 backend
は同じ component kind contract を受け取りつつ、runtime behavior や provider
capability の詳細は target ごとに異なります。 reference Takos distribution が
観測する 環境ごとの差異は
[Takos hosting differences](https://github.com/tako0614/takos/blob/main/docs/hosting/differences.md)
を参照 (他の InstallableApp も同様の backend parity を扱う必要があります)。

## Workers バックエンドのリファレンス materialization {#workers-backend-reference-materialization}

::: details tracked reference Workers backend の実装詳細

このセクションは Cloudflare Workers backend に固有の materialization detail
です。Core 用語との対応は
[Workers backend implementation note](../workers-backend.md) を参照。

- `worker` は Cloudflare Workers runtime で materialize される
- container workload は provider plugin が Containers / external container
  runtime へ変換できる
- tenant routing は dispatch worker と route projection cache に従う
- provider operation の進捗は `Deployment.conditions[]` と ProviderObservation
  stream に記録される

:::
