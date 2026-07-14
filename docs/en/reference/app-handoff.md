# App Handoff Protocol

Takosumi App Handoff is the small URL protocol for creating a Takosumi-managed
hosted service from any client: web app, desktop app, mobile app, browser link,
or CLI output.

Host Center is a web/dashboard flow. This protocol does not require or imply a
standalone Takosumi mobile app; clients return to their own product app or web
callback URL.

It is not a mobile-only protocol and it is not a product registry. Takosumi
receives a plain OpenTofu/Terraform source, creates a Capsule, runs the normal
Takosumi flow, then optionally returns a connection payload to the client.

```text
client
  -> /install URL
  -> Takosumi Host Center
  -> Source / Capsule / ProviderBinding / Run
  -> StateVersion / Output
  -> optional return_uri
```

## Entry URL

The public entrypoint is on the Takosumi origin selected by the operator:

```text
https://<takosumi-origin>/install
```

The official Takosumi Cloud origin is `app.takosumi.com`, but the same protocol
works at any explicit self-hosted or Operator origin.

The dashboard may canonicalize the flow to `/new`, but external clients should
link `/install`.

Supported query parameters:

| Parameter    | Required | Meaning                                             |
| ------------ | -------- | --------------------------------------------------- |
| `git`        | no       | HTTPS Git URL for a plain OpenTofu/Terraform module |
| `source`     | no       | Packed module address, for example `git::...?...`   |
| `ref`        | no       | Git branch, tag, or commit                          |
| `path`       | no       | Module path inside the repository                   |
| `name`       | no       | Display name for the service                        |
| `var.<name>` | no       | Non-secret visible module input                     |
| `product`    | no       | Client product key, only with `return_uri`          |
| `return_uri` | no       | Connection payload target, only with `product`      |

`git` or `source` selects what Takosumi should create. Store nodes are
discovery / presentation entrypoints that prefill this URL; they are not the
creation target or release-ref authority. `product` does not select the install
target. Use `product` and `return_uri` together only when Takosumi should return
to a client.

If `return_uri` is absent, the flow is just a normal hosted-service creation
link. In that case, do not include `product`. If `return_uri` is present,
Takosumi preserves `product` and `return_uri` through sign-in, provider
connection setup, plan, and apply screens.

These forms do not exist:

```text
/install?=product
/install?product
/install?product=notes-app
```

They do not specify an OpenTofu source, so there is no install target.

Example:

```text
https://takosumi.example.com/install
  ?git=https%3A%2F%2Fgit.example.com%2Facme%2Fnotes.git
  &ref=v1.2.3
  &path=deploy%2Fopentofu
  &product=notes-app
  &return_uri=notesapp%3A%2F%2Fconnect
```

## OpenTofu-Native Flow

The URL does not install anything by itself. It only pre-fills an explicit
dashboard flow:

```text
Git URL / ref / path
  -> Source
  -> Capsule
  -> ProviderBinding review
  -> Run(plan)
  -> Run(apply)
  -> StateVersion / Output
```

The source repository stays a plain OpenTofu/Terraform module. Takosumi does not
require a Takosumi-specific source metadata file or product-specific metadata
file.

`var.<name>` is for non-secret visible inputs only. Secrets, tokens, provider
credentials, and private keys must come from Provider Connections, Credential
Recipes, Provider Bindings, Secrets, or product-owned setup flows.

## Return Payload

After a successful apply, Takosumi builds a connect URL by appending query
parameters to `return_uri`:

```text
<return_uri>
  ?host_url=https%3A%2F%2Fcreated-host.example
  &product=notes-app
  &run_id=run_...
  &capsule_id=cap_...
```

`setup_ticket` may be added when a product-owned setup flow needs a one-time
handoff token.

The client then discovers the host through:

```text
GET /.well-known/takosumi
GET /v1/capabilities
```

If the client needs product-specific metadata, it may also read:

```text
GET /.well-known/<product>
```

Takosumi does not probe for first-party product names.

## Product Key And Return URI Rules

`product` is a generic lower-case key:

```text
^[a-z0-9][a-z0-9._:-]{0,63}$
```

It is not a Takosumi enum. `takos`, `yurucommu`, and future apps all use the
same field as ordinary clients.

`return_uri` may be:

```text
notesapp://connect
https://app.example/connect
```

It must be absolute, contain no username/password, and contain no existing query
or fragment. Takosumi appends the connect payload itself.

## Boundary

Takosumi owns the protocol, Host Center flow, Source/Capsule/Run lifecycle,
state, output, audit, provider connection review, and capability discovery.

The client owns product UI, custom scheme handling, web callback handling,
native plugins, push notification registration, calls, and any product-owned
post-connect API calls.

Push notification delivery is not a Takosumi Resource Shape or provider. A
client may send a product-owned device token to its own host API after connect,
but Takosumi does not advertise a push capability.
