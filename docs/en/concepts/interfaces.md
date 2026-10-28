# Interfaces

An Interface declares what a deployment offers. Who is allowed to use it is decided by an
InterfaceBinding, so **a declaration on its own lets nobody call anything**.

## Declaration, selection, and authorization

- **Interface** — the declaration from the side that offers something, describing the
  inputs it has and the permissions it requires
- **InterfaceLink** — the durable link from a consumer Capsule and requirement key to the
  selected provider Interface and Capsule, with requested and approved permissions
- **InterfaceBinding** — the authorization given to the side that uses it, saying who may
  use it with which permissions

Secret values do not appear in an Interface. What an Interface publishes is the non-secret
values you explicitly mapped.

To declare a screen from your own repository and show it on the dashboard home, see
[Show your app on the home screen](../getting-started/home-launcher.md). This page covers
working with the Interface API directly.

## Declaring one

The Interface API is the canonical ledger. Declarations generated from a Capsule
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

`inputs` says, for each name, where its value comes from. There are two kinds of
`source`.

| `source`          | Where the value comes from                    | What goes with it                    |
| ----------------- | --------------------------------------------- | ------------------------------------ |
| `literal`         | A value written straight into the declaration | `value`                              |
| `capsule_output`  | A published Output of a Capsule               | `outputName` (and `capsuleId` in the API) |

In the Interface API (`spec.inputs` of `POST /api/v1/interfaces`), `capsule_output` needs
`capsuleId`, even to read the Output of the declaring Capsule itself. In a Capsule blueprint
(`interfaceBlueprints` or the repository's declaration), leave `capsuleId` out: the declaring
Capsule is filled in, and an explicit value is rejected.

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

## Using another Capsule from a deployed service

In a repository's `.well-known/takosumi.json`, `interfaces` declares what the Capsule
**offers**. `requires[].kind: "interface.consume"` declares the type, version, and permissions
it **uses**. After review, these become `interfaceBlueprints` and `requiredInterfaces` in the
stored InstallConfig. The manifest contains no provider ID or credentials. See the
[Repository manifest](../reference/repository-manifest.md#requires) for the declaration format.

During installation, choose a matching `Resolved` provider that you can open. With no
candidates, choose later. A single candidate is selected automatically. With several, choose
a provider or later. An InterfaceLink stores the selected provider Interface and Capsule.
Adding another provider, or losing access to the current one, never switches to another
candidate automatically.

A link is `pending_approval`, `active`, `declined`, or `revoked`. It records requested and
approved permissions separately. Only an active link can create ordinary InterfaceBindings.
A replaceable policy decides approval; the current Workspace composition immediately
approves same-Workspace links. An unset link does not prevent OIDC sign-in; it creates no
Binding for that link.

At runtime, Takosumi checks the provider pinned by the active link, the calling Principal's
Ready InterfaceBinding, and the permission. Interface values and credentials never flow into
the consumer's OpenTofu variables or state.
The host's runtime receives only a materialization scoped to each alias's permissions.
It does not receive provider credentials, account ids, native resource ids, or bearer
tokens.

After a Binding is revoked or an Interface generation or permission changes, a host must
not fall back to an old materialization. It builds a new runtime version, or fails the call
rather than run with stale permissions.

This is an Interface authorization capability. It does not replace the path where an OpenTofu
module uses Cloudflare, AWS, Takoform, or another provider directly.

## Viewing and changing links

The app page shows outgoing links in `links.uses` and incoming links in `links.usedBy`.
Problems report `interface_link_unset` for an unset link, `interface_link_unavailable` for
an unavailable provider, or `interface_link_degraded` for a provider scheduled for removal.
The action to repair a link is `fix_interface_link`.

Use the [Interface link API](../reference/api.md#interface-links) with app management access to
list candidates, select another provider, or unlink. Selecting a provider creates its
Binding before revoking the old Binding, and needs no Plan. Send the `generation` you read
as `expectedGeneration` when changing a link.

The uninstall confirmation shows incoming consumers in `uninstall.impact.usedBy`.
Uninstalling a provider leaves consumer apps in place. It neither selects a replacement nor
rewrites the link's state: availability is computed from the current provider.

The store matches Git URL and module to show an installed badge and Open. Choose Add another
to install the same app again. Each new installation is an independent app; data and settings
are not shared.

## Reading state and authorization

Put a [token you created](../reference/cli.md#creating-a-token) with `read` in
`$TAKOSUMI_DEPLOY_CONTROL_TOKEN` for these examples.

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
