# @takos/takosumi-contract

Public TypeScript contract for Takosumi operators, installers, kernels, provider
packages, and runtime-agent implementations.

This package defines the wire shapes and reference-kernel adapter shapes that
let a Takosumi distribution read an AppSpec, create an Installation, record each
apply as a Deployment, bind component kinds to provider implementations, and
delegate resource lifecycle work to a runtime-agent.

## Public surface

Use explicit subpath imports for the current v1 surfaces:

| Subpath                                            | Owns                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@takos/takosumi-contract/app-spec`                | `AppSpec`, `Component`, namespace `publish` / `listen` declarations                          |
| `@takos/takosumi-contract/installer-api`           | 5 endpoint Installer API DTOs, `Installation`, `Deployment`, source pins, error envelope     |
| `@takos/takosumi-contract/plugin`                  | reference `KernelPlugin` adapter, namespace material publish / listen hooks                  |
| `@takos/takosumi-contract/runtime-agent-lifecycle` | kernel to runtime-agent lifecycle envelopes for `apply`, `destroy`, `compensate`, `describe` |

The root export still carries older compatibility types, so `AppSpec` and
Installer API types are intentionally imported through their explicit subpaths
to avoid name collisions.

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
  readonly publish?: readonly string[];
  readonly listen?: Readonly<Record<string, ListenOptions>>;
}
```

`Component.kind` is opaque to the contract package. Operators may map short
aliases such as `web-service` to full kind URIs, but alias resolution and kind
descriptor selection belong to the operator distribution. Component-specific
routes, launch endpoints, permissions, build behavior, and provider details live
inside the component's open `spec` or in the operator's materializer
conventions.

## Installer API

The Installer API is the public HTTP surface for moving source into Takosumi:

- `POST /v1/installations/dry-run`
- `POST /v1/installations`
- `POST /v1/installations/{id}/deployments/dry-run`
- `POST /v1/installations/{id}/deployments`
- `POST /v1/installations/{id}/rollback`

Requests carry a `Source` (`git` or `prepared`) and optional expected source
pin. Responses return Installation / Deployment records and Deployment evidence:
AppSpec digest (serialized as `manifestDigest` for wire compatibility), source,
status, and materialized resources. Dry-runs return changes and expected digests
without persisting a plan entity.

## KernelPlugin

`KernelPlugin` is the takosumi.com reference kernel's operator-attached
materializer adapter. A plugin declares the kind URIs it provides, applies a
component, optionally destroys it, publishes namespace material, and adapts
listened material into env / mount / target runtime inputs.

Operators attach plugins as plain arrays:

```typescript
await createPaaSApp({
  kindAliases,
  plugins: [workerProvider(), objectStoreProvider()],
});
```

Cloud and self-host provider packages are optional imports for the reference
kernel. Operators choose an implementation set for each distribution.

## Runtime-Agent Lifecycle

Runtime-agent lifecycle DTOs are the kernel to data-plane protocol:

- `LifecycleApplyRequest` / `LifecycleApplyResponse`
- `LifecycleDestroyRequest` / `LifecycleDestroyResponse`
- `LifecycleCompensateRequest` / `LifecycleCompensateResponse`
- `LifecycleDescribeRequest` / `LifecycleDescribeResponse`

Credentials live on the runtime-agent side. Kernel-side plugins send lifecycle
envelopes to a runtime-agent connector, which performs the cloud API or local OS
operation and returns opaque handles plus outputs for Deployment evidence and
namespace publishing.
