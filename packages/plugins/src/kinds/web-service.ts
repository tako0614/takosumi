import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  optionalNonEmptyString,
  optionalStringRecord,
  requireNonEmptyString,
  requirePositiveInteger,
  requireRoot,
} from "./_validators.ts";
import {
  WEB_SERVICE_CAPABILITIES,
  WEB_SERVICE_DESCRIPTION,
  WEB_SERVICE_KIND_ID,
  WEB_SERVICE_KIND_VERSION,
  WEB_SERVICE_OUTPUT_FIELDS,
  type WebServiceCapability,
  type WebServiceOutputs,
  type WebServiceResources,
  type WebServiceScale,
  type WebServiceSpec,
} from "./web-service.generated.ts";

export type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceResources,
  WebServiceScale,
  WebServiceSpec,
};

/**
 * `web-service@v1` component kind descriptor. Materialized by a provider
 * adapter at apply time.
 */
export const WebServiceKind: Shape<
  WebServiceSpec,
  WebServiceOutputs,
  WebServiceCapability
> = {
  id: WEB_SERVICE_KIND_ID,
  version: WEB_SERVICE_KIND_VERSION,
  description: WEB_SERVICE_DESCRIPTION,
  capabilities: WEB_SERVICE_CAPABILITIES,
  outputFields: WEB_SERVICE_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.image, "$.image", issues);
    requirePositiveInteger(value.port, "$.port", issues);
    validateScale(value.scale, issues);
    optionalStringRecord(value.env, "$.env", issues);
    optionalStringRecord(value.bindings, "$.bindings", issues);
    if (value.resources !== undefined) {
      validateResources(value.resources, issues);
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
  if (!isNonNegativeInteger(value.min)) {
    issues.push({
      path: "$.scale.min",
      message: "must be a non-negative integer",
    });
  }
  requirePositiveInteger(value.max, "$.scale.max", issues);
  if (
    isNonNegativeInteger(value.min) && isPositiveInteger(value.max) &&
    value.min > value.max
  ) {
    issues.push({
      path: "$.scale",
      message: "scale.min must be less than or equal to scale.max",
    });
  }
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
