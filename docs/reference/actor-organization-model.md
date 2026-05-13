# Actor / Organization Model

> このページでわかること: Actor と Organization のモデル定義。

Actor / Organization / membership / account ownership / billing ownership は
takosumi kernel が持たず、 operator account plane が所有する (reference 実装は
`takosumi-cloud/` の Takosumi Accounts)。

モデル:

- takosumi kernel は compiled Shape manifest を受け取り、 deploy evidence
  を記録する。
- operator account plane が account / billing / AppInstallation ledger / OIDC
  issuer / pairwise subject / AppBinding / AppGrant / audit lifecycle
  を所有する。
- `POST /v1/deployments` を直接叩いて作られた deploy は unmanaged deployment
  となり、 AppInstallation ownership を持たない。

## 関連ページ

- `takosumi-cloud/docs/accounts-service.md`
- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `docs/platform/app-installation.md`
