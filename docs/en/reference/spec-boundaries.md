# Specification Boundaries {#specification-boundaries}

Takosumi docs are split into three specification surfaces. They are sibling
contracts with different owners and compatibility promises, not one merged
specification.

| Surface               | Question it answers                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Takosumi core         | Can this source be installed, deployed, rolled back, and recorded?                                               |
| Official Catalog      | Which component kind, material kind, projection, and JSON-LD catalog vocabulary does Takosumi define?            |
| Operator distribution | Which account management, backend/runtime, billing, identity, and dashboard behavior does this operator provide? |

The official catalog is Takosumi-maintained vocabulary adjacent to the core
spec. The core manifest structure stays small; component kind definitions,
material kind definitions, injection modes, and JSON-LD catalog documents live in catalog docs.
Operator distributions such as Takosumi Cloud adopt the core and catalog
contracts, then define their own account management behavior in their own docs.

## Takosumi Core Specification {#takosumi-core-specification}

Core answers: what does the installer receive, validate, and record? It is the
portable contract a compatible installer implements.

Entry point: [Core Specification](./core-spec.md)

Core defines:

- `.takosumi.yml` root structure: `apiVersion`, `metadata.id`, `metadata.name`, `components`, optional `publish`
- component fields: `kind`, `spec`, `connect`, `listen`
- same-manifest component output reference: `component.output`
- publication reference grammar (`listen.path` / `listen.kind`)
- Installation and Deployment lifecycle
- Installer API endpoints
- source input kinds and digest guards

Core parses kind names, material kind names, injection mode names, and platform
service paths as strings, then records resolution details. Catalogs define
component kind, material kind, and projection vocabulary. Operator or product
distribution specs define path inventory and publication visibility.

Core compatibility is based on manifest structure, Installer API behavior,
source and digest guards, Deployment records, and connection resolution
rules. If a manifest uses Takosumi official catalog terms, catalog
compatibility also applies. If it uses operator-provided platform service paths,
publication visibility, or account management APIs, compatibility with that
operator distribution also applies.

## Official Catalog Specification {#official-catalog-specification}

The official catalog answers: which vocabulary does Takosumi define for
describing components and material kinds?

Entry point: [Official Catalog](./catalog.md)

The catalog defines:

- kind definition URIs such as `https://takosumi.com/kinds/v1/worker`
- kind definition metadata for `spec`, output vocabulary, and expected material
  shape
- material kinds such as `http-endpoint`, `service-binding`, `identity.oidc@v1`,
  `billing.port@v1`, and `mcp-server@v1`
- injection mode descriptions such as `env`, `secret-env`, and `upstream`
- access mode enum, sensitivity level, and safe default access metadata
- public JSON-LD catalog documents such as
  `https://takosumi.com/contexts/v1.jsonld` and
  `https://takosumi.com/kinds/v1/*`

A catalog entry describes reusable vocabulary and JSON-LD catalog metadata.
Service path roots, account management URLs, billing owners, identity
issuer policy, and dashboard behavior belong to the operator or product
distribution that provides those services or APIs.

## Operator Distribution Specifications {#operator-distribution-specifications}

An operator distribution answers: around the Takosumi core installer, which
concrete account management, backend/runtime implementation, and admin behavior
does this operator provide?

Takosumi Cloud is one operator distribution. Its normative docs live in
`takosumi-cloud/docs/`; this docs site keeps only the bridge page:
[Takosumi Cloud](./takosumi-cloud.md)

Operator distribution specs define:

- account and Space ownership records
- workload platform service paths and publication visibility
- account management APIs, dashboard, and launch flows
- billing, identity, and policy behavior
- deploy/admin facades around the Installer API
- backend/runtime implementation choices and Deployment record retention

An operator distribution can adopt material kinds from the official catalog. The
catalog defines reusable material shapes. The operator docs define
concrete platform service paths, publication visibility, account management
lifecycle, approval flows, and runtime delivery behavior.

## Placement Guide {#placement-guide}

| A document touches this                                                             | Normative definition belongs here |
| ----------------------------------------------------------------------------------- | --------------------------------- |
| `apiVersion`, `metadata.id`, `metadata.name`, `components`, optional root `publish` | Takosumi core / manifest          |
| `connect`, `listen`, root `publish`, `component.output`, publication grammar        | Takosumi core / manifest          |
| `https://takosumi.com/kinds/v1/*`                                                   | Official Catalog                  |
| material kind and injection mode vocabulary                                         | Official Catalog                  |
| `https://takosumi.com/contexts/v1.jsonld` and catalog JSON-LD kind definitions      | Official Catalog                  |
| operator-provided workload platform service path / publication visibility           | that operator distribution spec   |
| account API, billing flow, identity issuer endpoint, dashboard route                | that operator distribution spec   |
| deploy/admin facade around Installer API                                            | that operator distribution spec   |
| implementation-specific binding loading or kind package wiring                      | implementation docs               |

## Reading Order {#reading-order}

1. [Core Specification](./core-spec.md)
2. [Manifest](./manifest.md)
3. [Official Catalog](./catalog.md) when you need concrete component
   kind or material kind vocabulary
4. [Platform Services](./platform-services.md) when a manifest consumes output
   from outside the same manifest
5. Operator distribution docs when you use operator-provided account management
   services or APIs. Start with [Takosumi Cloud](./takosumi-cloud.md) for
   Takosumi Cloud.
