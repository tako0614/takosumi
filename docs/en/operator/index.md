# Operator Overview {#operator-overview}

The operator's configuration chooses how Takosumi core is exposed and implemented. It supplies Space context, which kinds are enabled, provider credentials, account management APIs, and read APIs.

The [public contract](../getting-started/concepts.md) stays as-is regardless of operator choices.

## Reading Order {#reading-order}

1. [Concepts](../getting-started/concepts.md)
2. [Specification Boundaries](../reference/spec-boundaries.md)
3. [Installer API](../reference/installer-api.md)
4. [Platform Services](../reference/external-publications.md)
5. [Build Service Boundary](../reference/build-spec.md)
6. [Build Service Example](./build-service-profile.md)
7. [Takosumi Cloud Entry](../reference/takosumi-cloud.md)

## Operator Decisions {#operator-decisions}

The operator controls:

- account and Space ownership
- identity, billing, dashboard, and deploy facade behavior
- visible kind definitions and output types
- provider/runtime configuration
- read APIs, history, and support views around the write lifecycle

Reference operator-managed profiles and Takosumi Cloud profiles document their own runtime, database, object storage, and operations requirements.

For Takosumi Cloud, the concrete account management specification lives in `takosumi-cloud/docs/`.

## Related Pages {#related-pages}

- [Installer API](../reference/installer-api.md)
- [Build Service Boundary](../reference/build-spec.md)
- [HTTP Exposure](../reference/http-exposure.md)
- [CLI](../reference/cli.md)
