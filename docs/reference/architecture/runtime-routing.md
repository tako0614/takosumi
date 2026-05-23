# Runtime routing {#runtime-routing}

> このページでわかること: AppSpec を apply した後、request がどの Deployment /
> resource に届くかを kernel がどう決めるか。

Runtime routing は、Deployment に固定された component materialization snapshot
を読み、hostname / path / resource output から実行先を選ぶ layer です。user
account、billing、OIDC issuer、customer onboarding はこの layer の責務ではあり
ません。

## 入力 {#inputs}

routing layer が参照する入力は、apply 済み Deployment の snapshot です。

- selected runtime implementation / provider implementation
- source snapshot digest and provider-specific immutable runtime input digests
- materialized env / secret refs
- resource output refs
- exposure / traffic assignment
- runtime network policy

AppSpec author は runtime routing を直接操作しません。worker の endpoint や
custom-domain の destination など、kind ごとの `spec` と `publish` / `listen`
から projection が作られます。

## HTTP endpoint {#http-endpoint}

`worker` は prepared source と `spec.entrypoint` を request-driven runtime に
渡す workload です。container runtime は external descriptor が定義する
`web-service` を使い、reference descriptor では `spec.image` を読む。

```yaml
apiVersion: v1
metadata:
  id: com.example.edge
  name: Edge App
components:
  web:
    kind: worker
	    spec:
	      entrypoint: dist/worker.mjs
    publish:
      - com.example.edge.web
  domain:
    kind: custom-domain
    spec:
      name: web.example.com
    listen:
      com.example.edge.web:
        as: target
```

provider は Cloudflare Workers や Deno Deploy など任意ですが、kernel が保持する
canonical routing authority は Deployment snapshot です。

## Component 間接続 {#component-connection}

resource 間の依存は AppSpec の `publish` / `listen` edge で表現します。

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
	    spec:
	      entrypoint: dist/worker.mjs
    listen:
      com.example.edge.db:
        as: env
        prefix: DATABASE
```

listen で受け取った material は env、mount、config など kind-specific な形で
workload に渡されます。

## Dispatch {#dispatch}

runtime request は直接 workload に届かず、dispatch / routing layer を経由しま
す。routing layer は GroupHead が指す current Deployment の exposure / traffic
assignment を読み、hostname / path から workload resource へ振り分けます。

- kernel API hostname は installer / internal API へ向ける。
- AppSpec から作られた auto hostname / custom domain は runtime workload
  へ向ける。
- external identity endpoint など operator-owned surface は namespace export と
  operator 側 routing で扱う。

dispatch は provider-specific route cache を持ってよいですが、canonical source
は Deployment と GroupHead です。

## Rollback {#rollback}

rollback は retained Deployment snapshot と resource metadata を使った pointer
move です。durable resource contents の巻き戻しは rollback ではなく、新しい
Deployment / resource operation として扱います。

## Backend parity {#backend-parity}

Takosumi kernel は backend-neutral な runtime contract を提供します。同じ
AppSpec でも、Cloudflare Workers、Kubernetes、bare metal、自前 runtime では
provider capability と実行時制約が異なります。差分は provider capability と
Deployment evidence に記録し、AppSpec contract 自体には混ぜません。
