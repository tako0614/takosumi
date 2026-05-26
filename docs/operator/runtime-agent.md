# Reference runtime-agent 分離 {#runtime-agent}

::: info
内部設計メモ public contract は [Installer API](../reference/installer-api.md) を参照。[Operator Overview](./index.md) から始めてください。
:::

runtime-agent は reference Takosumi topology でリソースの作成・更新を Takosumi プロセスから分離する execution host です。Takosumi から lifecycle RPC を受け取り、 cloud API、container runtime、systemd、filesystem などを操作します。Takosumi は Installation / Deployment の記録とバリデーションを担当し、provider credential は agent host 側に閉じ込めます。

## いつ分離するか {#when-to-split}

次のいずれかに当てはまる場合は、単一 VM の embedded local adapter connector ではなく runtime-agent 分離を使います。

- AWS / GCP / Cloudflare / Kubernetes credential を Takosumi host に置きたくない。
- workload executor と installer API の network boundary を分けたい。
- provider ごとに host、cloud account、VPC、firewall policy を変えたい。
- agent host を rolling upgrade し、Takosumi API を止めずにリソースの作成・更新を切り替えたい。

## Agent host {#agent-host}

agent host には provider credential と connector 設定を置きます。

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=ap-northeast-1

takosumi runtime-agent serve --port 8789 --token "$TAKOSUMI_AGENT_TOKEN"
```

`--env-file ./agent.env` は agent 専用の dotenv file です。Takosumi host にはこの dotenv file を置きません。

## Takosumi host {#kernel-host}

Takosumi host は agent endpoint と token だけを知ります。

```bash
export TAKOSUMI_AGENT_URL=https://agent.internal.example.com
export TAKOSUMI_AGENT_TOKEN=...

deno run -A ./server.ts
```

`server.ts` は [operator bootstrap](./bootstrap.md) の reference adapter array (`plugins` option) 例を使い、provider package を Takosumi に attach します。実際の副作用は runtime-agent 側の connector が実行します。stock `takosumi server` は connectivity / dev smoke 用で、provider adapter array を読み込まないため実 provider 操作の例には使いません。agent URL は private network 上の HTTPS endpoint にしてください。

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
