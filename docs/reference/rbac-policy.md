# RBAC Policy

> このページでわかること: RBAC ポリシーのモデルと設定方法。

account / space / AppInstallation / AppBinding / AppGrant に対する RBAC は
operator の account plane が所有する (reference 実装: `takosumi-cloud/` の
Takosumi Accounts)。 takosumi kernel の provider authorization は次の範囲に
限られる:

- operator configuration
- deploy token policy
- ProviderPlugin contract
- runtime-agent trust

## 関連ページ

- `takosumi-cloud/docs/accounts-service.md`
- `docs/platform/app-installation.md`
- [Namespace Exports](/reference/namespace-exports)
