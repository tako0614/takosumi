# Reference Backend Binding {#kind-binding-implementations}

This page is an implementation note for attaching backend adapters to the
Takosumi service. It is not the public v1 contract.

An operator resolves `BindingSelection` from install/deploy requests or
account-plane UI through its PlatformService inventory. Takosumi receives a
`ResolvedBinding` from the resolver and stores it in Deployment
`bindingsSnapshot`.

The Takosumi service can receive backend adapters as a plain array. Compatible
implementations can keep the same Deployment record while using other
controllers or OpenTofu workflows.

## Source Roots

- `src/contract/installer-api.ts` — public DTO
- `src/service/domains/installer/` — Source / InstallPlan / Deployment lifecycle
- `takosumi-plugins/` — optional reference adapters and connectors

## Related Pages

- [Reference Backend Packages](./kind-packages.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Platform Services](./platform-services.md)
