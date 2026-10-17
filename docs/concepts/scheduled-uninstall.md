# 削除の予約（予約アンインストール）

dashboard の **削除を予約** は、サービス（Capsule）をすぐには消さず、猶予期間のあとで削除する
操作です。予約すると状態は **削除予定**（`uninstalled`）になります。猶予期間のあいだ provider の
resource とデータは残り、課金も続きます。OSS の既定の猶予期間は 7 日です。期限が来ると、
対応しているサーバーではデータを書き出してから、destroy の Plan を作って削除します。

API では `POST /api/v1/capsules/{capsuleId}/uninstall` が、デプロイ済みの Capsule にこの予約を
作ります。同じ予約を送り直すと元の予約が返り、期限や依頼者は変わりません。

## 取り消す

期限までは dashboard の **削除を取り消す** で取り消せます。API では、現在の Workspace の owner
または admin が `POST /api/v1/capsules/{capsuleId}/cancel-uninstall` を呼びます。取り消せるのは
次の場合だけです。

- `uninstall.phase` が `scheduled` で、削除の処理（teardown）が実行中でも完了済みでもない
- `phase` が `destroying` でも、予約が停止済み（`uninstall.blockedReason` が設定済み）で、
  runtime safety が未登録か `safe` である

承認済みの Plan があるだけ、または provider への dispatch の前というだけでは取り消せません。
外部の lifecycle や provider の操作が始まっていれば取り消さず、結果を確かめてから、認可された
前方修復（forward repair）で直します。

## 予約に使う認証

予約には、操作した Accounts のアカウントと、予約に使った認証の参照が内部に記録されます。
削除の処理は、データの書き出しと destroy の Plan を作る前、そのあとの承認・デプロイ（apply）・
provider への dispatch の前に、そのつど Workspace の現在の管理権限と Accounts の認証状態を
確かめ直します。処理は期限より遅れることがあるため、予約に使う認証は次のように選びます。

| 認証 | 予約 | 期限のあとの確認 |
| --- | --- | --- |
| ブラウザーのセッション | できます | アカウントの意図として扱うため、セッションの期限切れや更新だけでは止まりません。アカウントと Workspace の権限は期限にも確かめます |
| PAT | 期限（`scheduledDestroyAt`）の 6 時間後以降まで有効なもの、または無期限のものだけ | 予約に使った**同じ PAT** が、確かめるたびに有効で、`write` scope と Workspace の制限を満たす必要があります |
| OAuth | できません | — |

PAT について:

- `scheduledDestroyAt + 6h` ちょうどに失効する PAT は受け付けます。それより 1 ms でも早く
  失効する PAT は `409 failed_precondition` で断ります
  （`details.reason: capsule_uninstall_pat_deadline_unverified`）。Accounts がこの条件を
  確かめられない場合も、Capsule の状態・予約・Activity は変えません。
- 6 時間は、削除の処理や provider への dispatch の遅れに備えた予約時の余裕です。猶予期間が
  0 日でも同じです。dispatch がさらに遅れた場合や PAT が revoke された場合は、実行を保証
  しません。PAT は期限ではなく、実際の provider への dispatch まで有効である必要があります。
- 同じアカウントの別の有効な PAT があっても、予約に使った PAT の代わりにはなりません。

OAuth について: access token の既定の有効期間は 5 分で、既定の猶予期間 7 日よりずっと短く、
予約は同じ token grant を期限のあとにも確かめます。そのため OAuth では予約できず、
`409 failed_precondition`（`details.reason: capsule_uninstall_oauth_unsupported`）が返ります。
猶予期間が 0 日でも同じです。token を更新しても、予約に記録した grant の代わりにはなりません。
既存の OAuth の予約も新しい token には移らず、記録した grant が期限切れになると削除の処理は
止まります。

## 期限に確認できなかったとき

期限に認証または Workspace の権限を確かめられなかった予約は、状態を **削除予定**
（`uninstalled`）のまま止め、`uninstall.blockedReason` と `uninstall.authorizationRejectedAt` を
記録します。

| `uninstall.blockedReason` | 理由 |
| --- | --- |
| `uninstall_requester_missing` | 依頼者の記録がない古い予約です |
| `uninstall_requester_denied` | 期限切れや失効などで、予約に使った認証を確かめられません |

この拒否は、通常はデータの書き出し、destroy の Plan、provider の操作より前に記録されます。
監査記録の `capsule.uninstall_blocked` にも理由と時刻が残ります。あとから権限や認証を戻しても、
予約は再開しません。

## 止まった予約を直す

1. 上の「取り消す」の条件を満たしていることを確かめます。
2. 現在の Workspace の owner または admin が `cancel-uninstall` を呼びます。
3. ブラウザーのセッション、または provider への dispatch まで有効であり続ける PAT で、
   `POST /api/v1/capsules/{capsuleId}/uninstall` をもう一度呼びます。

新しい予約には新しい ID と、改めて全部の猶予期間が付きます。古い予約が新しい依頼者を引き継ぐ
ことはありません。取り消しの条件を満たさない場合や外部の操作が始まっている場合は、結果を
確かめてから、認可された前方修復で直します。

API の詳細は [API リファレンス](../reference/api.md) にあります。
