import type { Artifact, Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonEmptyString,
  isRecord,
  optionalNonEmptyString,
  optionalStringRecord,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";

export type WorkerCapability =
  | "scale-to-zero"
  | "websocket"
  | "long-request"
  | "geo-routing"
  | "crons";

export interface WorkerSpec {
  /** Required: artifact descriptor. `kind` must be `"js-bundle"`. */
  readonly artifact: Artifact;
  /** Cloudflare Workers compatibility date (e.g. `"2025-01-01"`). */
  readonly compatibilityDate: string;
  /** Optional: compatibility flags (e.g. `["nodejs_compat"]`). */
  readonly compatibilityFlags?: readonly string[];
  /** Optional: env vars / bindings. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional: routes / triggers. */
  readonly routes?: readonly string[];
}

export interface WorkerOutputs {
  readonly url: string;
  readonly scriptName: string;
  readonly version?: string;
}

const CAPABILITIES: readonly WorkerCapability[] = [
  "scale-to-zero",
  "websocket",
  "long-request",
  "geo-routing",
  "crons",
];

const OUTPUT_FIELDS: readonly string[] = ["url", "scriptName", "version"];

export const WorkerShape: Shape<WorkerSpec, WorkerOutputs, WorkerCapability> = {
  id: "worker",
  version: "v1",
  description:
    "Serverless JS function backed by an uploaded `js-bundle` artifact.",
  capabilities: CAPABILITIES,
  outputFields: OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    validateArtifact(value.artifact, issues);
    requireNonEmptyString(
      value.compatibilityDate,
      "$.compatibilityDate",
      issues,
    );
    validateStringArray(
      value.compatibilityFlags,
      "$.compatibilityFlags",
      issues,
    );
    optionalStringRecord(value.env, "$.env", issues);
    validateStringArray(value.routes, "$.routes", issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.url, "$.url", issues);
    requireNonEmptyString(value.scriptName, "$.scriptName", issues);
    optionalNonEmptyString(value.version, "$.version", issues);
  },
};

/**
 * `worker@v1` only accepts uploaded `js-bundle` artifacts: `kind` must be
 * exactly `"js-bundle"` and `hash` is required (no external `uri`).
 */
function validateArtifact(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.artifact", message: "must be an object" });
    return;
  }
  if (!isNonEmptyString(value.kind)) {
    issues.push({
      path: "$.artifact.kind",
      message: "must be a non-empty string",
    });
  } else if (value.kind !== "js-bundle") {
    issues.push({
      path: "$.artifact.kind",
      message: "must be `js-bundle` for worker@v1",
    });
  }
  if (!isNonEmptyString(value.hash)) {
    issues.push({
      path: "$.artifact.hash",
      message: "must be a non-empty string (js-bundle requires upload hash)",
    });
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (!value.every(isNonEmptyString)) {
    issues.push({ path, message: "must contain only non-empty strings" });
  }
}
