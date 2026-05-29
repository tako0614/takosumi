import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  optionalNonEmptyString,
  optionalStringRecord,
  rejectUnknownFields,
  requireHttpUrl,
  requireNonEmptyString,
  requirePort,
  requirePositiveInteger,
  requireRoot,
} from "takosumi-contract/reference/shape-validators";
import {
  WEB_SERVICE_CAPABILITY_TERMS,
  WEB_SERVICE_DESCRIPTION,
  WEB_SERVICE_KIND_SHAPE_ID,
  WEB_SERVICE_KIND_VERSION,
  WEB_SERVICE_OUTPUT_FIELDS,
  type WebServiceCapabilityTerm,
  type WebServiceOutputs,
  type WebServiceResources,
  type WebServiceScale,
  type WebServiceSpec,
} from "./web-service.generated.ts";

export type {
  WebServiceCapabilityTerm,
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
  WebServiceCapabilityTerm
> = {
  id: WEB_SERVICE_KIND_SHAPE_ID,
  version: WEB_SERVICE_KIND_VERSION,
  description: WEB_SERVICE_DESCRIPTION,
  capabilityTerms: WEB_SERVICE_CAPABILITY_TERMS,
  outputFields: WEB_SERVICE_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      ["image", "port", "scale", "env", "resources"],
      issues,
    );
    requireNonEmptyString(value.image, "$.image", issues);
    requirePort(value.port, "$.port", issues);
    if (value.scale !== undefined) validateScale(value.scale, issues);
    optionalStringRecord(value.env, "$.env", issues);
    if (value.resources !== undefined) {
      validateResources(value.resources, issues);
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      ["url", "internalHost", "internalPort"],
      issues,
    );
    requireHttpUrl(value.url, "$.url", issues);
    requireNonEmptyString(value.internalHost, "$.internalHost", issues);
    requirePort(value.internalPort, "$.internalPort", issues);
  },
};

function validateScale(value: unknown, issues: ShapeValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.scale", message: "must be an object" });
    return;
  }
  rejectUnknownFields(value, "$.scale", ["min", "max"], issues);
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
  rejectUnknownFields(value, "$.resources", ["cpu", "memory"], issues);
  optionalNonEmptyString(value.cpu, "$.resources.cpu", issues);
  optionalNonEmptyString(value.memory, "$.resources.memory", issues);
}
