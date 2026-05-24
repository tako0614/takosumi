# @takos/takosumi-contract

TypeScript DTOs and wire types for Takosumi AppSpec and Installer API.
Reference-kernel adapter helper types and deploy-core projections live under
explicit implementation subpaths.

This package defines the wire shapes that let a Takosumi distribution read an
AppSpec, create an Installation, and record each apply as a Deployment. It also
ships helper types used by the takosumi.com reference implementation to bind
component kinds to materializer adapters and delegate lifecycle work to a
runtime-agent.

## Public spec subpaths

Use explicit subpath imports for the current v1 public spec surfaces:

| Subpath                                  | Owns                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@takos/takosumi-contract/app-spec`      | `AppSpec`, `Component`, local `publish` / `listen` declarations                          |
| `@takos/takosumi-contract/installer-api` | 5 endpoint Installer API DTOs, `Installation`, `Deployment`, source pins, error envelope |

The root export also carries deploy-core projection types, so `AppSpec` and
Installer API types are intentionally imported through their explicit subpaths
to keep imports unambiguous.

## Reference implementation subpaths

These subpaths support the takosumi.com reference kernel and runtime-agent. A
compatible implementation may bind kinds through a native controller, static
registry, workflow engine, or any other implementation mechanism while keeping
the AppSpec and Installer API wire shapes above.

| Subpath                                            | Owns                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@takos/takosumi-contract/plugin`                  | reference `KernelPlugin` adapter, material publish / listen hooks                            |
| `@takos/takosumi-contract/runtime-agent-lifecycle` | kernel to runtime-agent lifecycle envelopes for `apply`, `destroy`, `compensate`, `describe` |

## Implementation Bridge Subpaths

These surfaces support deploy-core projections and connector adapter bridges
used by the reference packages.

| Subpath                                          | Status                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `@takos/takosumi-contract/core-v1`               | internal deploy-core projection for planning code and architecture docs                       |
| `@takos/takosumi-contract/shape`                 | connector-local wire selector registry derived from operator kind/materializer mapping        |
| `@takos/takosumi-contract/provider-plugin`       | provider adapter API bridged into `KernelPlugin` for connector-backed packages                |
| `@takos/takosumi-contract/kernel-plugin-adapter` | adapter bridge from provider-plugin API to the current reference `KernelPlugin` adapter shape |

## AppSpec and Component

The canonical source file is `.takosumi.yml`. The v1 AppSpec contract is the
small envelope:

```typescript
interface AppSpec {
  readonly apiVersion: "v1";
  readonly metadata: AppSpecMetadata;
  readonly components: Readonly<Record<string, Component>>;
}

interface Component {
  readonly kind: string;
  readonly spec?: JsonObject;
  readonly publish?: Readonly<Record<string, PublishOptions>>;
  readonly listen?: Readonly<Record<string, ListenOptions>>;
}

interface PublishOptions {
  readonly as: string;
}

interface ListenOptions {
  readonly from: string;
  readonly as: string;
  readonly prefix?: string;
  readonly mount?: string;
  readonly required?: boolean;
}
```

`Component.kind` is opaque to the contract package. Operators may map short
aliases such as `web-service` to full kind URIs, but alias resolution and kind
descriptor selection belong to the operator distribution. Component-specific
routes, launch endpoints, permissions, and provider details live inside the
component's open `spec` or in the operator's materializer conventions. `publish`
declares local publications such as `web.http`; `listen` declares local bindings
whose `from` is either `component.publication` or `namespace:<operator.export>`.
Publication material projection is owned by the kind descriptor/materializer,
not by AppSpec output selectors. Build recipes live in build-service input such
as `.takosumi.build.yml`; the AppSpec component does not carry build steps.

## Installer API

The Installer API is the public HTTP surface for moving source into Takosumi:

- `POST /v1/installations/dry-run`
- `POST /v1/installations`
- `POST /v1/installations/{id}/deployments/dry-run`
- `POST /v1/installations/{id}/deployments`
- `POST /v1/installations/{id}/rollback`

Requests carry a `Source` (`git`, `prepared`, or dev/operator-local `local`) and
an optional expected source pin. Responses return Installation / Deployment
records and Deployment evidence: AppSpec digest (serialized as
`manifestDigest`), source, status, and materialized component outputs. Dry-runs
return changes and expected digests without persisting a plan entity.

## Reference KernelPlugin

`KernelPlugin` is the current takosumi.com reference kernel adapter API. An
operator-attached adapter declares the kind URIs it provides, applies a
component, optionally destroys it, publishes local publication material, and
adapts listened material into env / mount / upstream runtime inputs.

Reference operators attach adapters as plain arrays:

```typescript
await createPaaSApp({
  kindAliases,
  plugins: [workerProvider(), objectStoreProvider()],
});
```

Cloud and self-host provider packages are optional imports for the reference
kernel. Operators choose an implementation set for each distribution.

## Reference Runtime-Agent Lifecycle

Runtime-agent lifecycle DTOs are the kernel to data-plane protocol:

- `LifecycleApplyRequest` / `LifecycleApplyResponse`
- `LifecycleDestroyRequest` / `LifecycleDestroyResponse`
- `LifecycleCompensateRequest` / `LifecycleCompensateResponse`
- `LifecycleDescribeRequest` / `LifecycleDescribeResponse`

Credentials live on the runtime-agent side. Reference kernel adapters send
lifecycle envelopes to a runtime-agent connector, which performs the cloud API
or local OS operation and returns opaque handles for internal operation state
plus component outputs for namespace publishing and installer responses. The
lifecycle `(shape, provider)` fields are connector-local wire selectors derived
from the operator's kind/materializer mapping before the lifecycle request is
sent.
