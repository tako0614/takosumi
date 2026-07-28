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
blueprint or a Takoform Form descriptor converge on the same records.

```http
POST /v1/interfaces
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
non-secret JSON. An Interface is owned by a Workspace, Capsule, or Resource and is not
copied into a second declaration system.

Typed Resources also have an `interfaces` field, but it plays a different role. There it
lists the ways you want that Resource to be usable, and Takosumi picks a Target that
provides every one of them.

```json
{
  "kind": "ObjectBucket",
  "metadata": { "name": "assets", "space": "prod" },
  "spec": {
    "name": "assets",
    "interfaces": ["s3_api", "signed_url"]
  }
}
```

## Mapping the values you publish

`inputs` says, for each name, where its value comes from. There are three kinds of
`source`.

| `source` | Where the value comes from | What goes with it |
| --- | --- | --- |
| `literal` | A value written straight into the declaration | `value` |
| `capsule_output` | A published Output of a Capsule | `output_name`, optionally `capsule_id` |
| `resource_output` | A published Output of a Resource | `resource_id`, `output_name` |

Omitting `capsule_id` under `capsule_output` reads the Output of the declaring Capsule
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

`resource_uri_input` names the input used as the token's audience. The resolved value is
readable from the Interface's `status.resolvedInputs`, and where it came from from
`status.provenance`.

## Reading state and authorization

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example/bindings" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

## Tokens for calling

For an authorized Interface, you mint a single-use token. The only credential that may ask
for one is the OAuth access token handed to the runtime that calls the Interface. Using
the control plane token from the examples above returns `403`.

```bash
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/v1/interfaces/if_example/token" \
  -H "authorization: Bearer $TAKOSUMI_RUNTIME_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "permission": "example.invoke" }'
```

The token you get back behaves as follows.

- The response is OAuth-shaped, with `access_token`, `token_type`, `expires_in`,
  `expires_at`, `scope`, and `resource`
- The prefix is `taksrv_`
- **It lives for a very short time and has no refresh token.** Ask for a new one each time
- Its reach is limited to the permission you requested and the audience the Interface
  names

It is not something to reuse over a long period, so design for fetching one per execution.

## What to check when a call does not go through

1. Whether the Interface's `status.phase` is `Resolved`
2. Whether an InterfaceBinding exists for the caller and its `status.phase` is `Ready`
3. Whether the permission you requested is included in that Binding
4. Whether the token has expired

If any of these does not hold, Takosumi **stops there**.

A successful Resource refresh re-resolves the versions of related Interfaces. That is why
one can read `Unknown` briefly right after a deployment.

## Related

- [Resources](./resources.md)
- [State and outputs](./state-and-outputs.md)
