# Takosumi Final Plan (superseded)

> This is a historical planning record. It is retained so migration and
> release evidence can link to the decisions that preceded the current model.
> It is not the current product direction and it must not be used as a source
> of supported routes, ownership, or release requirements.

The present Takosumi OSS contract is [Core Spec](./core-spec.md). In brief:

- the supported user path is one Git/OpenTofu/Terraform Stack flow;
- any runner-installable provider is allowed through explicit provider
  connections, credential recipes, and provider bindings;
- Takosumi ships no first-party Terraform/OpenTofu provider;
- Takoform is an ordinary external provider and portable Form authority stays
  with Takoform;
- generic Interface/InterfaceBinding and Offering contracts remain available;
- Takosumi OSS does not host a Form Registry, FormActivation lifecycle,
  TargetPool, SpacePolicy, or hosted Form instances; and
- Takosumi Cloud is an external Host owner for hosted Forms, backend lifecycle,
  managed capacity, commercial offerings, billing, SLA, and support.

## Retained migration note

Old Resource/Form wire, state, and audit rows may remain readable while an
operator migrates them. The legacy edge is normally absent (`404`). An
operator may set `TAKOSUMI_LEGACY_RESOURCE_DRAIN_ENABLED=1` together with the
authenticated control-plane configuration to expose only the bounded drain:
authenticated Resource list/read/events/observe/delete and TargetPool or
SpacePolicy `GET`/`HEAD`/`DELETE`. Discovery, FormActivation, writes, preview,
import, refresh, and all other legacy operations remain unavailable (`404` or
`410`); enabling the drain never creates a supported authoring flow.

For current contracts, use Core Spec and the product reference docs. For
historical package or exact-FormRef evidence, use the explicitly superseded
runbooks under [`docs/operations/`](../operations/README.md).
