# Operator Backend Binding {#kind-binding-implementations}

このページは Takosumi service に backend adapter を接続する実装メモです。public
v1 contract ではありません。

operator は install / deploy request や account-plane UI で選ばれた
`BindingSelection` を、自分の PlatformService inventory に照会します。Takosumi
service は resolver から `ResolvedBinding` を受け取り、Deployment
`bindingsSnapshot` に保存します。

Takosumi service では operator-owned binding implementation を plain array で渡せます。compatible
implementation は同じ Deployment record を保ったまま、OpenTofu workflow、native controller、SaaS adapter で実装できます。

## Source roots

- `src/contract/installer-api.ts` — public DTO
- `src/service/domains/installer/` — Source / InstallPlan / Deployment lifecycle
- operator distribution — optional adapters, runtime handlers, inventory importers

## Related

- [Operator Backend Implementations](./kind-packages.md)
- [Platform Services](./platform-services.md)
