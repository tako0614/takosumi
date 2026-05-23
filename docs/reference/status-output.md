# Status 出力 {#status-output}

> このページでわかること: current contract での Installation / Deployment 状態の
> 取得境界。

current public installer API は write-oriented な 5 endpoint だけを公開する。
public `GET` status endpoint は無い。

Deployment 履歴や Installation 詳細の read path は operator internal surface
で提供する。

```text
GET /api/internal/v1/installations
GET /api/internal/v1/installations/{id}
GET /api/internal/v1/installations/{id}/deployments
GET /api/internal/v1/installations/{id}/events
```

これらは `TAKOSUMI_INTERNAL_API_SECRET` による internal HMAC 署名が必要で、
public installer bearer では呼ばない。

CLI / operator UI が表示する status shape は、この internal ledger を読む
operator tooling の責務。 public contract の entity 名は Installation /
Deployment のまま維持する。
