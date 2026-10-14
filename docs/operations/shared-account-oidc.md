# Shared-account OIDC の導入

これは明示 opt-in 構成の operator runbook です。実装契約は
[shared-account OIDC](../internal/shared-account-oidc.md) にあります。live 登録、
schema 変更、secret 変更、staging 公開はそれぞれ対象 owner の操作です。
production `auth.takos.jp` の公開をこの文書で許可しません。

Accounts の canonical account と、既存 Control の Workspace/member 保存先を
使用します。別の Workspace directory、共有 session cookie、重複 wallet は作りません。
Workspace→Takoserver Organization の初回 binding は既存 opaque reference とともに
固定し、launch では付け替えません。

1. 対象 artifact、現在の Accounts ledger/closure、既存 Control binding、backup と
   restore/forward-repair を private evidence へ記録します。保護データを disposable と
   見なさず、DB を初期化しません。
2. shared profile が無効な v4/v5 compatible bridge を先に導入・readback します。
   現在の exact-v4-only artifact は v5 を拒否するため、v5 後の rollback floor は
   この bridge です。旧 migration 名/checksum を変更しません。
3. 独立した protected migration review と明示 mutation 許可の後、owner CLI で
   Accounts D1 v5（PostgreSQL は045）を反映し、exact closure と既存 ID/FK/履歴の保持を
   確認します。shared mode は `predeployed` のみで、request 時 DDL を拒否します。
4. environment ごとに issuer、各 client ID、callback を exact 登録します。staging
   issuer は `https://auth-staging.takos.jp`、提案 client ID は
   `takosumi-hosted-staging-v1` と `takoserver-console-staging-v1` です。実際の callback
   origin は各 RP owner の private preflight で確認し、wildcard や prod callback を
   混ぜません。secret 値、private JWK、session salt と実現 config は public repo 外です。
5. descriptor の `profile:"shared-account"`, `enabled:true`, HTTPS redirect allowlist,
   `client_secret_basic`, identity scope allowlist と個別 `clientSecretEnv` を検証します。
   `TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY=true` は exact-v5 検証後に有効化します。
   stable ES256 key、pairwise secret、session hash salt を維持し、欠落時は公開しません。
6. same Control operations facade、immutable billing resolver、owner reconciliation
   を composition へ渡します。reconciler は membership、ledger、RP grant/session、
   external binding、元の pending/unknown billing operation key の custody を確認します。
   no-op ACK や別 DB の role union で代用しません。未設定なら merge activation は拒否します。
   部分 ACK 後は issuer session が失効するため、browser `/activate` に retry を任せません。
   永続 operation ID を owner service が保持し、5分以内に trusted activation seam を再実行
   するか、期限後は reviewed recovery を実施します。専用 staging entry は consent と
   毎分 cron に同じ retry service を渡します。実 owner readiness、有限 queue capacity、
   残りの proof 時間を reservation 前に確認し、不足時は session を保持して拒否します。
   実際の owner adapter が未構成なら merge を有効化しません。
7. final exact-head full CI と独立 QA の後、parent の publish 割当・staging flock で
   owning deploy lane を使います。readback は discovery/JWKS、実 social login、両 RP の
   同一 canonical sub、current membership、bootstrap の一意性、refresh replay/revoke、
   same-browser dual proof、original intent/ledger保持を確認します。

失敗時は raw request/body/token/secret を log に出しません。schema 後は互換 bridge を
rollback floor にして feature を無効化し、追加 metadata と audit は保持します。
予約済み merge の部分 ACK は自動 retry で完了扱いにせず、owner-reviewed forward repair
へ回します。disabled client は durable tombstone なので、再開は新しい versioned client ID
を独立登録します。production route switch は別の operator approval が必要です。
