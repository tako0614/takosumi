# Launch Token {#launch-token}

Launch token is a one-time bootstrap token used immediately after an Installation (a record of an installed app) becomes ready. It lets an installed app create its first local owner session. It is not an OIDC token, PAT, API bearer, or JWS.

## Flow

```text
install/deploy succeeds
  -> Cloud projection becomes ready
  -> Cloud issues one launch token
  -> browser is redirected to app launch URL
  -> app posts token to Accounts consume endpoint
  -> Accounts atomically marks token used
  -> app creates local owner session
```

Normal sign-in uses the Cloud OIDC issuer and per-Installation OIDC client. Launch token is only the first-run bootstrap credential.

## Token Format

- random 32-byte URL-safe token
- no JSON/JWS structure
- raw value returned only when issued or embedded in launch URL
- storage keeps hash and context metadata, not raw token
- TTL hard cap: 5 minutes

## Issue Semantics

Issuing is an internal account management operation used by dashboard, install lifecycle, operator automation, or product-profile routes.

Conceptual issue input:

```json
{
  "installationId": "inst_abc",
  "purpose": "install-bootstrap",
  "scope": ["openid", "email", "profile"],
  "max_lifetime_seconds": 300
}
```

One Installation has at most one active token. Issuing a new token invalidates the previous active token. `redirect_uri` is compatibility input only. Authority comes from `activated-http-domain.canonicalOrigin` plus the configured launch consume path.

## Consume

```text
POST /v1/installations/{installationId}/launch-token/consume
Content-Type: application/json

{
  "token": "RANDOM_OPAQUE_TOKEN",
  "redirect_uri": "https://app.example.com/_takosumi/launch"
}
```

Success response:

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

`subject` is a compatibility alias for `sub`. `scope` describes launch context only; it does not grant API access.

## Failure Codes

| HTTP | Code                             | Condition                                             |
| ---- | -------------------------------- | ----------------------------------------------------- |
| 400  | `invalid_request`                | Missing or malformed token / redirect URI.            |
| 404  | `invalid_launch_token`           | Token is absent or bound to another Installation.     |
| 409  | `launch_token_redirect_mismatch` | Redirect URI does not match the bound value.          |
| 409  | `state_conflict`                 | Installation is not ready for launch issue/consume.   |
| 409  | `launch_token_replayed`          | Token was already consumed or lost a concurrent race. |
| 409  | `launch_token_expired`           | Token is expired.                                     |
| 503  | `feature_unavailable`            | Accounts service or backing store is unavailable.     |

## Custom Domain Rebind

Cloud commits domain projection, OIDC redirect URI set, and unused launch token invalidation in one operation. If the commit fails, the previous origin and tokens remain authoritative.

## Export

Launch tokens are never exported. Target operators regenerate launch context, OIDC client, pairwise subject, and token state during import.
