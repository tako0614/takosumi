# Data endpoints

The Takosumi hosted service can expose standard-protocol data endpoints for existing service
instances. An endpoint is not an object lifecycle API. Create, update, and
delete through the OpenTofu provider graph in the Git repository.

## Endpoint discovery

Read the endpoint URL, audience, and required permission from Run outputs or an
authorized Interface. Do not guess a base URL or tenant hostname.

The authenticated Takosumi catalog reports currently available protocol families.
The hosted-service owner defines this external catalog surface. The Takosumi OSS
platform worker does not mount the retired `/v1/cloud/catalog` path and does not
provide an `/api/v1/cloud/catalog` compatibility alias. Obtain the actual URL
from the hosted-service owner's contract or an authorized Interface.

A normal Takosumi API key, an S3 access key, and a runtime Interface credential
are separate authorities and are not interchangeable.

## S3-compatible object access

Base path: `/compat/s3/v1`

An S3 client uses an access key issued for the bucket and signs requests with
AWS Signature Version 4. A normal Takosumi API key is not an S3 secret
access key.

```text
endpoint: https://app.takosumi.com/compat/s3/v1
authentication: AWS SigV4
```

This path reads and writes objects in an existing bucket. It does not create or
delete the bucket and does not change provider state. The repository's provider
graph owns bucket lifecycle.

## OpenAI-compatible AI access

Base path: `/api/v1/ai`

An OpenAI-compatible client uses a bearer credential authorized for the AI
service or Interface.

```text
base URL: https://app.takosumi.com/api/v1/ai
authentication: Bearer
```

Check the Takosumi catalog and [Pricing](./pricing.md) for model availability,
limits, and price. This endpoint does not create model resources or provider
configuration.

## Takosumi API keys

Create a Takosumi API key in Account settings and save the secret when it is shown
once. Choose the smallest scope and one Workspace for automation. Never write
the secret to a repository, OpenTofu state, output, or Interface document.

Obtain data-endpoint credentials from the corresponding service's Interface or
credential flow. A Takosumi API key is not converted into a data-plane credential.

## Billing and failure behavior

A paid request checks the Workspace, permission, availability, credit, and quota
before the backend call. An unavailable service, missing permission, or
insufficient credit fails closed and never falls back to another service.

A retryable error still needs a fence against duplicate charging or mutation.
When the backend outcome is unknown, the service does not report success and
recovers with the same request identity.

If a problem persists, include the response request ID when contacting
[Support](./support.md). Do not send secrets, access keys, or Authorization
headers.
