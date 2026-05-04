# Manifest Model

The manifest is a closed authoring surface. It creates an `IntentGraph`; it is not canonical state. A manifest does not declare a Space. Space is supplied by deploy context, actor auth, API route, operator context, or client profile.

## Allowed public fields

Root fields:

```text
schemaVersion
profile
components
expose
```

Component fields:

```text
target
with
uses
```

Data input fields inside `with`:

```text
source
artifact
```

Object form fields inside `uses`:

```text
use
access
```

Exposure fields inside `expose` entries:

```text
from
host
path
protocol
port
methods
```

`with` is target-specific and is validated by the selected ObjectTarget input schema. `source` and `artifact` are recognized data asset intents within `with`.

Any unknown public field outside target-specific `with` input fails validation.

## Space context

`Space` is outside the manifest. The same manifest can be resolved in different Spaces. Namespace paths, catalog release selection, policy, secrets, artifacts, approvals, journals, observations, and GroupHead are Space-scoped.

```text
manifest + space:acme-prod -> production namespace exports
manifest + space:acme-dev  -> development namespace exports
```

A public manifest must not contain `space`, `tenant`, `org`, or namespace registry configuration fields. Those are deployment context / operator configuration, not authoring intent.

## Target values

Public v1 target values are catalog aliases.

```yaml
components:
  api:
    target: cloudflare-workers
```

Arbitrary descriptor URLs are not part of public v1. Descriptor URLs are adopted through operator catalog ingestion.

## Uses

`uses` creates Link intent.

Short form:

```yaml
uses:
  OAUTH_TOKEN: takos.oauth.token
  BILLING: billing
```

Object form:

```yaml
uses:
  DATABASE_URL:
    use: takos.database.primary
    access: read-write
```

Rules:

- `billing` means `billing.default` only if `billing.default` exists.
- `default` export must not imply admin access.
- Grant-producing exports require explicit `access` unless the export declares a safe default access.
- `read-write` and `admin` are always explicit.
- If a namespace path cannot be resolved deterministically, validation fails.
- If a local namespace shadows a group, environment, Space, operator, external, or imported namespace, policy decides whether it is allowed, approval-required, or denied. Production should deny meaningful shadowing by default.

## Expose

`expose` creates Exposure intent. It does not create a Link.

```yaml
expose:
  web:
    from: api
    host: app.example.com
```

`uses` is internal connection. `expose` is external ingress intent.

## Data inputs

`with.artifact` and `with.source` are authoring inputs that resolve into `DataAsset` references.

```yaml
with:
  artifact:
    kind: oci-image
    uri: ghcr.io/example/api@sha256:...
```

Local paths are unresolved authoring inputs. They must become content-addressed data asset records before apply.

## Manifest to IntentGraph

```text
components.<name>:
  Declared Object intent inside the current Space

components.<name>.target:
  ObjectTarget alias intent

components.<name>.uses:
  Link intent

expose:
  Exposure intent

with.source / with.artifact:
  DataAsset intent
```
