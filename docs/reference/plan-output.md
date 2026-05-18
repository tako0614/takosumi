# Plan Output

> このページでわかること: dry-run response の参照先。

Takosumi の plan / preview entity は v1 で廃止されました。 dry-run の結果は
**呼び出し時の response でその場で返り、 entity 化されません**。

正本: [Installer API](./installer-api.md) の dry-run endpoint。

- `POST /v1/installations/dry-run` — 新規 install の dry-run
- `POST /v1/installations/{id}/deployments/dry-run` — upgrade の dry-run

response には `changes[]` (= create / update / delete の予定変更)、
`estimatedCost`、 `expected.commit` / `expected.manifestDigest` (= TOCTOU gate)
が含まれます。

apply で実際に起きたことは [Deployment](./installer-api.md#entity-shapes) record
として恒久保存されます。
