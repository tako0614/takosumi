# Operator control MCP adapter

Takosumi OSS provides an optional `/mcp/operator-control/v1` adapter that
publishes the existing public control service as an ordinary `mcp.server`
Interface. Enable it explicitly with
`TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1`, install the plain Git/OpenTofu module
at `opentofu-modules/operator-control-mcp`, and set `takosumi_origin` to the
bare operator origin. The route is `404` and its OAuth resource proof is denied
while the flag is off.

The service-side InstallConfig blueprint and the optional
`takosumi_interface.operator_control` module resource declare the same
`mcp.server@2025-11-25` spec and explicit `endpoint` Output mapping. The resource path
cannot create a Binding; the service-side proposal grants only the installing
Principal `mcp.invoke` with `delivery.type = oauth2`.

Every MCP POST introspects the invocation token against the exact route
resource. Accounts/Core revalidates the current Interface, Ready Principal
Binding, subject, one `mcp.invoke` scope, resolved revision, and Capsule owner
lifecycle. The adapter then strips the raw token, fixes authority to the
introspected Workspace, and delegates to the existing public `/api/v1` control
dispatcher. Capsule and Run arguments are checked against that Workspace before
dispatch, while the public handlers still enforce membership/RBAC, policy,
saved-plan apply guards, Run/state/output updates, and audit.

The fixed tool catalog belongs to this versioned adapter, not to a Takos static
registry. Takos discovers it through live MCP `tools/list`. Read tools carry
`readOnlyHint`; approve/apply carry `destructiveHint`; plan is explicitly not
read-only or idempotent.

See the [Japanese reference](../../reference/operator-control-mcp.md) for the
complete deployment and authority mapping.
