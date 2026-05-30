import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  optionalBoolean,
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
  type WebServiceHealthCheck,
  type WebServiceOutputs,
  type WebServiceResources,
  type WebServiceScale,
  type WebServiceSpec,
  type WebServiceVolume,
} from "./web-service.generated.ts";

export type {
  WebServiceCapabilityTerm,
  WebServiceHealthCheck,
  WebServiceOutputs,
  WebServiceResources,
  WebServiceScale,
  WebServiceSpec,
  WebServiceVolume,
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
      [
        "image",
        "port",
        "scale",
        "env",
        "resources",
        "healthCheck",
        "volumes",
      ],
      issues,
    );
    requireNonEmptyString(value.image, "$.image", issues);
    requirePort(value.port, "$.port", issues);
    if (value.scale !== undefined) validateScale(value.scale, issues);
    optionalStringRecord(value.env, "$.env", issues);
    if (value.resources !== undefined) {
      validateResources(value.resources, issues);
    }
    if (value.healthCheck !== undefined) {
      validateHealthCheck(value.healthCheck, issues);
    }
    if (value.volumes !== undefined) {
      validateVolumes(value.volumes, issues);
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

function optionalPositiveSeconds(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isPositiveInteger(value)) {
    issues.push({ path, message: "must be a positive integer" });
  }
}

function validateHealthCheck(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.healthCheck", message: "must be an object" });
    return;
  }
  rejectUnknownFields(
    value,
    "$.healthCheck",
    ["path", "interval", "timeout", "unhealthyThreshold", "readinessPath"],
    issues,
  );
  optionalNonEmptyString(value.path, "$.healthCheck.path", issues);
  // interval / timeout are in SECONDS (mirrors takos HealthCheck).
  optionalPositiveSeconds(value.interval, "$.healthCheck.interval", issues);
  optionalPositiveSeconds(value.timeout, "$.healthCheck.timeout", issues);
  optionalPositiveSeconds(
    value.unhealthyThreshold,
    "$.healthCheck.unhealthyThreshold",
    issues,
  );
  optionalNonEmptyString(
    value.readinessPath,
    "$.healthCheck.readinessPath",
    issues,
  );
}

function validateVolumes(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push({ path: "$.volumes", message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    validateVolume(entry, `$.volumes[${index}]`, issues);
  });
}

function validateVolume(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  rejectUnknownFields(value, path, ["source", "target", "persistent"], issues);
  requireNonEmptyString(value.source, `${path}.source`, issues);
  requireNonEmptyString(value.target, `${path}.target`, issues);
  optionalBoolean(value.persistent, `${path}.persistent`, issues);
}
