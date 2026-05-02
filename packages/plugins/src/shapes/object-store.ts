import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonNegativeInteger,
  isRecord,
  optionalBoolean,
  optionalNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";

export type ObjectStoreCapability =
  | "versioning"
  | "presigned-urls"
  | "server-side-encryption"
  | "public-access"
  | "event-notifications"
  | "lifecycle-rules"
  | "multipart-upload";

export interface ObjectStoreLifecycle {
  readonly expireAfterDays?: number;
  readonly archiveAfterDays?: number;
}

export interface ObjectStoreSpec {
  readonly name: string;
  readonly public?: boolean;
  readonly versioning?: boolean;
  readonly region?: string;
  readonly lifecycle?: ObjectStoreLifecycle;
}

export interface ObjectStoreOutputs {
  readonly bucket: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyRef: string;
  readonly secretKeyRef: string;
}

const CAPABILITIES: readonly ObjectStoreCapability[] = [
  "versioning",
  "presigned-urls",
  "server-side-encryption",
  "public-access",
  "event-notifications",
  "lifecycle-rules",
  "multipart-upload",
];

const OUTPUT_FIELDS: readonly string[] = [
  "bucket",
  "endpoint",
  "region",
  "accessKeyRef",
  "secretKeyRef",
];

export const ObjectStoreShape: Shape<
  ObjectStoreSpec,
  ObjectStoreOutputs,
  ObjectStoreCapability
> = {
  id: "object-store",
  version: "v1",
  description:
    "Bucket-style object storage. Provider-portable across S3-class APIs.",
  capabilities: CAPABILITIES,
  outputFields: OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.name, "$.name", issues);
    optionalBoolean(value.public, "$.public", issues);
    optionalBoolean(value.versioning, "$.versioning", issues);
    optionalNonEmptyString(value.region, "$.region", issues);
    if (value.lifecycle !== undefined) {
      validateLifecycle(value.lifecycle, issues);
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.bucket, "$.bucket", issues);
    requireNonEmptyString(value.endpoint, "$.endpoint", issues);
    requireNonEmptyString(value.region, "$.region", issues);
    requireNonEmptyString(value.accessKeyRef, "$.accessKeyRef", issues);
    requireNonEmptyString(value.secretKeyRef, "$.secretKeyRef", issues);
  },
};

function validateLifecycle(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.lifecycle", message: "must be an object" });
    return;
  }
  if (
    value.expireAfterDays !== undefined &&
    !isNonNegativeInteger(value.expireAfterDays)
  ) {
    issues.push({
      path: "$.lifecycle.expireAfterDays",
      message: "must be a non-negative integer",
    });
  }
  if (
    value.archiveAfterDays !== undefined &&
    !isNonNegativeInteger(value.archiveAfterDays)
  ) {
    issues.push({
      path: "$.lifecycle.archiveAfterDays",
      message: "must be a non-negative integer",
    });
  }
}
