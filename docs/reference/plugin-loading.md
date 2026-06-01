# Reference Adapter Loading {#plugin-loading}

reference kernel は operator-supplied backend adapter を plain array で受け取れます。
これは `@takosjp/takosumi` の実装手段であり、Takosumi-compatible operator に必須
の mechanism ではありません。

operator が決めること:

- adapter package の取得、lockfile、vendoring、private registry policy
- provider credential と secret store
- Terraform/OpenTofu state や provider controller との接続
- PlatformService inventory と binding policy

Takosumi core が受け取ること:

- Source input
- BindingSelection
- resolver が返す ResolvedBinding
- Deployment bindingsSnapshot / outputs

## Related

- [Reference Backend Binding](./kind-bindings.md)
- [Reference Backend Packages](./kind-packages.md)
- [Platform Services](./platform-services.md)
