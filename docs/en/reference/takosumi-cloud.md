# Takosumi Cloud {#takosumi-cloud-distribution}

Takosumi Cloud is a separate operator distribution specification. This page is the Takosumi docs entry point for readers who need Cloud account management behavior after reading the Takosumi core and official type catalog specs.

## Ownership {#ownership}

| Surface                                                              | Owner                                         |
| -------------------------------------------------------------------- | --------------------------------------------- |
| AppSpec / Installation / Deployment / Installer API                  | [Takosumi Core Specification](./core-spec.md) |
| Kind definition vocabulary / output types / injection modes          | [Official Type Catalog](./type-catalog.md)    |
| Accounts / OIDC / billing / dashboard / launch token / deploy facade | Takosumi Cloud distribution specification     |

Takosumi Cloud composes the Takosumi core Installer API with Cloud account management records and APIs. Cloud may adopt output types from the official type catalog, but the Cloud docs define concrete platform service paths, identity behavior, billing integration, dashboard surface, launch token flow, account-facing Installation projection, export/materialize actions, and deploy facade.

Cloud platform service paths include examples such as `identity.primary.oidc` and `billing.primary.account`. Workloads can reference those Cloud-provided outputs with manifest `listen.path`. Output format belongs to the official type catalog; dotted reference grammar belongs to Takosumi core; the concrete paths and lifecycles belong to the Cloud distribution spec.

Cloud can also define account management/admin facade identifiers that compose the [Installer API](./installer-api.md) with authorization, approval, and account management projection. Those identifiers belong to the Cloud distribution spec. They are not workload root `publish` service paths and are not Takosumi core concepts.

## Cloud Spec {#cloud-spec}

The normative Cloud distribution spec is maintained with the Takosumi Cloud docs. The public path is `https://cloud.takosumi.com/docs/`; the local mirror is `https://cloud.takosumi.test/docs/`.

- [Takosumi Cloud docs](https://cloud.takosumi.com/docs/)
- [Japanese: Takosumi Cloud Distribution Contract v1](https://cloud.takosumi.com/docs/ja/spec)
- [English: Takosumi Cloud Distribution Contract v1](https://cloud.takosumi.com/docs/en/spec)

In this repository checkout, the local maintainer paths are `takosumi-cloud/docs/ja/spec.md` and `takosumi-cloud/docs/en/spec.md`. The old root-level Cloud docs pages are only language-entry stubs.

Read this Takosumi page as a bridge only. Cloud account management compatibility is canonical in the Cloud spec. AppSpec, Installation, Deployment, and the Installer API remain canonical in the Takosumi core spec.

## Related Pages {#related-pages}

- [Specification Boundaries](./spec-boundaries.md)
- [Platform Services](./platform-services.md)
- [Manifest](./manifest.md)
- [Installer API](./installer-api.md)
