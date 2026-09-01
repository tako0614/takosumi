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

An external service owns routing, model catalogs, upstream credentials,
enforced billing, usage meters, smoke inputs, and failure codes. Takoserver may
offer an OpenAI-compatible data plane as a standard protocol without turning it
into a Form or Takosumi Core resource. Takosumi Hosted may own the retail/client
presentation, but it does not take over Takoserver provider or supply authority.
Takosumi Cloud and its app-docs are retained history, not current authority.

See [Core Spec](core-spec.md#interfaces-and-interfacebindings) for the
authoritative generic boundary. Routing and evidence remain with the external
service owner.
