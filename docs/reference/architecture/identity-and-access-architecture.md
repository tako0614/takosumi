# Identity and Access Architecture

> このページでわかること: identity / access の設計とアクセス制御モデル。

user / account / organization / membership / billing / OIDC / launch token /
AppInstallation / AppBinding / AppGrant に関する identity & access は operator
の account plane が所有する (reference 実装: `takosumi-cloud/` の Takosumi
Accounts)。 takosumi kernel は generic manifest deploy engine として動作し、
account-plane identity を所有しない。

kernel 側の trust は次の範囲に限られる:

- operator が設定する public deploy / artifact route の authentication
- ProviderPlugin / runtime-agent contract
- unmanaged deployment 向けの deploy evidence / WAL / audit / observation 記録

## 関連ページ

- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `takosumi-cloud/docs/accounts-service.md`
