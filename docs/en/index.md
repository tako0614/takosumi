---
layout: home

hero:
  name: Takosumi
  text: From Source To Deployment
  tagline: A manifestless source install/deploy ledger. Operators own runtimes and PlatformService inventory.
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
      text: Installer API
      link: ./reference/installer-api
    - theme: alt
      text: Boundaries
      link: ./reference/spec-boundaries

features:
  - title: Four Public Concepts
    details: |
      Source, Installation, Deployment, and PlatformService.
  - title: Manifestless v1
    details: |
      Source repositories do not need Takosumi-specific source metadata files or metadata fields.
  - title: Deployment History
    details: |
      Each apply records a Deployment. Rollback moves the current pointer.
  - title: OpenTofu Stays Operator-Owned
    details: |
      OpenTofu state and provider credentials live in the operator distribution.
---

## Start Here

| Reader | First page |
| --- | --- |
| First-time reader | [Concepts](./getting-started/concepts.md) |
| Try it locally | [Quickstart](./getting-started/quickstart.md) |
| Pick a path | [Reading Paths](./getting-started/reading-paths.md) |
| Implement the API | [Installer API](./reference/installer-api.md) |
| Operate Takosumi | [Operator](./operator/index.md) |

## Public Concepts

| Concept | Meaning |
| --- | --- |
| Source | `git`, `prepared`, or `local` source plus resolved identity. |
| Installation | A Space-scoped installed source record. |
| Deployment | One apply result with plan snapshot, binding snapshot, outputs, and status. |
| PlatformService | Operator-inventory service such as DB, OIDC, bucket, queue, or runtime endpoint. |
