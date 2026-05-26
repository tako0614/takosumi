# @takos/takosumi-contract

TypeScript DTOs and wire types for Takosumi AppSpec and Installer API. Reference-kernel adapter APIs live under explicit reference implementation subpaths.

This package defines the wire shapes that let a Takosumi distribution read an AppSpec, create an Installation, and record each apply as a Deployment.

## Public spec subpaths

Use the package root or explicit subpath imports for the current v1 public spec surfaces:

| Subpath                                  | Owns                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `@takos/takosumi-contract`               | current AppSpec + Installer API DTOs, plus JSON scalar helper types                      |
| `@takos/takosumi-contract/app-spec`      | `AppSpec`, `Component`, local `publish` / `listen` declarations                          |
| `@takos/takosumi-contract/installer-api` | 5 endpoint Installer API DTOs, `Installation`, `Deployment`, source pins, error envelope |

The root export intentionally excludes deploy-core projections and reference adapter helper types so the current public `AppSpec`, `Installation`, and `Deployment` names stay unambiguous.

## Reference implementation APIs

These subpaths support the takosumi.com reference kernel, runtime-agent, and provider packages. They are versioned with this package, but they are reference implementation APIs rather than AppSpec authoring fields. A compatible implementation may bind kinds through a native controller, static registry, workflow engine, or any other implementation mechanism while keeping the AppSpec and Installer API wire shapes above.

| Subpath                                                      | Owns                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `@takos/takosumi-contract/reference/plugin`                  | reference `KernelPlugin` adapter, material publish / listen hooks                             |
| `@takos/takosumi-contract/reference/plugin-sdk`              | reference adapter SDK for storage, queue, gateway, provider, and process helper ports         |
| `@takos/takosumi-contract/reference/runtime-agent-lifecycle` | kernel to runtime-agent lifecycle envelopes for `apply`, `destroy`, `compensate`, `describe`  |
| `@takos/takosumi-contract/reference/shape`                   | connector-local wire selector registry derived from operator-selected implementation binding  |
| `@takos/takosumi-contract/reference/provider-plugin`         | provider adapter API bridged into `KernelPlugin` for connector-backed packages                |
| `@takos/takosumi-contract/reference/kernel-plugin-adapter`   | adapter bridge from provider-plugin API to the current reference `KernelPlugin` adapter shape |
| `@takos/takosumi-contract/reference/types`                   | reference implementation DTO helpers beyond the root JSON scalar helpers                      |
| `@takos/takosumi-contract/internal/api`                      | reference kernel actor/context DTOs for in-process and internal HTTP boundaries               |
| `@takos/takosumi-contract/internal/rpc`                      | reference internal RPC signing and service directory helpers                                  |
| `@takos/takosumi-contract/reference/compat`                  | compatibility umbrella for reference packages that still need deploy-core bridge helpers      |

`reference/compat` is a migration umbrella for packages that still import the older deploy-core DTOs. New reference implementation code should prefer the specific `reference/*` or `internal/*` subpath it uses.

## AppSpec and Component

The canonical source file is `.takosumi.yml`. The v1 AppSpec contract is the small envelope:

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

`Component.kind` is opaque to the contract package. Operators may map short aliases such as `web-service` to full kind URIs, but alias resolution and kind descriptor selection belong to the operator distribution. Component-specific gateway route/TLS/host rules live inside the selected descriptor-owned open `spec`; workload dependencies use `publish` / `listen`; launch, permission, account, and billing flows are operator distribution surfaces. `publish` declares local publications such as `web.http`; `listen` declares local bindings whose `from` is either a two-segment `component.publication` reference or a three-or-more-segment external publication path such as `publisher.identity.primary`. Takosumi Cloud defines concrete paths such as `operator.identity.oidc` in its own distribution docs. Publication material projection is owned by the kind descriptor and operator-selected implementation binding. Build recipes live outside AppSpec; an operator/build-service distribution may define `.takosumi.build.yml`, CI config, or another input. AppSpec components carry runtime/install intent.

## Installer API

The Installer API is the public API for moving source into Takosumi:

- `POST /v1/installations/dry-run`
- `POST /v1/installations`
- `POST /v1/installations/{id}/deployments/dry-run`
- `POST /v1/installations/{id}/deployments`
- `POST /v1/installations/{id}/rollback`

Requests carry a `Source` (`git`, `prepared`, or dev/operator-local `local`) and an optional expected source pin. Responses return Installation / Deployment records with AppSpec digest (serialized as `manifestDigest`), source, status, and public/non-secret materialized component outputs. Retained implementation / operator evidence lives behind the reference implementation or operator ledger. Dry-runs return changes and expected digests without persisting a plan entity.

## Reference KernelPlugin

`KernelPlugin` is the current takosumi.com reference kernel adapter API. An operator-attached adapter declares the kind URIs it provides, applies a component, optionally destroys it, publishes local publication material, and adapts listened material into env / mount / upstream runtime inputs.

Reference operators attach adapters as plain arrays:

```typescript
await createPaaSApp({
  kindAliases,
  plugins: [workerProvider(), objectStoreProvider()],
});
```

Provider and external adapter packages are optional imports for the reference kernel. Operators choose an implementation set for each distribution.

## Reference Runtime-Agent Lifecycle

These DTOs describe the reference lifecycle envelope used by the takosumi.com runtime-agent topology:

- `LifecycleApplyRequest` / `LifecycleApplyResponse`
- `LifecycleDestroyRequest` / `LifecycleDestroyResponse`
- `LifecycleCompensateRequest` / `LifecycleCompensateResponse`
- `LifecycleDescribeRequest` / `LifecycleDescribeResponse`

AppSpec and the Installer API remain the public conformance surface. Credentials stay outside the kernel. Reference kernel adapters send lifecycle envelopes to a runtime-agent connector, which performs the cloud API or local OS operation and returns opaque handles for internal operation state plus component outputs for local publication material and installer responses. The lifecycle `(shape, provider)` fields are connector-local wire selectors derived from the operator's kind / implementation binding mapping before the lifecycle request is sent.
