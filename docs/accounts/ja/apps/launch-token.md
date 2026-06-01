# Launch Token {#launch-token}

launch token は Installation (アプリのインストール記録) が ready になった直後に使う opaque one-time bootstrap token です。installed app が最初の local owner session を作るために使います。OIDC token、PAT、API bearer、JWS ではありません。

## Flow

```text
install/deploy succeeds
  -> Cloud 投影 becomes ready
  -> Cloud issues one launch token
  -> browser is redirected to app launch URL
  -> app posts token to Accounts consume endpoint
  -> Accounts atomically marks token used
  -> app creates local owner session
```

通常 sign-in は Cloud OIDC issuer と per-Installation OIDC client を使います。 launch token は first-run bootstrap credential だけです。

## Token Format

- random 32-byte URL-safe token
- JSON / JWS structure は持たない
- raw value は issue 時または launch URL 内でだけ返す
- storage は raw token ではなく hash と context metadata を持つ
- TTL hard cap は 5 分

## Issue Semantics

issuing は dashboard、install lifecycle、operator automation、product-profile route が使う internal アカウント管理 operation です。

conceptual issue input:

```json
{
  "installationId": "inst_abc",
  "purpose": "install-bootstrap",
  "scope": ["openid", "email", "profile"],
  "max_lifetime_seconds": 300
}
```

1 Installation の active token は最大 1 個です。新しい token を issue すると古い active token は invalidate されます。`redirect_uri` は compatibility input であり、authority は `activated-http-domain.canonicalOrigin` と configured launch consume path から決まります。

## Consume

```text
POST /v1/installations/{installationId}/launch-token/consume
Content-Type: application/json

{
  "token": "RANDOM_OPAQUE_TOKEN",
  "redirect_uri": "https://app.example.com/_takosumi/launch"
}
```

success response:

```json
{
  "consumed": true,
  "installation_id": "inst_abc",
  "account_id": "acct_123",
  "space_id": "space_personal",
  "app_id": "example.my-app",
  "sub": "tsub_pairwise_for_this_installation",
  "subject": "tsub_pairwise_for_this_installation",
  "role": "owner",
  "jti": "lt_01HR...",
  "audience": "https://app.example.com/_takosumi/launch",
  "scope": ["openid", "email", "profile"],
  "expires_at": "2026-05-25T10:05:00Z"
}
```

`subject` は `sub` の compatibility alias です。`scope` は launch context の説明であり、API access grant ではありません。

## Failure Codes

| HTTP | Code                             | Condition                                                     |
| ---- | -------------------------------- | ------------------------------------------------------------- |
| 400  | `invalid_request`                | token / redirect URI が missing または malformed              |
| 404  | `invalid_launch_token`           | token が存在しない、または別 Installation に bound されている |
| 409  | `launch_token_redirect_mismatch` | redirect URI が bound value と一致しない                      |
| 409  | `state_conflict`                 | Installation が launch issue/consume できる状態ではない       |
| 409  | `launch_token_replayed`          | token は既に consume 済み、または concurrent race に負けた    |
| 409  | `launch_token_expired`           | token が expired                                              |
| 503  | `feature_unavailable`            | Accounts service または backing store が使えない              |

## Custom Domain Rebind

Cloud は domain 投影、OIDC redirect URI set、unused launch token invalidation を 1 operation で commit します。commit に失敗した場合は、previous origin と token が authority のまま残ります。

## Export

launch token は export しません。target operator は import 時に launch context、 OIDC client、pairwise subject、token state を再生成します。
