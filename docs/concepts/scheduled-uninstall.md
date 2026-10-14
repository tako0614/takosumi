# Capsule の予約アンインストール

PAT の有効期限が新しい予約の `scheduledDestroyAt` 以前の場合、予約時に `409 failed_precondition` と `details.reason: capsule_uninstall_pat_deadline_unverified` が返ります。同時刻に失効する場合も拒否します。Accounts が固定 PAT の期限時点での有効性を確認できない場合も、Capsule の状態・予約・Activity を変更しません。警告だけでは必ず停止する予約を保存してしまうため、OAuth と同じく予約前の拒否を選んでいます。ブラウザー session、無期限 PAT、予約期限より後まで有効な PAT を使ってください。猶予 0 日でも同じ期限条件を適用します。既存予約の再送は元の予約を返し、期限や requester を差し替えません。受付済みでも、実際の provider dispatch まで同じ PAT が有効であり続ける必要があります。

`POST /api/v1/capsules/{capsuleId}/uninstall` は、適用済み Capsule を `uninstalled` にして、後で破棄する予約を作ります。猶予期間中は provider の resource とデータが残り、課金も続きます。OSS の既定猶予期間は 7 日です。現在の Workspace owner または admin は、`uninstall.phase` が `scheduled` で teardown が実行中・完了済みでない場合、`POST /api/v1/capsules/{capsuleId}/cancel-uninstall` で予約を取り消せます。`phase` が `destroying` の場合は、予約が停止済み (`uninstall.blockedReason` が設定済み) で、runtime safety が未登録または `safe` の場合だけ取り消せます。承認済み Plan があるだけ、または provider dispatch 前という理由だけでは取り消せません。外部 lifecycle/provider 操作が始まっていれば取り消さず、結果を確認して認可済みの forward repair を行います。

予約には、操作した Accounts subject と予約に使った認証方式の参照が内部保存されます。finalizer は export や destroy Plan を作る前、その後の承認・適用・provider dispatch の境界でも、Workspace の現在の管理権限と Accounts の認証状態を再確認します。ブラウザー session は subject の意図として扱うため、session の期限切れや rotation だけでは予約を止めません。subject のアカウントと Workspace 権限は期限時にも確認します。PAT 予約では、予約時に固定された**同じ PAT** が各再確認時に有効で、`write` scope と Workspace 制限を満たす必要があります。finalizer の実行や provider dispatch は予約期日より遅れることがあるため、PAT は期日だけでなく実際の provider dispatch まで有効でなければなりません。同じ subject の別 PAT が有効でも、予約に固定された PAT の代わりにはなりません。

OAuth access token は既定で 5 分間有効ですが、OSS の既定アンインストール猶予期間は 7 日です。予約後も同じ token grant を再確認するため、OAuth は現在の予約操作では利用できません。猶予期間が 0 日でも同じです。OAuth で予約すると `409 failed_precondition` と `details.reason: capsule_uninstall_oauth_unsupported` が返ります。token を更新しても、予約に固定された grant の代わりにはなりません。既存の OAuth 予約も新しい token へ自動移行されず、固定された grant の期限切れ後は finalizer が停止します。

認証または Workspace 権限を期限時に確認できない予約は、Capsule の `status` を `uninstalled` のまま保ち、`uninstall.blockedReason` と `uninstall.authorizationRejectedAt` を記録して停止します。requester のない既存予約は `uninstall.blockedReason: uninstall_requester_missing`、期限切れ・失効などで固定 grant を確認できない予約は `uninstall.blockedReason: uninstall_requester_denied` になります。通常、認可拒否は export、destroy Plan、provider 操作より前に記録されます。監査記録の `capsule.uninstall_blocked` にも拒否理由と時刻が含まれます。権限や認証状態を後から戻しても予約は再開しません。

認可停止した予約を修復するには、上記の取消条件を満たすことを確認したうえで、現在の Workspace owner または admin が `cancel-uninstall` を呼び、その後、ブラウザー session または provider dispatch まで有効であり続ける PAT で `POST /api/v1/capsules/{capsuleId}/uninstall` を呼びます。新しい予約には新しい ID と猶予期間が適用されます。古い予約は新しい requester を採用しません。取消条件を満たさない場合や外部操作が始まった場合は、結果を確認して認可済みの forward repair を行ってください。

詳細な操作経路は [API reference](../reference/api.md) を参照してください。
