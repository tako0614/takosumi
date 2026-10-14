# 共通 account と Workspace

この surface は operator が登録済み first-party client の shared-account profile を
明示的に有効にした構成で利用できます。public service の公開状況は deployment に
よって異なります。既存 self-host の login 方法は維持されます。

両 client の OIDC `sub` は同じ canonical account ID です。email は account ID では
ありません。Workspace と現在の membership は共通の Takosumi Control が管理し、
OIDC claim にある profile や email は Workspace の権限を与えません。

## Workspace directory

登録済み RP は現在有効な shared-account access token を Bearer で提示します。
PAT、refresh token、Interface/resource token、任意の account ID を受け付けません。
通常の Accounts session も利用でき、変更には issuer の Origin が必要です。

base path は `/api/v1/account/shared-workspaces` です。

| Method / path | 入力 | 結果 |
| --- | --- | --- |
| GET base | `selectedWorkspaceId?`, `after?`, `limit?` (1–100) | account ID、選択中 Workspace、choices、次 page cursor |
| POST `/bootstrap` | `{}` | 1つの canonical personal Workspace |
| POST base | `{handle, displayName, type:"organization"}` | 追加 Workspace |
| POST `/{workspaceId}/select` | `{}` | 現在 access できる Workspace |
| GET `/{workspaceId}/billing-organization` | なし | `{workspaceId, workspaceRef, organizationId}` |

一覧は account や membership を変更しません。各 choice は `id`, `handle`,
`displayName`, `type`, 現在の `roles`, `owner` を返します。無効な membership を owner
field で迂回できません。binding 未設定や機能未構成は 503、権限不足は 403 です。
課金は Workspace に対応する Organization の単一 ledger へ接続します。

## Provider login の統合

同じ verified email は候補の照合に使います。既存 account を email だけで統合
しません。統合する各 provider の新しい login flow と、それぞれの明示 consent を
必要とします。Google の第三者メールは追加の mailbox proof が必要です。通常の
login session、refresh、公開 profile email だけでは ownership proof になりません。

issuer browser session と同じ browser の操作で
`POST /api/v1/account/identity-merges` に `{sourceSubject,targetSubject}` を渡します。
対象は現在の操作者が含まれる、確認済みの2 account です。5分以内に各 leg を進めます。

1. `POST /{operationId}/upstream-proof/begin` に
   `{role:"source"|"target", providerId, consent:true}` を送ります。
2. 200 の `{authorization_url,operation_id,role}` にある provider URL へ browser で
   移動します。callback は opaque `proof_receipt` と `operation_id` を返します。
3. `POST /{operationId}/prove` に `{receiptId}` を送ります。両 leg に対して実施します。
4. `POST /{operationId}/consent` に `{consent:true}` を送り、owner reconciliation を
   待ちます。全 owner の整合が確認されるまで merged login は有効になりません。

上記 suffix の base は `/api/v1/account/identity-merges` です。変更は issuer の
exact Origin と host-only issuer/merge cookie を必要とし、response は no-store です。
通常の session rotation は完了済み証明を保持しますが、logout や security state
変更はそれを無効にします。この操作は provider session の現在の control と conscious
consent を確認し、provider の最近の password/MFA 入力を保証しません。

成功後はどちらの provider でも同じ canonical account に login し、旧 session/grant
は無効になります。元の Workspace、Organization、残高、履歴、pending billing の
operation key は保持します。wallet や role を自動で和算しません。証明の衝突や
owner ACK 不足は統合を止めます。credential の unlink は credential を無効にし、
account や wallet を分割しません。誤った統合の取り消しは owner-reviewed recovery です。

credential の選択は cookie 認証された readonly
`GET /api/v1/account/identity-credentials` の最大100件の自分の provider identity を使います。
`POST /api/v1/account/identity-credentials/unlink-intents` に
`{removedIdentity,retainedIdentity,consent:true}` を送り、intent の
`/upstream-proof/begin` に `{consent:true}` を送って残す provider で新しく認証します。
callback の `proof_receipt` を intent の `/complete` に
`{receiptId,consent:true}` として渡します。現在の対応は retained social credential で、
passkey を残す証明はこの flow にありません。旧 `/unlink` route は利用できません。
