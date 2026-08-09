# Service Form Host and Offering Separation (superseded)

> Historical decision record. It is retained for migration provenance only;
> [Core Spec](./core-spec.md) is the current authority.

The old proposal combined a Takosumi OSS Form Host, Resource Shape lifecycle,
Form Registry/FormActivation, TargetPool, SpacePolicy, and generic offerings.
That proposal is no longer the supported OSS product boundary.

The current split is:

| Responsibility | Current owner |
| --- | --- |
| Git/OpenTofu control plane, Runs, state, Outputs, audit, provider connections, credential recipes, provider bindings, Interfaces, InterfaceBindings, and generic Offerings | Takosumi OSS |
| Portable Form schemas, packages, provider releases, and conformance | Takoform |
| Hosted Form instances, Form Host lifecycle, target/capacity/backend management, commercial offerings, billing, SLA, and support | Takosumi Cloud (external Host) |

Resource/Form rows and old route names remain only as migration custody. They do
not make OSS a Form Host or a Resource authoring authority. See the current
legacy drain contract in [Core Spec](./core-spec.md#legacy-resourceform-drain).
