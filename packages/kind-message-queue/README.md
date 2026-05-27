# @takos/takosumi-kind-message-queue

Message queue for asynchronous producer and consumer workloads.

## Kind Identity

- Kind name: `message-queue`
- Kind URI: `https://takosumi.com/kinds/v1/message-queue`
- Package source: `takosumi/packages/kind-message-queue`
- Descriptor source: `spec/kind.jsonld`
- Suggested aliases: `message-queue`, `queue`

## Spec Fields

- `deliveryDelay`: `integer` - Default delivery delay in seconds.
- `name` (required): `string` - Queue name.

## Output Slot Contract

- `consumer` as `event-channel`
- `producer` as `event-channel`

## Listen Slots

- none

## Outputs

- `queueId` (required): `string` - Implementation-scoped queue identifier.
- `name` (required): `string` - Queue name.
- `url`: `string` - Queue endpoint URL if available.
- `producerTokenSecretRef`: `string` - Secret reference for producer
  credentials.
- `consumerTokenSecretRef`: `string` - Secret reference for consumer
  credentials.

## Capability Terms

- `queue-consume`
- `queue-produce`

## Boundary

This package defines a portable official kind descriptor, generated TypeScript
helpers, and a validator. It does not choose a backend or provision resources.
Operators resolve the kind URI to an implementation binding in their
distribution.
