# External Takoform Host boundary

Takosumi OSS does not embed a Takoform Host. Takoform is an ordinary OpenTofu
provider selected by the Git module, like Cloudflare, AWS, or Kubernetes.

```text
Workspace/customer ProviderConnection
  → CredentialRecipe
  → ProviderBinding
  → Run-scoped runner materialization
  → Takoform provider
  → external Host API
```

The ProviderConnection carries a Host-scoped credential for the external Host
chosen by the user. Takosumi never receives or selects the Host's parent
provider credential, provider installation, backend, capacity, placement,
Workers for Platforms namespace/dispatcher, or native resource identity.

## Managed-supply owner

Takoserver is the external Takoform Host for Host-owned supply. The Takoserver
operator owns capacity and credentials it procures, resells under permitted
terms, or operates itself, together with Offering, Resource/Deployment,
migration, meter, receipt, and support/commercial policy. Takoserver has no
customer-vendor-credential BYOC lane.

Takosumi Hosted may provide retail, commerce, or client composition, but it
does not take over Takoserver's Offering, capacity, provider credential, or
execution authority. Takosumi Cloud is a retired historical identity.

## No current embedded Host surface

The old Resource Shape, Form Registry/FormActivation, TargetPool, SpacePolicy,
Form Host discovery, Generic Offering, and `/v1/resources` lifecycle are not
supported authoring surfaces. The ordinary platform Worker does not mount them;
retired paths remain `404`. No environment variable, runtime object, or
compatibility-host injection is a current contract for enabling another
same-origin Host lifecycle.

Routes, stores, schemas, or configuration names that remain in source are
implementation conformance gaps and migration/delete custody. New integrations,
providers, dashboards, and runner code must not depend on them.

## Migrating retained data

Use the bounded drain defined by
[Resource migration internals](../concepts/resources.md) for authenticated
read/observe/delete of retained Resource/Form rows. The drain does not enable
discovery, preview, apply, update, Form transition, or Offering selection.

If a provider mutation is unavoidable during migration, do not restore it as a
public platform-Worker/Core route or composition. The operator runs a one-time,
target-fixed migration tool with exact identities, a dedicated credential, an
at-most-once operation, provider receipt, backup/restore, and readback evidence,
then deletes the tool. It is not a second Takosumi Core lifecycle.

Pin current Host API, Form, package, provider identity, and version from the
owning [Takoform Core](https://github.com/tako0614/takoform),
[Form publisher](https://github.com/tako0614/takoform-forms), and
[OpenTofu provider](https://github.com/tako0614/terraform-provider-takoform)
repositories using exact immutable identities.
