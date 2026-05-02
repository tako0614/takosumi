import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  optionalNonEmptyString,
  optionalPositiveInteger,
  optionalStringRecord,
  requireNonEmptyString,
  requirePositiveInteger,
  requireRoot,
} from "./_validators.ts";

export type WebServiceCapability =
  | "always-on"
  | "scale-to-zero"
  | "websocket"
  | "long-request"
  | "sticky-session"
  | "geo-routing"
  | "crons"
  | "private-networking";

export interface WebServiceScale {
  readonly min: number;
  readonly max: number;
  readonly idleSeconds?: number;
}

export interface WebServiceHealth {
  readonly path: string;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface WebServiceResources {
  readonly cpu?: string;
  readonly memory?: string;
}

export interface WebServiceSpec {
  readonly image: string;
  readonly port: number;
  readonly scale: WebServiceScale;
  readonly env?: Readonly<Record<string, string>>;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly health?: WebServiceHealth;
  readonly resources?: WebServiceResources;
  readonly command?: readonly string[];
  readonly domains?: readonly string[];
}

export interface WebServiceOutputs {
  readonly url: string;
  readonly internalHost: string;
  readonly internalPort: number;
}

const CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "scale-to-zero",
  "websocket",
  "long-request",
  "sticky-session",
  "geo-routing",
  "crons",
  "private-networking",
];

const OUTPUT_FIELDS: readonly string[] = [
  "url",
  "internalHost",
  "internalPort",
];

export const WebServiceShape: Shape<
  WebServiceSpec,
  WebServiceOutputs,
  WebServiceCapability
> = {
  id: "web-service",
  version: "v1",
  description:
    "Long-running HTTP service backed by an OCI image or equivalent.",
  capabilities: CAPABILITIES,
  outputFields: OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.image, "$.image", issues);
    requirePositiveInteger(value.port, "$.port", issues);
    validateScale(value.scale, issues);
    optionalStringRecord(value.env, "$.env", issues);
    optionalStringRecord(value.bindings, "$.bindings", issues);
    if (value.health !== undefined) validateHealth(value.health, issues);
    if (value.resources !== undefined) {
      validateResources(value.resources, issues);
    }
    if (value.command !== undefined) {
      if (!Array.isArray(value.command)) {
        issues.push({ path: "$.command", message: "must be an array" });
      } else if (!value.command.every(isNonEmptyString)) {
        issues.push({
          path: "$.command",
          message: "must contain only non-empty strings",
        });
      }
    }
    if (value.domains !== undefined) {
      if (!Array.isArray(value.domains)) {
        issues.push({ path: "$.domains", message: "must be an array" });
      } else if (!value.domains.every(isNonEmptyString)) {
        issues.push({
          path: "$.domains",
          message: "must contain only non-empty strings",
        });
      }
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.url, "$.url", issues);
    requireNonEmptyString(value.internalHost, "$.internalHost", issues);
    requirePositiveInteger(value.internalPort, "$.internalPort", issues);
  },
};

function validateScale(value: unknown, issues: ShapeValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.scale", message: "must be an object" });
    return;
  }
  requirePositiveInteger(value.min, "$.scale.min", issues);
  requirePositiveInteger(value.max, "$.scale.max", issues);
  if (
    isPositiveInteger(value.min) && isPositiveInteger(value.max) &&
    value.min > value.max
  ) {
    issues.push({
      path: "$.scale",
      message: "scale.min must be less than or equal to scale.max",
    });
  }
  optionalPositiveInteger(value.idleSeconds, "$.scale.idleSeconds", issues);
}

function validateHealth(value: unknown, issues: ShapeValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.health", message: "must be an object" });
    return;
  }
  if (!isNonEmptyString(value.path) || !value.path.startsWith("/")) {
    issues.push({
      path: "$.health.path",
      message: "must be an absolute URL path",
    });
  }
  optionalPositiveInteger(
    value.intervalSeconds,
    "$.health.intervalSeconds",
    issues,
  );
  optionalPositiveInteger(
    value.timeoutSeconds,
    "$.health.timeoutSeconds",
    issues,
  );
}

function validateResources(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.resources", message: "must be an object" });
    return;
  }
  optionalNonEmptyString(value.cpu, "$.resources.cpu", issues);
  optionalNonEmptyString(value.memory, "$.resources.memory", issues);
}
