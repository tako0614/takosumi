# Interfaces

An Interface declares what a deployment offers. Who is allowed to use it is decided by an
InterfaceBinding, so **a declaration on its own lets nobody call anything**.

## The two halves

- **Interface** — the declaration from the side that offers something, describing the
  inputs it has and the permissions it requires
- **InterfaceBinding** — the authorization given to the side that uses it, saying who may
  use it with which permissions

Secret values do not appear in an Interface. What an Interface publishes is the non-secret
values you explicitly mapped.

## Declaring one

The Interface API is the canonical ledger. Declarations materialized from a Capsule
blueprint, or projected by an external Host from a Form descriptor, converge on the same
records. The external Host owns the Form descriptor's definition and realization authority.

```http
POST /api/v1/interfaces
Authorization: Bearer <control token>
Content-Type: application/json
```

```json
{
  "workspaceId": "ws_example",
  "name": "primary-mcp",
  "ownerRef": {
    "kind": "Capsule",
    "id": "capsule_example"
  },
  "spec": {
    "type": "mcp.server",
    "version": "2025-11-25",
    "document": {
      "transport": "streamable-http"
    },
    "inputs": {
      "endpoint": {
        "source": "capsule_output",
        "capsuleId": "capsule_example",
        "outputName": "mcp_url"
      }
    },
    "access": {
      "visibility": "workspace",
      "resourceUriInput": "endpoint"
    }
  }
}
```

`visibility` is one of `private`, `workspace`, or `public`. `document` contains only
non-secret JSON. An Interface is owned by a Workspace or Capsule and is not copied into a
second declaration system. An endpoint may retain old Resource ownership for migration, but
that compatibility path is not a new Interface authoring entry point.

## Mapping the values you publish

`inputs` says, for each name, where its value comes from. There are three kinds of
`source`.

| `source`          | Where the value comes from                    | What goes with it                    |
| ----------------- | --------------------------------------------- | ------------------------------------ |
| `literal`         | A value written straight into the declaration | `value`                              |
| `capsule_output`  | A published Output of a Capsule               | `outputName`, optionally `capsuleId` |
| `resource_output` | A published Output of an old Resource (migration only) | `resourceId`, `outputName`           |

Omitting `capsuleId` under `capsule_output` reads the Output of the declaring Capsule
itself.

When an Output value has structure, `pointer` pulls out one part of it. The syntax is the
JSON Pointer of RFC 6901.

```json
{
  "inputs": {
    "host": {
      "source": "capsule_output",
      "capsuleId": "capsule_example",
      "outputName": "endpoint",
      "pointer": "/hostname"
    }
  }
}
```

`resourceUriInput` names the input used as the token's audience. The resolved value is
readable from the Interface's `status.resolvedInputs`, and where it came from from
`status.provenance`.

## Using another Capsule from a deployed app

An Interface is a provider-side declaration. A consumer Capsule uses the same Interface and
InterfaceBinding ledger to receive a connection and its authorization.

The two declarations remain separate.

- `InstallConfig.interfaceBlueprints` proposes Interfaces that the Capsule **offers**.
- Consumer input mapping lists the Interface aliases and permissions it **consumes**. It is not
  repository metadata, an Output convention, or provider configuration.

Takosumi resolves the Capsule's Interface, Ready InterfaceBinding, and permissions. The runtime
receives only a materialization with exact authority for each alias. It does not receive provider credentials, account ids, native resource ids, or bearer tokens.

After a Binding is revoked or an Interface generation or permission changes, a host must
not fall back to an old materialization. It creates a new exact runtime version or fails
the call closed.

This is an Interface authorization capability. It does not replace the path where an OpenTofu
module uses Cloudflare, AWS, Takoform, or another provider directly.

## Reading state and authorization

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/interfaces/if_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/interfaces/if_example/bindings" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## Tokens for calling

For an authorized Interface, you mint a short-lived token. The only credential that may ask
for one is the OAuth access token handed to the runtime that calls the Interface. Using
the control plane token from the examples above returns `403`.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/interfaces/if_example/token" \
  -H "authorization: Bearer $TAKOSUMI_RUNTIME_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "permission": "example.invoke" }'
```

The token you get back behaves as follows.

- The response is OAuth-shaped, with `access_token`, `token_type`, `expires_in`,
  `expires_at`, `scope`, and `resource`
- **It expires within 60 seconds and has no refresh token.** Ask for a new one when needed
- Its reach is limited to the permission you requested and the audience the Interface
  names
- The issuing host owns the token string format. The bundled Accounts host uses a
  `taksrv_` prefix, but clients must not branch on that prefix

It is not something to reuse over a long period, so design for fetching one per execution.

## What to check when a call does not go through

1. Whether the Interface's `status.phase` is `Resolved`
2. Whether an InterfaceBinding exists for the caller and its `status.phase` is `Ready`
3. Whether the permission you requested is included in that Binding
4. Whether the token has expired

If any of these does not hold, Takosumi **stops there**.

An Output or Interface generation change re-resolves related Bindings. That is why one can read
`Unknown` briefly right after a deployment.

## Related

- [Resource migration internals](./resources.md)
- [State and outputs](./state-and-outputs.md)
