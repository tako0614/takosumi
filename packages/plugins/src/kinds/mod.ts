/**
 * Bundled component kind catalog (`worker / postgres / object-store /
 * oidc / custom-domain`).
 *
 * Each kind exports a `*Kind` descriptor; the v1 AppSpec installer
 * pipeline materializes components through provider plugins keyed off
 * `Component.kind`. Legacy `*Shape` aliases are kept until the rest of
 * the workspace flips to the new names in Phase C of the Wave 5 reset.
 */
import { registerShape, type Shape } from "takosumi-contract";
import { WebServiceKind } from "./web-service.ts";
import { ObjectStoreKind } from "./object-store.ts";
import { DatabasePostgresKind } from "./database-postgres.ts";
import { CustomDomainKind } from "./custom-domain.ts";
import { WorkerKind } from "./worker.ts";
import { OidcKind } from "./oidc.ts";

export {
  CustomDomainKind,
  DatabasePostgresKind,
  ObjectStoreKind,
  OidcKind,
  WebServiceKind,
  WorkerKind,
};

/** Backwards-compat aliases — removed in Wave 5 Phase C. */
export {
  CustomDomainKind as CustomDomainShape,
  DatabasePostgresKind as DatabasePostgresShape,
  ObjectStoreKind as ObjectStoreShape,
  WebServiceKind as WebServiceShape,
  WorkerKind as WorkerShape,
};

export type {
  CustomDomainCapability,
  CustomDomainCertificate,
  CustomDomainCertificateKind,
  CustomDomainOutputs,
  CustomDomainRedirect,
  CustomDomainSpec,
} from "./custom-domain.ts";
export type {
  DatabasePostgresBackups,
  DatabasePostgresCapability,
  DatabasePostgresOutputs,
  DatabasePostgresSize,
  DatabasePostgresSpec,
  DatabasePostgresStorage,
} from "./database-postgres.ts";
export type {
  ObjectStoreCapability,
  ObjectStoreLifecycle,
  ObjectStoreOutputs,
  ObjectStoreSpec,
} from "./object-store.ts";
export type {
  OidcCapability,
  OidcOutputs,
  OidcSpec,
} from "./oidc.ts";
export type {
  WebServiceCapability,
  WebServiceHealth,
  WebServiceOutputs,
  WebServiceResources,
  WebServiceScale,
  WebServiceSpec,
} from "./web-service.ts";
export type { WorkerCapability, WorkerOutputs, WorkerSpec } from "./worker.ts";

export const TAKOSUMI_BUNDLED_KINDS: readonly Shape[] = [
  WebServiceKind as Shape,
  ObjectStoreKind as Shape,
  DatabasePostgresKind as Shape,
  CustomDomainKind as Shape,
  WorkerKind as Shape,
  OidcKind as Shape,
];

/** Backwards-compat alias — removed in Wave 5 Phase C. */
export const TAKOSUMI_BUNDLED_SHAPES = TAKOSUMI_BUNDLED_KINDS;

export function registerTakosumiKinds(): void {
  for (const kind of TAKOSUMI_BUNDLED_KINDS) {
    registerShape(kind);
  }
}

/** Backwards-compat alias — removed in Wave 5 Phase C. */
export const registerTakosumiShapes = registerTakosumiKinds;
