# Operator Status と参照 API ガイダンス {#status-output}

Takosumi core の public API は write 指向です: dry-run、install、deploy dry-run、 deploy、rollback。operator は履歴に依存するワークフロー（dashboard、CLI、 support tooling、rollback target 選択、async apply polling、audit review）向けに参照 API を公開するのが一般的です。

このページは operator が管理する参照 API のガイダンスです。各 operator は自身の route inventory、authentication、pagination、account layer projection の shape を選びます。portable な CLI / dashboard 動作を求める distribution は以下の field を公開するか、自身の distribution spec に同等の projection を document すべきです。

推奨する参照 API:

| View                 | 最低限の semantics                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Installation inspect | `id`、`spaceId`、`appId`、`status`、`currentDeploymentId`、created / update timestamps。        |
| Deployment list      | 1 つの Installation の Deployment を作成時刻順で、pagination または bounded retention 付き。    |
| Deployment inspect   | `id`、`installationId`、`source`、`planSnapshotDigest`、`status`、public / non-secret `outputs`。 |
| Async polling        | `running` の Deployment を `succeeded` または `failed` になるまで observe できる。              |
| Rollback eligibility | `succeeded` の Deployment が保持され rollback target として選択可能かどうか。                   |
| Redaction            | raw credential、token、private key、provider secret は ref または operator 制御の背後に留める。 |

Takosumi reference 実装は operator tooling 向けの internal read route を持ちますが、それらの route は reference implementation の詳細です。portable なクライアントは Installer API contract と public installer bearer を使い、operator tooling は自身の operator 向け credential と route inventory を使います。

例えば Takosumi は、account-session / PAT で保護された Installation list、 inspect、event、launch、materialize、export view を Cloud account layer API surface として公開しています。その distribution については [Takosumi](./accounts.md) を参照してください。

## 関連ページ

- [Installer API](./installer-api.md)
- [Takosumi Core Specification](./core-spec.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
