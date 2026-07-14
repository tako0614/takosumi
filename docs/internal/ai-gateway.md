# AI Gateway extension boundary

AI Gateway is not a Takosumi OSS product feature, default Resource Shape, or
OpenTofu provider resource. An operator or closed hosting layer may mount an
OpenAI-compatible service through the generic extension seam, but Takosumi Core
does not know its upstream providers, credentials, prices, or implementation.

Runtime discovery and authorization use the shared `Interface` and
`InterfaceBinding` APIs:

```text
ordinary public OpenTofu/Resource output
  -> explicit service-side Interface input mapping
  -> Resolved Interface revision
  -> exact Ready InterfaceBinding
  -> invocation-time credential delivery
```

An AI service can use an opaque namespaced Interface type such as
`takosumi.ai.gateway`; Core stores and resolves it without interpreting its
protocol document. Endpoint values are public, non-secret Interface inputs.
Credentials are delivered by the selected InterfaceBinding handler and are not
OpenTofu Outputs, module variables, repository metadata, reserved Output names,
or a runtime registry encoded in state.

OSS requirements are deliberately generic:

- unknown Interface types remain storable and resolvable;
- access requires one exact binding and permission;
- unsupported delivery types fail closed;
- secrets never enter `Interface.document`, Outputs, state, or audit payloads;
- mounting or changing an extension does not create a Workspace-wide OpenTofu
  reconcile;
- unmounted extension routes are absent rather than emulated by an OSS fallback.

Official hosted routing, model catalogs, upstream credentials, enforced
billing, usage meters, smoke inputs, and failure codes are owned by the closed
Cloud delta. Its operator runbook lives at
`takosumi-cloud/docs/operations/ai-gateway.md`; customer-facing behavior lives
in `app-docs`.

See [Final Plan](final-plan.md#44-ai-gateway-is-not-a-resource-shape) and
[Core Spec](core-spec.md) for the authoritative generic boundaries.
