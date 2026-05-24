/**
 * Reference component kind registry. The `worker / web-service / postgres /
 * object-store / gateway` descriptors are distributed by
 * `@takos/takosumi-plugins`,
 * not by the Takosumi AppSpec contract. Operators opt into these aliases and
 * descriptors explicitly when they want the Takos-published reference set.
 *
 * Each reference kind exports a `*Kind` descriptor; the reference installer
 * pipeline materializes components through provider adapters keyed off the
 * operator-resolved `Component.kind` URI.
 *
 * `oidc` is supplied by an operator account plane rather than by the Takosumi
 * AppSpec contract.
 */
import { registerShape, type Shape } from "takosumi-contract";
import { WebServiceKind } from "./web-service.ts";
import { ObjectStoreKind } from "./object-store.ts";
import { DatabasePostgresKind } from "./database-postgres.ts";
import { GatewayKind } from "./gateway.ts";
import { WorkerKind } from "./worker.ts";
import { GATEWAY_KIND_ID, GATEWAY_KIND_URI } from "./gateway.generated.ts";
import {
  DATABASE_POSTGRES_KIND_ID,
  DATABASE_POSTGRES_KIND_URI,
} from "./database-postgres.generated.ts";
import {
  OBJECT_STORE_KIND_ID,
  OBJECT_STORE_KIND_URI,
} from "./object-store.generated.ts";
import {
  WEB_SERVICE_KIND_ID,
  WEB_SERVICE_KIND_URI,
} from "./web-service.generated.ts";
import { WORKER_KIND_ID, WORKER_KIND_URI } from "./worker.generated.ts";

export {
  DatabasePostgresKind,
  GatewayKind,
  ObjectStoreKind,
  WebServiceKind,
  WorkerKind,
};

export type {
  GatewayCapability,
  GatewayOutputs,
  GatewaySpec,
} from "./gateway.ts";
export type {
  DatabasePostgresCapability,
  DatabasePostgresOutputs,
  DatabasePostgresSize,
  DatabasePostgresSpec,
  DatabasePostgresStorage,
} from "./database-postgres.ts";
export type {
  ObjectStoreCapability,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "./object-store.ts";
export type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceResources,
  WebServiceScale,
  WebServiceSpec,
} from "./web-service.ts";
export type { WorkerCapability, WorkerOutputs, WorkerSpec } from "./worker.ts";

export type TakosumiReferenceKindName =
  | typeof WORKER_KIND_ID
  | typeof WEB_SERVICE_KIND_ID
  | typeof DATABASE_POSTGRES_KIND_ID
  | typeof OBJECT_STORE_KIND_ID
  | typeof GATEWAY_KIND_ID;

/**
 * Reference component kind URI aliases published by Takos on takosumi.com.
 * These URLs are external registry descriptors, not contract-owned definitions in the
 * Takosumi AppSpec contract.
 */
export const TAKOSUMI_REFERENCE_KIND_URIS: Readonly<
  Record<TakosumiReferenceKindName, string>
> = Object.freeze(
  {
    [WORKER_KIND_ID]: WORKER_KIND_URI,
    [WEB_SERVICE_KIND_ID]: WEB_SERVICE_KIND_URI,
    [DATABASE_POSTGRES_KIND_ID]: DATABASE_POSTGRES_KIND_URI,
    [OBJECT_STORE_KIND_ID]: OBJECT_STORE_KIND_URI,
    [GATEWAY_KIND_ID]: GATEWAY_KIND_URI,
  } as const,
);

export const TAKOSUMI_REFERENCE_KIND_ALIASES: Readonly<Record<string, string>> =
  TAKOSUMI_REFERENCE_KIND_URIS;

/**
 * The reference catalog: external kinds backed by JSON-LD in
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
