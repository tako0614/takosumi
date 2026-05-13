# Auth Providers

> このページでわかること: kernel が受け付ける認証プロバイダーの一覧と設定。

Auth provider / upstream IdP brokering / passkey / OIDC discovery / pairwise
subject derivation は operator の account plane が所有する (reference 実装:
`takosumi-cloud/` の Takosumi Accounts)。 takosumi kernel は OAuth / OIDC
provider 動作を所有せず、 user identity の broker も行わない。

## 関連ページ

- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `takosumi-cloud/docs/accounts-service.md`
- `takosumi-cloud/docs/apps/launch-token.md`
