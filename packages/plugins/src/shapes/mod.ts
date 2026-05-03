import { registerShape, type Shape } from "takosumi-contract";
import { WebServiceShape } from "./web-service.ts";
import { ObjectStoreShape } from "./object-store.ts";
import { DatabasePostgresShape } from "./database-postgres.ts";
import { CustomDomainShape } from "./custom-domain.ts";
import { WorkerShape } from "./worker.ts";

export {
  CustomDomainShape,
  DatabasePostgresShape,
  ObjectStoreShape,
  WebServiceShape,
  WorkerShape,
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
  WebServiceCapability,
  WebServiceHealth,
  WebServiceOutputs,
  WebServiceResources,
  WebServiceScale,
  WebServiceSpec,
} from "./web-service.ts";
export type {
  WorkerCapability,
  WorkerOutputs,
  WorkerSpec,
} from "./worker.ts";

export const TAKOSUMI_BUNDLED_SHAPES: readonly Shape[] = [
  WebServiceShape as Shape,
  ObjectStoreShape as Shape,
  DatabasePostgresShape as Shape,
  CustomDomainShape as Shape,
  WorkerShape as Shape,
];

export function registerTakosumiShapes(): void {
  for (const shape of TAKOSUMI_BUNDLED_SHAPES) {
    registerShape(shape);
  }
}
