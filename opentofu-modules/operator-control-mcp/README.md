# Operator control MCP adapter Capsule

This plain OpenTofu module publishes the optional Takosumi platform route as an
ordinary `endpoint` Output. The operator must enable
`TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1`; otherwise the route is absent and an
OAuth2 InterfaceBinding cannot become Ready for it.

By default, Takosumi's service-side InstallConfig blueprint materializes the
`mcp.server` Interface. Set `declare_interface_resource = true` to exercise the
equivalent module-author path. The `takosumi_interface` resource never creates
an InterfaceBinding; the same service-side blueprint contributes the installing
Principal's `mcp.invoke` / `oauth2` binding proposal.

The adapter's tool catalog is versioned with `/mcp/operator-control/v1` and is
owned by this Takosumi adapter. Takos discovers it with MCP `tools/list`; Takos
does not carry these tools in a static registry.
