import type {
  OpenTofuOutputEnvelope,
  OpenTofuOutputValue,
} from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "takosumi-contract";

export interface OpenTofuOutputRecord {
  readonly sensitive?: boolean;
  readonly type?: unknown;
  readonly value: unknown;
}

export type OpenTofuOutputJson = Readonly<Record<string, OpenTofuOutputRecord>>;

/** Parse the standard `tofu output -json` envelope without interpreting names. */
export function parseOpenTofuOutputs(
  input: string | unknown,
): OpenTofuOutputJson {
  const parsed =
    typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!isRecord(parsed)) {
    throw new TypeError("OpenTofu output JSON must be an object");
  }

  const outputs: Record<string, OpenTofuOutputRecord> = {};
  for (const [name, record] of Object.entries(parsed)) {
    if (!isRecord(record) || !("value" in record)) {
      throw new TypeError(
        `OpenTofu output ${name} must be an object with a value field`,
      );
    }
    outputs[name] = {
      ...(typeof record.sensitive === "boolean"
        ? { sensitive: record.sensitive }
        : {}),
      ...(Object.hasOwn(record, "type") ? { type: record.type } : {}),
      value: record.value,
    };
  }
  return outputs;
}

export function toDeployControlOutputEnvelope(
  input: OpenTofuOutputJson,
): OpenTofuOutputEnvelope {
  const envelope: Record<string, OpenTofuOutputValue> = {};
  for (const [name, output] of Object.entries(input)) {
    envelope[name] = {
      ...(typeof output.sensitive === "boolean"
        ? { sensitive: output.sensitive }
        : {}),
      ...(Object.hasOwn(output, "type")
        ? { type: asJsonValue(output.type, name) }
        : {}),
      value: asJsonValue(output.value, name),
    };
  }
  return envelope;
}

function asJsonValue(value: unknown, outputName: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`OpenTofu output ${outputName} is not JSON-safe`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => asJsonValue(item, outputName));
  }
  if (isRecord(value)) {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      object[key] = asJsonValue(item, outputName);
    }
    return object;
  }
  throw new TypeError(`OpenTofu output ${outputName} is not JSON-safe`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
