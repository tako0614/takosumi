# Operator Implementation Loading {#operator-implementation-loading}

The Takosumi service can receive operator-supplied backend adapters as a plain
array. This is an implementation mechanism in `@takosjp/takosumi`, not a
requirement for Takosumi-compatible operators.

The operator decides:

- adapter package acquisition, lockfiles, vendoring, and private registry policy
- provider credentials and secret stores
- OpenTofu state or provider controller integration
- PlatformService inventory and binding policy

Takosumi receives:

- Source input
- BindingSelection
- ResolvedBinding from the resolver
- Deployment bindingsSnapshot / outputs

## Related Pages

- [Reference Backend Binding](./kind-bindings.md)
- [Reference Backend Packages](./kind-packages.md)
- [Platform Services](./platform-services.md)
