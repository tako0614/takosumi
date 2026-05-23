/**
 * Reference component kind registry. The `worker / web-service / postgres /
 * object-store / custom-domain` descriptors are distributed by
 * `@takos/takosumi-plugins`,
 * not by the Takosumi AppSpec contract. Operators opt into these aliases and
 * descriptors explicitly when they want the Takos-published reference set.
 *
 * Each reference kind exports a `*Kind` descriptor; the v1 AppSpec installer
 * pipeline materializes components through provider plugins keyed off the
 * operator-resolved `Component.kind` URI.
 *
 * `oidc` is supplied by Takosumi Accounts (operator account plane) rather
 * than by the Takosumi AppSpec contract.
 */
import { registerShape, type Shape } from "takosumi-contract";
import { WebServiceKind } from "./web-service.ts";
import { ObjectStoreKind } from "./object-store.ts";
import { DatabasePostgresKind } from "./database-postgres.ts";
import { CustomDomainKind } from "./custom-domain.ts";
import { WorkerKind } from "./worker.ts";

export {
  CustomDomainKind,
  DatabasePostgresKind,
  ObjectStoreKind,
  WebServiceKind,
  WorkerKind,
};

export type {
  CustomDomainCapability,
  CustomDomainOutputs,
  CustomDomainSpec,
} from "./custom-domain.ts";
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
  | "worker"
  | "web-service"
  | "postgres"
  | "object-store"
  | "custom-domain";

/**
 * Reference component kind URI aliases published by Takos on takosumi.com.
 * These URLs are external registry descriptors, not contract-owned definitions in the
 * Takosumi AppSpec contract.
 */
export const TAKOSUMI_REFERENCE_KIND_URIS: Readonly<
  Record<TakosumiReferenceKindName, string>
> = Object.freeze(
  {
    worker: "https://takosumi.com/kinds/v1/worker",
    "web-service": "https://takosumi.com/kinds/v1/web-service",
    postgres: "https://takosumi.com/kinds/v1/postgres",
    "object-store": "https://takosumi.com/kinds/v1/object-store",
    "custom-domain": "https://takosumi.com/kinds/v1/custom-domain",
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
  CustomDomainKind as Shape,
  WorkerKind as Shape,
  WebServiceKind as Shape,
];

export function registerTakosumiReferenceKinds(): void {
  for (const kind of TAKOSUMI_REFERENCE_KINDS) {
    registerShape(kind);
  }
}
