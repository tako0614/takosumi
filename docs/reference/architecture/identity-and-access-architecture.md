# Identity と Access アーキテクチャ {#identity-and-access-architecture}

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

## Actor / Organization モデル {#actor--organization-model}

Actor / Organization / membership / account ownership / billing ownership は
takosumi kernel が持たない。 これらは operator account plane が所有する
(reference 実装は `takosumi-cloud/` の Takosumi Accounts)。

### モデル

- takosumi kernel は AppSpec installer lifecycle を処理し、Deployment evidence
  を記録する。
- operator account plane は account / billing / AppInstallation ledger / OIDC
  issuer / pairwise subject / namespace publish-listen / permission grant /
  audit lifecycle を所有する。
- Deployment apply は `/v1/installations/*` の installer lifecycle 経由で行う。
  ownership は Installation ledger に記録される。

### Actor / Organization モデル — 関連ページ {#actor--organization-model--関連ページ}

- `takosumi-cloud/docs/accounts-service.md`
- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `docs/platform/app-installation.md`
