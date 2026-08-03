# GA AI Principal fixture

This is a providerless OpenTofu Capsule used by the Cloud GA AI Principal
workflow. It has no provider blocks or resources and emits only the safe
`public_url` output. Takosumi supplies the endpoint and OIDC variables through
the repository manifest; the Cloud operator creates the AI Interface after the
Capsule is applied.
