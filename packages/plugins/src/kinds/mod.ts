/**
 * takosumi.com official catalog descriptor helpers. The `worker /
 * web-service / postgres / object-store / gateway` descriptors are distributed
 * by `@takos/takosumi-plugins`. Operators opt into these descriptors and short
 * aliases explicitly when they want the takosumi.com official catalog set.
 *
 * Each reference kind exports a `*Kind` descriptor; the reference installer
 * pipeline materializes components through provider adapters keyed off the
 * operator-resolved `Component.kind` URI.
 *
 * `oidc` is supplied by an operator account plane rather than by the Takosumi
 * AppSpec contract.
 */
import { registerShape, type Shape } from "takosumi-contract/reference/shape";
import { WebServiceKind } from "./web-service.ts";
import { ObjectStoreKind } from "./object-store.ts";
import { DatabasePostgresKind } from "./database-postgres.ts";
import { GatewayKind } from "./gateway.ts";
import { WorkerKind } from "./worker.ts";
import { GATEWAY_KIND_NAME, GATEWAY_KIND_URI } from "./gateway.generated.ts";
import {
  DATABASE_POSTGRES_KIND_NAME,
  DATABASE_POSTGRES_KIND_URI,
} from "./database-postgres.generated.ts";
import {
  OBJECT_STORE_KIND_NAME,
  OBJECT_STORE_KIND_URI,
} from "./object-store.generated.ts";
import {
  WEB_SERVICE_KIND_NAME,
  WEB_SERVICE_KIND_URI,
} from "./web-service.generated.ts";
import { WORKER_KIND_NAME, WORKER_KIND_URI } from "./worker.generated.ts";

export {
  DatabasePostgresKind,
  GatewayKind,
  ObjectStoreKind,
  WebServiceKind,
  WorkerKind,
};

export type {
  GatewayCapabilityTerm,
  GatewayOutputs,
  GatewaySpec,
} from "./gateway.ts";
export type {
  DatabasePostgresCapabilityTerm,
  DatabasePostgresOutputs,
  DatabasePostgresSize,
  DatabasePostgresSpec,
  DatabasePostgresStorage,
} from "./database-postgres.ts";
export type {
  ObjectStoreCapabilityTerm,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "./object-store.ts";
export type {
  WebServiceCapabilityTerm,
  WebServiceOutputs,
  WebServiceResources,
  WebServiceScale,
  WebServiceSpec,
} from "./web-service.ts";
export type {
  WorkerCapabilityTerm,
  WorkerOutputs,
  WorkerSpec,
} from "./worker.ts";

export type TakosumiReferenceKindName =
  | typeof WORKER_KIND_NAME
  | typeof WEB_SERVICE_KIND_NAME
  | typeof DATABASE_POSTGRES_KIND_NAME
  | typeof OBJECT_STORE_KIND_NAME
  | typeof GATEWAY_KIND_NAME;

/**
 * Official component kind URI map for takosumi.com catalog descriptors.
 * The short keys are operator-adopted aliases, not alias authority carried by
 * the descriptor documents themselves.
 */
export const TAKOSUMI_REFERENCE_KIND_URIS: Readonly<
  Record<TakosumiReferenceKindName, string>
> = Object.freeze(
  {
    [WORKER_KIND_NAME]: WORKER_KIND_URI,
    [WEB_SERVICE_KIND_NAME]: WEB_SERVICE_KIND_URI,
    [DATABASE_POSTGRES_KIND_NAME]: DATABASE_POSTGRES_KIND_URI,
    [OBJECT_STORE_KIND_NAME]: OBJECT_STORE_KIND_URI,
    [GATEWAY_KIND_NAME]: GATEWAY_KIND_URI,
  } as const,
);

export const TAKOSUMI_REFERENCE_KIND_ALIASES: Readonly<Record<string, string>> =
  TAKOSUMI_REFERENCE_KIND_URIS;

/**
 * The takosumi.com official catalog helpers: external kind descriptors backed by JSON-LD in
 * `packages/plugins/spec/kinds/v1/*.jsonld`.
 */
export const TAKOSUMI_REFERENCE_KINDS: readonly Shape[] = [
  ObjectStoreKind as Shape,
  DatabasePostgresKind as Shape,
  GatewayKind as Shape,
  WorkerKind as Shape,
  WebServiceKind as Shape,
];

export function registerTakosumiReferenceKinds(): void {
  for (const kind of TAKOSUMI_REFERENCE_KINDS) {
    registerShape(kind);
  }
}
