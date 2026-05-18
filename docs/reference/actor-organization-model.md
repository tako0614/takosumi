# Actor / Organization Model

> このページでわかること: Actor / Organization の所有層と kernel の責務境界。

Actor / Organization / membership / account ownership / billing ownership は
takosumi kernel が持たない。 これらは operator account plane が所有する
(reference 実装は `takosumi-cloud/` の Takosumi Accounts)。

## モデル

- takosumi kernel は AppSpec installer lifecycle を処理し、Deployment evidence
  を記録する。
- operator account plane は account / billing / AppInstallation ledger / OIDC
  issuer / pairwise subject / use edge / permission grant / audit lifecycle
  を所有する。
- Deployment apply は `/v1/installations/*` の installer lifecycle 経由で行う。
  ownership は Installation ledger に記録される。

## 関連ページ

- `takosumi-cloud/docs/accounts-service.md`
- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `docs/platform/app-installation.md`
