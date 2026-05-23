# runtime-agent 分離 {#runtime-agent}

> このページでわかること: kernel process から cloud credential / OS executor を
> 分離し、runtime-agent host に provider operation を任せる構成。

runtime-agent は kernel から lifecycle RPC を受け取り、cloud API、container
runtime、systemd、filesystem などを操作する process です。kernel は Installation
/ Deployment record と validation を担当し、provider credential は agent host 側
に閉じ込めます。

## いつ分離するか {#when-to-split}

次のいずれかに当てはまる場合は、単一 VM の embedded self-host connector ではなく
runtime-agent 分離を使います。

- AWS / GCP / Cloudflare / Kubernetes credential を kernel host に置きたくない。
- workload executor と installer API の network boundary を分けたい。
- provider ごとに host、cloud account、VPC、firewall policy を変えたい。
- agent host を rolling upgrade し、kernel API を止めずに provider operation を
  切り替えたい。

## Agent host {#agent-host}

agent host には provider credential と connector 設定を置きます。

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=ap-northeast-1

takosumi runtime-agent serve --port 8789 --token "$TAKOSUMI_AGENT_TOKEN"
```

`--env-file ./agent.env` は agent 専用の dotenv file です。kernel host にはこの
dotenv file を置きません。

## Kernel host {#kernel-host}

kernel host は agent endpoint と token だけを知ります。

```bash
export TAKOSUMI_AGENT_URL=https://agent.internal.example.com
export TAKOSUMI_AGENT_TOKEN=...

takosumi server --port 8788
```

operator は provider package を kernel に attach し、実際の副作用は
runtime-agent 側の connector が実行します。agent URL は private network または
mutual TLS を通した endpoint にしてください。

## Network と token {#network-and-token}

- kernel から agent への outbound だけを許可する。
- agent token は installer token と別に発行する。
- reverse proxy を挟む場合、request body size と timeout を provider operation
  に合わせる。
- agent host の logs には raw credential を出さない。

## Failure mode {#failure-mode}

agent が unreachable の場合、kernel は operation envelope を dispatch できない
ため Deployment は失敗します。provider 側の副作用が出る前に失敗した operation は
そのまま再試行できます。副作用後の失敗は WAL / provider observation / Deployment
condition を見て、同じ OperationPlan を continue するか、新しい Deployment
として reconcile します。

関連する内部 contract:

- [Runtime-Agent API](../reference/runtime-agent-api.md)
- [Implementation / runtime-agent boundary](../reference/architecture/implementation-operation-envelope.md)
