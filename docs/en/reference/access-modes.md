# Access Modes {#access-modes}

Access modes are Kind Catalog vocabulary. They describe the strength of access selected when published output is delivered to a consuming component.

Manifest authors choose an output source with `listen.from` and a delivery mode with `listen.as`. The resolved access mode comes from operator policy, the platform service entry's `safeDefaultAccess`, and the selected component kind's slot policy. It is recorded in the Deployment record.

```text
read | read-write | admin | invoke-only | observe-only
```

The enum is closed for v1. New access modes require a compatibility update; a provider or connector cannot extend this enum alone.

## Mode Meanings {#mode-meanings}

### `read`

Observation-only access to the published resource. The consumer can inspect state, subscribe to output snapshots, or check schema. Credentials beyond the minimum required for authentication are not generated, and mutation APIs are not projected.

- Allowed: select / get / list / describe / subscribe
- Not allowed: calls that change the resource
- Typical example: a `worker` reads a `postgres` published output in the same Installation graph to build a status view

### `read-write`

`read` plus mutation of the published resource's primary state surface. The consumer can observe and update through the mutation surface described by the component kind definition or platform service entry.

- Allowed: every `read` permission plus insert / update / upsert / delete
- Not allowed: resource lifecycle management such as recreate, drop, re-shard, root credential rotation, or deleting the container itself
- Typical example: a backend worker writes to its own `postgres` component or pushes objects to an `object-store` component

### `admin`

Full management authority for the published resource within the lifecycle surface the provider permits. This is the most privileged closed enum value.

- Allowed: every `read-write` permission plus management operations provided by the component kind definition or selected implementation binding
- Not allowed: cross-resource side effects outside the selected resource's management boundary unless operator policy and approval allow them
- Default behavior: `admin` is never a safe default. It requires explicit operator policy and, where the operator uses approvals, approval flow.
- Typical example: an operator control-plane Space that manages databases; this is rare for application Spaces

### `invoke-only`

The consumer can call the resource through an invocation surface from the component kind definition or platform service entry, but cannot directly read or mutate stored state. State can be observed only through the invocation result.

- Allowed: invoke / call / publish / submit under the component kind invocation contract
- Not allowed: reading accumulated state, observing an internal queue, or mutating outside the invocation envelope
- Typical example: a worker calls another component's invocation output via backend-native private routing or resolved output data, or publishes to a queue without queue read authority

### `observe-only`

The consumer can receive notifications, metrics, or projection events emitted by the published resource, but has no direct access to it. There is no synchronous read, invocation, or mutation authority.

- Allowed: metric / event / notification consumption through the component kind definition's observation surface
- Not allowed: every direct operation against the resource
- Typical example: a metrics aggregator or SIEM consumer subscribes to emission streams from many published resources

## `safeDefaultAccess` {#safeDefaultAccess}

A platform service entry can set `safeDefaultAccess`. It is the default used when resolving a consuming connection and is limited to the safe default subset of the closed enum.

Contract:

- `safeDefaultAccess` is one of `null`, `read`, `invoke-only`, or `observe-only`.
- Mutating modes and administrator modes cannot be defaults.
- If a platform service entry sets `safeDefaultAccess: null`, operator policy must explicitly choose the access mode for the consuming connection. If policy cannot choose, resolution fails with `access-required`.
- The resolved access mode is recorded in the Deployment record whether it came from operator policy or a safe default.

## When Operator Policy Must Choose Access {#link-access}

Operator policy must choose access when:

- the platform service entry's `safeDefaultAccess` is `null`
- a connection delivers output and the consuming component kind spec requires explicit access detail for that slot
- an operator policy pack disables implicit access for the component kind, such as `prod/strict` or `enterprise/kind-approved-only`

If operator policy chooses an access mode unsupported by the component kind's slot, resolution is rejected before resource creation.

## Approval Relationship {#approval-invalidation}

Resolved access mode changes are approval-relevant for operator configurations that use approval workflows. Typical approval-relevant changes:

- a consuming connection's resolved access mode changes
- a platform service entry's `safeDefaultAccess` changes while a consuming connection relied on the default
- a platform service entry starts requiring a stronger mode that needs operator policy review

The concrete approval record, invalidation event, and snapshot model belong to account management. The access mode spec defines the compatibility meaning that `read-write` and `admin` require explicit operator policy or approval selection.

## Related Pages {#related-pages}

- [Kind Catalog](./type-catalog.md)
- [Platform Services](./external-publications.md)
- [Manifest](./manifest.md)
