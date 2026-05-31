# Reference runtime-agent 分離 {#runtime-agent}

::: info 内部設計メモ
public contract は [Installer API](../reference/installer-api.md) を参照してください。[Operator Overview](./index.md) から始めてください。
:::

runtime-agent は、リソースの作成・更新を Takosumi プロセスから分離する execution host です。Takosumi から lifecycle RPC を受け取り、 cloud API、container runtime、systemd、filesystem などを操作します。Takosumi は Installation / Deployment の記録とバリデーションを担当し、backend credential は agent host 側に閉じ込めます。

## いつ分離するか {#when-to-split}

次のいずれかに当てはまる場合は、単一 VM の embedded local adapter connector ではなく runtime-agent 分離を使います。

- AWS / GCP / Cloudflare / Kubernetes credential を Takosumi host に置きたくない。
- workload executor と installer API の network boundary を分けたい。
- backend ごとに host、cloud account、VPC、firewall policy を変えたい。
- agent host を rolling upgrade し、Takosumi API を止めずにリソースの作成・更新を切り替えたい。

## Agent host {#agent-host}

agent host には backend credential と connector 設定を置きます。

```ts
import { serveRuntimeAgent } from "@takos/takosumi-runtime-agent/server";
import { buildConnectorRegistry } from "@takos/takosumi-runtime-agent-connectors";

const registry = buildConnectorRegistry({
  aws: {
    region: Deno.env.get("AWS_REGION") ?? "ap-northeast-1",
    accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
    secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
    route53HostedZoneId: Deno.env.get("AWS_ROUTE53_HOSTED_ZONE_ID"),
  },
});

serveRuntimeAgent({
  port: 8789,
  token: Deno.env.get("TAKOSUMI_AGENT_TOKEN"),
  registry,
});
```

`takosumi runtime-agent serve` は generic host だけを起動し、connector を自動 discovery しません。実 backend を操作する operator distribution は上のような boot wrapper で `ConnectorRegistry` を渡します。`--env-file` は generic host の env を読むだけで、connector package を自動 import する仕組みではありません。

## Takosumi host {#kernel-host}

Takosumi host は agent endpoint と token だけを知ります。

```bash
export TAKOSUMI_AGENT_URL=https://agent.internal.example.com
export TAKOSUMI_AGENT_TOKEN=...

bun --preload ./shims/deno-compat.ts ./server.ts
```

`server.ts` は [operator bootstrap](./bootstrap.md) の reference adapter array (`plugins` option) 例を使い、kind package を Takosumi に attach します。実際の副作用は runtime-agent 側の connector が実行します。stock `takosumi server` は connectivity / dev smoke 用で、operator の kind package array を読み込まないため実 backend 操作の例には使いません。agent URL は private network 上の HTTPS endpoint にしてください。

## Network と token {#network-and-token}

- Takosumi から agent への outbound だけを許可する。
- agent token は installer token と別に発行する。
- reverse proxy を挟む場合、request body size と timeout をリソースの作成・更新に合わせる。
- agent host の logs には raw credential を出さない。

## Failure mode {#failure-mode}

agent が unreachable の場合、Takosumi は operation を dispatch できないため Deployment は失敗します。provider 側の副作用が出る前に失敗した operation はそのまま再試行できます。副作用後の失敗は WAL / provider observation / Deployment condition を見て、同じ OperationPlan を continue するか、新しい Deployment として reconcile します。

関連する reference topology:

- [Reference Runtime-Agent Execution Surface](../reference/runtime-agent-api.md)
- [Implementation / runtime-agent boundary](../reference/architecture/runtime-agent-boundary.md)
