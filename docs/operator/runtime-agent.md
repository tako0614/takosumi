# Reference runtime-agent 分離 {#runtime-agent}

::: info 内部設計メモ
public contract は [Installer API](../reference/installer-api.md) を参照してください。[Operator Overview](./index.md) から始めてください。
:::

runtime-agent は、リソースの作成・更新を Takosumi プロセスから分離する execution host です。Takosumi から lifecycle RPC を受け取り、 cloud API、container runtime、systemd、filesystem などを操作します。Takosumi は Installation / Deployment の記録とバリデーションを担当し、backend credential は agent host 側に閉じ込めます。

## いつ分離するか {#when-to-split}

次のいずれかに当てはまる場合は、単一 VM の embedded local adapter runtime handler ではなく runtime-agent 分離を使います。

- AWS / GCP / Cloudflare / Kubernetes credential を Takosumi host に置きたくない。
- workload executor と installer API の network boundary を分けたい。
- backend ごとに host、cloud account、VPC、firewall policy を変えたい。
- agent host を rolling upgrade し、Takosumi API を止めずにリソースの作成・更新を切り替えたい。

## Agent host {#agent-host}

agent host には backend credential と runtime handler 設定を置きます。

```ts
import { serveRuntimeAgent } from "@takosjp/takosumi/runtime-agent";
import { buildRuntimeHandlerRegistry } from "./operator-handlers.ts";

const registry = buildRuntimeHandlerRegistry({
  aws: {
    region: process.env.AWS_REGION ?? "ap-northeast-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    route53HostedZoneId: process.env.AWS_ROUTE53_HOSTED_ZONE_ID,
  },
});

serveRuntimeAgent({
  port: 8789,
  token: process.env.TAKOSUMI_AGENT_TOKEN!,
  registry,
});
```

`takosumi runtime-agent serve` は generic host だけを起動し、runtime handler を自動 discovery しません。実 backend を操作する operator distribution は上のような boot wrapper で `RuntimeHandlerRegistry` を渡します。`--env-file` は generic host の env を読むだけで、runtime handler package を自動 import する仕組みではありません。

## Takosumi host {#service-host}

Takosumi host は agent endpoint と token だけを知ります。

```bash
export TAKOSUMI_AGENT_URL=https://agent.internal.example.com
export TAKOSUMI_AGENT_TOKEN=...

bun ./server.ts
```

`server.ts` は [operator bootstrap](./bootstrap.md) の operator-owned implementation wiring 例を使い、Takosumi に PlatformService inventory と execution binding を渡します。実際の副作用は runtime-agent 側の runtime handler が実行します。stock `takosumi server` は connectivity / dev smoke 用で、operator の implementation wiring を読み込まないため実 backend 操作の例には使いません。agent URL は private network 上の HTTPS endpoint にしてください。

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
