---
layout: home

hero:
  name: Takosumi
  text: From Manifest to Deployment
  tagline: An operator-portable PaaS toolkit that records application intent, installs it into a Space, and keeps every apply as Deployment history.
  image:
    src: /logo.svg
    alt: Takosumi
  actions:
    - theme: brand
      text: Concepts
      link: ./getting-started/concepts
    - theme: alt
      text: Quickstart
      link: ./getting-started/quickstart
    - theme: alt
      text: Reading Paths
      link: ./getting-started/reading-paths
    - theme: alt
      text: Manifest
      link: ./reference/manifest

features:
  - title: Three public concepts
    details: Manifest, Installation, and Deployment are the portable Takosumi model.
  - title: Small application manifests
    details: A single YAML file declares your databases, APIs, workers, and how they connect.
  - title: Deployment history
    details: Each apply result is recorded as a Deployment that can be audited and used for rollback.
  - title: Operator-owned execution
    details: Your manifest is portable. The operator decides which cloud or runtime actually runs it.
---

## Start Here

| Reader                  | First page                                          |
| ----------------------- | --------------------------------------------------- |
| Choosing what to read   | [Reading Paths](./getting-started/reading-paths.md) |
| New reader              | [Concepts](./getting-started/concepts.md)           |
| Trying the local path   | [Quickstart](./getting-started/quickstart.md)       |
| Writing `.takosumi.yml` | [Manifest](./reference/manifest.md)                 |
| Operating Takosumi      | [Operator Overview](./operator/index.md)            |
| Extending Takosumi      | [Extending Takosumi](./extending.md)                |

For specification details, see
[Specification Boundaries](./reference/spec-boundaries.md).

## Core Model

See [Concepts](./getting-started/concepts.md) for details on the three public
concepts: Manifest, Installation, and Deployment.

| Concept      | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| Manifest     | The `.takosumi.yml` file. Declares your app's components and connections.      |
| Installation | The record of a Manifest installed into a Space. Holds current state.          |
| Deployment   | One apply result. Kept as history; you can roll back to a previous Deployment. |

## Common References

| Goal                                                            | Page                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| Read the whole core contract                                    | [Core Specification](./reference/core-spec.md)             |
| Write `.takosumi.yml`                                           | [Manifest](./reference/manifest.md)                        |
| Look up available component kinds                               | [Official Catalog](./reference/catalog.md)                 |
| Use services provided by the operator                           | [Platform Services](./reference/platform-services.md)      |
| Read Takosumi Cloud account management APIs and facade behavior | [Takosumi Cloud](./reference/takosumi-cloud.md)            |
| Check the core / catalog / Cloud boundary                       | [Specification Boundaries](./reference/spec-boundaries.md) |
| Call install / deploy / rollback automation                     | [Installer API](./reference/installer-api.md)              |
| Inspect CLI commands and environment variables                  | [CLI](./reference/cli.md)                                  |
| Expose your app on a public URL                                 | [HTTP Exposure](./reference/http-exposure.md)              |
| Deploy from CI or a build service                               | [Build Service Boundary](./reference/build-spec.md)        |
