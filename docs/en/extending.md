# Extending Takosumi {#extending}

Takosumi has two extension surfaces.

| Goal                                                | Add this                                |
| --------------------------------------------------- | --------------------------------------- |
| Run an adopted kind on a different cloud or runtime | an implementation binding for that kind |
| Define a new runtime or resource contract           | a kind definition + implementation      |

The manifest records a component kind string (Takosumi does not interpret the value). The operator may resolve a short alias or a direct URI to a kind definition and an implementation binding. The shared specification surface is the kind URI, the kind's definition, output type, and projection behavior; each implementation chooses its own wiring mechanism.

## Add A Kind {#add-a-kind}

A reusable kind publishes a stable kind URI and definition metadata. The operator attaches an implementation binding to make that URI runnable. Official Takosumi kind definitions use JSON-LD as their format.

```json
{
  "@context": "https://takosumi.com/contexts/v1.jsonld",
  "@id": "https://operator.example.com/kinds/cache",
  "name": "cache",
  "spec": {
    "type": "object",
    "properties": {
      "engine": { "enum": ["redis", "valkey"] },
      "size": { "type": "string" }
    },
    "required": ["engine"]
  },
  "publications": {
    "endpoint": {
      "contract": "http-endpoint"
    }
  }
}
```

The manifest side uses a kind value the operator can resolve.

```yaml
components:
  cache:
    kind: https://operator.example.com/kinds/cache
    spec:
      engine: valkey
      size: small
    publish:
      endpoint:
        as: http-endpoint
```

Kind definition metadata is vocabulary for validation, examples, documentation, and helper types. Runtime projection belongs to the operator-selected implementation binding and is recorded in the Deployment record.

## Add An Implementation Binding {#add-an-implementation-binding}

An implementation binding connects a kind definition and output type to a concrete cloud runtime or resource creation/update. The public specification surface is the kind URI, the kind's definition, output type, projection behavior, and non-secret Deployment output.

Adapter loading, separate processes, backend API access, and credential injection belong to the implementation or the operator's configuration.

Implementation bindings should preserve the same public contract:

- spec validation fails before resource creation
- dry-run returns `changes[]` and `expected`
- apply is idempotent for the selected operation
- destroy and rollback only touch the selected resources
- secrets never appear in logs, audit records, or public Deployment output

## Related Pages {#related-pages}

- [Manifest](./reference/manifest.md)
- [Kind Catalog](./reference/type-catalog.md)
- [Platform Services](./reference/external-publications.md)
- [Build Service Boundary](./reference/build-spec.md)
