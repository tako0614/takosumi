# Core Specification {#core-spec}

Takosumi core is the portable contract for installing source into a Space and recording apply results.

## Public Entities

| Entity       | Meaning                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Manifest     | `.takosumi.yml` in a source root. Authors declare components and connections.                  |
| Installation | A manifest installed into a Space, with current state.                                         |
| Deployment   | One apply result, including source identity, `manifestDigest`, status, and non-secret outputs. |

## Component Shape

```yaml
components:
  web:
    kind: worker
    spec: {}
    publish: {}
    listen: {}
```

| Field     | Core meaning                                                                                 |
| --------- | -------------------------------------------------------------------------------------------- |
| `kind`    | A string the operator resolves to a kind definition (Takosumi does not interpret the value). |
| `spec`    | Open object defined by the selected kind's definition.                                       |
| `publish` | Names and output types this component offers.                                                |
| `listen`  | Connections to other components or platform services.                                        |

## Installer API

The public write API has five endpoints:

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

Read APIs for dashboards, CLIs, polling, and support workflows are operator-provided read models around this write lifecycle.

## Source Kinds

| Kind       | Meaning                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `git`      | Remote git source. Apply guard uses resolved commit plus `manifestDigest`.                             |
| `prepared` | Remote source prepared by CI or a build service. Apply guard uses source digest plus `manifestDigest`. |
| `local`    | Kernel-local source tree for development or operator-local use. Apply guard uses `manifestDigest`.     |

Portable Installer API v1 prepared source payloads are uncompressed POSIX tar archives. If an operator-local profile accepts another archive encoding, that encoding is outside the portable v1 compatibility profile. Build recipes, cache metadata, and provenance stay with the build service or operator automation.
