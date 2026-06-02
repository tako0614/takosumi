# Operator Implementation Loading {#operator-implementation-loading}

Takosumi service は operator-supplied backend adapter を起動時 wiring として受け取れます。
これは `@takosjp/takosumi` reference service の実装手段であり、
Takosumi-compatible operator に必須の mechanism ではありません。

operator が決めること:

- adapter code の取得、lockfile、vendoring、private registry policy
- provider credential と secret store
- OpenTofu state や provider controller との接続
- PlatformService inventory と binding policy

Takosumi が受け取ること:

- Source input
- BindingSelection
- resolver が返す ResolvedBinding
- Deployment bindingsSnapshot / outputs

## Related

- [Reference Backend Binding](./kind-bindings.md)
- [Reference Backend Packages](./kind-packages.md)
- [Platform Services](./platform-services.md)
