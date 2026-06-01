# Reference Adapter Loading {#plugin-loading}

The reference kernel can receive operator-supplied backend adapters as a plain
array. This is an implementation mechanism in `@takosjp/takosumi`, not a
requirement for Takosumi-compatible operators.

The operator decides:

- adapter package acquisition, lockfiles, vendoring, and private registry policy
- provider credentials and secret stores
- Terraform/OpenTofu state or provider controller integration
- PlatformService inventory and binding policy

Takosumi core receives:

- Source input
- BindingSelection
- ResolvedBinding from the resolver
- Deployment bindingsSnapshot / outputs

## Related Pages

- [Reference Backend Binding](./kind-bindings.md)
- [Reference Backend Packages](./kind-packages.md)
- [Platform Services](./platform-services.md)
