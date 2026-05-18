# Identity and Access Architecture

> このページでわかること: identity / access の設計とアクセス制御モデル。

user / account / organization / membership / billing / OIDC / launch token /
AppInstallation / namespace publish-listen / permission grant に関する identity
& access は operator の account plane が所有する (reference 実装:
`takosumi-cloud/` の Takosumi Accounts)。 takosumi kernel は generic AppSpec
installer engine として動作し、 account-plane identity を所有しない。

kernel 側の trust は次の範囲に限られる:

- operator が設定する installer / artifact route の authentication
- ProviderPlugin / runtime-agent contract
- Deployment evidence / WAL / audit / observation 記録

## 関連ページ

- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `takosumi-cloud/docs/accounts-service.md`
