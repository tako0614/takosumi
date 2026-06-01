# Reference Backend Binding {#kind-binding-implementations}

このページは reference kernel に backend adapter を接続する実装メモです。public
v1 contract ではありません。

operator は install / deploy request や account-plane UI で選ばれた
`BindingSelection` を、自分の PlatformService inventory に照会します。Takosumi
core は resolver から `ResolvedBinding` を受け取り、Deployment
`bindingsSnapshot` に保存します。

reference kernel では backend adapter を plain array で渡せます。compatible
implementation は同じ Deployment record を保ったまま、別の controller や
Terraform/OpenTofu workflow で実装できます。

## Source roots

- `src/contract/installer-api.ts` — public DTO
- `src/kernel/domains/installer/` — Source / InstallPlan / Deployment lifecycle
- `takosumi-plugins/` — optional reference adapters and connectors

## Related

- [Reference Backend Packages](./kind-packages.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Platform Services](./platform-services.md)
